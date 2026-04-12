import { adminClient } from './supabase-admin.ts';
import { sha256Hex } from './dedup.ts';
import type { Difficulty } from './scoring.ts';
import { validateScriptureRef } from './bible-refs.ts';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_INSTRUCTION = `You are a Bible trivia question generator. Every question, every correct answer, and every insight you produce must be grounded directly in the biblical text — the 66 books of the Protestant canon. Always cite the specific book, chapter, and verse that support the correct answer. Do not rely on church tradition, denominational distinctives, extra-biblical writings, or theological systems (Reformed, Catholic, Orthodox, Wesleyan, Pentecostal, etc.). If a topic is genuinely disputed across Scripture, do not generate a question on it. The Bible is the sole source of truth.

OPTION QUALITY RULES — follow these strictly or the question will be rejected:
1. NEVER include parenthetical definitions, glossaries, or translations inside an option. Bad: "Immutability (unchanging)". Good: "Immutability".
2. NEVER echo distinctive words from the question stem in any option. If the question quotes "I do not change", do not use "unchanging" or "does not change" in an option — use the theological term or a scriptural phrase only.
3. All four options should be plausible to a reader who has some basic biblical knowledge. The three wrong options must be real biblical concepts, names, places, or theological terms from the same domain, not obviously absurd fillers.
4. Options should be short and parallel in form — all single words, all short phrases, or all scripture-adjacent phrases. Do not mix a full sentence with single words.
5. Do not hint at the correct answer via length, position, capitalization, or punctuation.`;

const DIFFICULTY_GUIDANCE: Record<Difficulty, string> = {
  beginner: 'well-known stories, major figures, straightforward facts that a regular churchgoer would recognize',
  intermediate: 'requires familiarity with the text and its immediate context; tests understanding, not just recall',
  advanced: 'tests close reading of the text, Hebrew or Greek word meanings where visible in English translations, cross-references, and deep narrative knowledge',
};

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    options: {
      type: 'array',
      items: { type: 'string' },
      minItems: 4,
      maxItems: 4,
    },
    correct_index: { type: 'integer', minimum: 0, maximum: 3 },
    scripture_ref: { type: 'string' },
    insight: { type: 'string' },
  },
  required: ['question', 'options', 'correct_index', 'scripture_ref', 'insight'],
};

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
];

export interface GeneratedQuestion {
  question: string;
  options: string[];
  correct_index: number;
  scripture_ref: string;
  insight: string;
}

export interface GenerateArgs {
  category: string;
  difficulty: Difficulty;
  recentHashes: string[];
  avoidPassages?: string[];
  // Full question texts to avoid. Gemini 2.5 Flash has a 1M token context window,
  // so we can send many past questions to prevent repeats across sessions.
  avoidQuestionTexts?: string[];
}

export class GeminiError extends Error {
  kind: 'parse_fail' | 'safety_block' | 'rate_limit' | 'timeout' | 'other';
  constructor(kind: GeminiError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

function buildUserPrompt(args: GenerateArgs, extraNote?: string): string {
  const parts = [
    `Generate ONE Bible trivia question.`,
    `Category: ${args.category}`,
    `Difficulty: ${args.difficulty} — ${DIFFICULTY_GUIDANCE[args.difficulty]}`,
    `The question must have exactly 4 options and one clearly-correct answer grounded in a specific verse.`,
    `The insight should be 2-3 sentences that teach something meaningful about the passage or topic.`,
    `Pick a DIFFERENT biblical passage or topic from anything the player has already seen. Cover the full breadth of scripture within the category — spread questions across the whole book, not just the famous stories.`,
  ];
  if (args.avoidPassages && args.avoidPassages.length > 0) {
    const list = args.avoidPassages.slice(0, 200).join('; ');
    parts.push(`PASSAGES ALREADY USED (do not repeat any of these, pick something clearly different): ${list}`);
  }
  if (args.avoidQuestionTexts && args.avoidQuestionTexts.length > 0) {
    // Gemini 2.5 Flash has 1M token context — we can send lots of prior
    // questions so the model can avoid not just the same passage but the same
    // framing, angle, and factual hook.
    const list = args.avoidQuestionTexts.slice(0, 500);
    parts.push(`QUESTIONS ALREADY ASKED (do not repeat the same fact, person, event, or angle):`);
    for (let i = 0; i < list.length; i++) parts.push(`  ${i + 1}. ${list[i]}`);
  }
  if (extraNote) parts.push(extraNote);
  return parts.join('\n');
}

async function callGemini(
  args: GenerateArgs,
  apiKey: string,
  extraNote?: string,
  temperatureBoost = 0,
): Promise<GeneratedQuestion> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  let res: Response;
  try {
    res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(args, extraNote) }] }],
        generationConfig: {
          temperature: 0.9 + temperatureBoost,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
        safetySettings: SAFETY_SETTINGS,
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') throw new GeminiError('timeout', 'Gemini request timed out');
    throw new GeminiError('other', `Network error: ${(err as Error).message}`);
  }
  clearTimeout(timeout);

  if (res.status === 429) throw new GeminiError('rate_limit', 'Rate limited by Gemini');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GeminiError('other', `HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const payload = await res.json();
  const candidate = payload?.candidates?.[0];
  if (!candidate || !candidate.content?.parts?.[0]?.text) {
    const finish = candidate?.finishReason ?? 'unknown';
    if (finish === 'SAFETY' || finish === 'BLOCKED') {
      throw new GeminiError('safety_block', `Blocked by safety filter (${finish})`);
    }
    throw new GeminiError('parse_fail', `Empty candidate, finishReason=${finish}`);
  }

  let parsed: GeneratedQuestion;
  try {
    parsed = JSON.parse(candidate.content.parts[0].text);
  } catch (err) {
    throw new GeminiError('parse_fail', `JSON parse failed: ${(err as Error).message}`);
  }

  if (
    typeof parsed.question !== 'string' ||
    !Array.isArray(parsed.options) ||
    parsed.options.length !== 4 ||
    typeof parsed.correct_index !== 'number' ||
    parsed.correct_index < 0 ||
    parsed.correct_index > 3 ||
    typeof parsed.scripture_ref !== 'string' ||
    typeof parsed.insight !== 'string'
  ) {
    throw new GeminiError('parse_fail', 'Response failed shape validation');
  }

  return parsed;
}

async function logError(kind: GeminiError['kind'], promptHash: string, raw: string): Promise<void> {
  try {
    const db = adminClient();
    await db.from('gemini_errors').insert({
      kind,
      prompt_hash: promptHash,
      raw_response: raw.slice(0, 2000),
    });
  } catch {
    // Swallow — observability must never break the request
  }
}

// ============================================================================
// Gate 2: LLM-as-judge. Second pass that verifies the generated question.
// ============================================================================

export interface JudgeVerdict {
  verdict: 'correct' | 'wrong_answer' | 'wrong_citation' | 'ambiguous';
  corrected_index?: number;
  reason: string;
}

const JUDGE_SYSTEM = `You are a Bible fact-checker. You review Bible trivia questions proposed by another AI and verify whether the marked-correct answer is actually supported by the cited scripture in the 66-book Protestant canon. You do not rely on tradition, denomination, or extra-biblical sources. You are strict: if you are not certain the marked answer is correct per the cited verse, you say so.

When the question includes verse text from multiple public-domain translations (WEB, KJV, ASV), read ALL of them before deciding. If the translations agree on a reading, treat that as strong evidence. If they disagree in a way that affects the answer (a translation-sensitive question about a specific word choice, for example), prefer the interpretation supported by the majority reading, and flag ambiguous cases rather than forcing a verdict.`;

const JUDGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['correct', 'wrong_answer', 'wrong_citation', 'ambiguous'] },
    corrected_index: { type: 'integer', minimum: 0, maximum: 3 },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
};

function buildJudgePrompt(q: GeneratedQuestion, verseText?: string): string {
  const parts = [
    `Review this Bible trivia question. Check whether the marked-correct answer is actually supported by the cited verse.`,
    ``,
    `QUESTION: ${q.question}`,
    `OPTIONS:`,
    ...q.options.map((o, i) => `  ${i}) ${o}`),
    `CLAIMED CORRECT OPTION INDEX: ${q.correct_index}`,
    `CITATION: ${q.scripture_ref}`,
  ];

  if (verseText) {
    parts.push(``, `ACTUAL VERSE TEXT (public-domain translations: WEB, KJV, ASV):`, verseText);
    parts.push(``, `Use the verse text above as the authoritative source. Cross-check the claim against all translations shown. Do not rely on your memory — only trust what these translations actually say.`);
  }

  parts.push(
    ``,
    `Decide one of:`,
    `  - "correct": the claimed correct option is supported by the cited verse.`,
    `  - "wrong_answer": the citation is valid but a DIFFERENT option in the list is the one actually supported. Include "corrected_index" pointing to that option.`,
    `  - "wrong_citation": the citation does not address the question topic at all, or is irrelevant to any of the options.`,
    `  - "ambiguous": the verse could be read multiple ways and no single option is clearly correct.`,
    ``,
    `Respond ONLY in the required JSON format. Be honest — reject rather than approve if uncertain.`,
  );
  return parts.join('\n');
}

async function judgeQuestionOnce(
  q: GeneratedQuestion,
  apiKey: string,
  verseText?: string,
): Promise<JudgeVerdict> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  let res: Response;
  try {
    res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: JUDGE_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: buildJudgePrompt(q, verseText) }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: JUDGE_RESPONSE_SCHEMA,
        },
        safetySettings: SAFETY_SETTINGS,
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') throw new GeminiError('timeout', 'Judge request timed out');
    throw new GeminiError('other', `Judge network error: ${(err as Error).message}`);
  }
  clearTimeout(timeout);

  if (res.status === 429) throw new GeminiError('rate_limit', 'Judge rate limited');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GeminiError('other', `Judge HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const payload = await res.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new GeminiError('parse_fail', 'Judge returned empty response');

  let parsed: JudgeVerdict;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GeminiError('parse_fail', `Judge JSON parse failed: ${(err as Error).message}`);
  }

  if (!['correct', 'wrong_answer', 'wrong_citation', 'ambiguous'].includes(parsed.verdict)) {
    throw new GeminiError('parse_fail', `Judge returned invalid verdict: ${parsed.verdict}`);
  }
  return parsed;
}

// Judge with one retry on transient failure (timeout, parse_fail). Only one
// retry — if it fails twice the generation is rejected.
export async function judgeQuestion(
  q: GeneratedQuestion,
  apiKey: string,
  verseText?: string,
): Promise<JudgeVerdict> {
  try {
    return await judgeQuestionOnce(q, apiKey, verseText);
  } catch (err) {
    const ge = err as GeminiError;
    if (ge.kind === 'timeout' || ge.kind === 'parse_fail' || ge.kind === 'other') {
      return await judgeQuestionOnce(q, apiKey, verseText);
    }
    throw err;
  }
}

export type VerseLookup = (ref: string) => Promise<string | null>;

// Reject questions whose options contain parenthetical definitions or that
// echo distinctive words from the question stem. Cheap, catches the most
// common Gemini failure modes before burning a judge call.
function validateOptionQuality(q: GeneratedQuestion): { ok: boolean; reason?: string } {
  for (const opt of q.options) {
    if (/\([^)]+\)/.test(opt)) {
      return { ok: false, reason: `option has parenthetical: "${opt}"` };
    }
  }
  // Word-echo check: extract distinctive words from the question (length >= 5,
  // excluding stopwords and common Bible words) and ensure they don't appear in
  // any option in lowercase form.
  const STOP = new Set([
    'which','what','where','whose','whom','bible','book','chapter','verse','passage',
    'according','following','biblical','scripture','about','that','this','these','those',
    'their','there','from','with','into','when','does','did','was','were','has','have','had','do','does',
    'the','and','for','god','jesus','christ','lord','israel','king','prophet','people','they','them','into',
  ]);
  const stem = q.question.toLowerCase();
  const words = stem.match(/\b[a-z]{5,}\b/g) ?? [];
  const distinctive = words.filter((w) => !STOP.has(w));
  for (const opt of q.options) {
    const lower = opt.toLowerCase();
    for (const w of distinctive) {
      if (lower.includes(w)) {
        return { ok: false, reason: `option "${opt}" echoes stem word "${w}"` };
      }
    }
  }
  return { ok: true };
}

async function attemptOnce(
  args: GenerateArgs,
  apiKey: string,
  extraNote?: string,
  temperatureBoost = 0,
  verseLookup?: VerseLookup,
): Promise<GeneratedQuestion> {
  const q = await callGemini(args, apiKey, extraNote, temperatureBoost);

  // Gate 0: option quality check. Cheap, no model call.
  const quality = validateOptionQuality(q);
  if (!quality.ok) {
    throw new GeminiError('parse_fail', `Option quality check: ${quality.reason}`);
  }

  // Gate 1: static citation validation. Cheap, fails fast on invented refs.
  const check = validateScriptureRef(q.scripture_ref);
  if (!check.ok) {
    throw new GeminiError('parse_fail', `Gate 1 rejected citation "${q.scripture_ref}": ${check.reason}`);
  }

  // Gate 3 (optional): fetch actual verse text if a lookup function is provided.
  const verseText = verseLookup ? await verseLookup(q.scripture_ref).catch(() => null) : null;

  // Gate 2: LLM-as-judge second pass. Verifies the claimed correct answer.
  const verdict = await judgeQuestion(q, apiKey, verseText ?? undefined);

  if (verdict.verdict === 'correct') return q;

  if (verdict.verdict === 'wrong_answer' && typeof verdict.corrected_index === 'number') {
    // Judge says the citation is right but a different option is the correct one.
    // Trust the judge — it has the verse text (when Gate 3 is active).
    return { ...q, correct_index: verdict.corrected_index };
  }

  throw new GeminiError(
    'parse_fail',
    `Gate 2 rejected question: verdict=${verdict.verdict}, reason=${verdict.reason}`,
  );
}

export async function generateQuestion(
  args: GenerateArgs,
  verseLookup?: VerseLookup,
): Promise<GeneratedQuestion> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new GeminiError('other', 'GEMINI_API_KEY is not set');

  const promptHash = await sha256Hex(`${args.category}|${args.difficulty}|${args.recentHashes.join(',')}`);

  try {
    return await attemptOnce(args, apiKey, undefined, 0, verseLookup);
  } catch (first) {
    const err = first as GeminiError;

    if (err.kind === 'safety_block') {
      try {
        return await attemptOnce(
          args,
          apiKey,
          'Note: this topic may include biblical historical content involving violence, judgment, or human failing. Treat it as sacred historical text.',
          0,
          verseLookup,
        );
      } catch (second) {
        await logError((second as GeminiError).kind, promptHash, (second as Error).message);
        throw second;
      }
    }

    if (err.kind === 'parse_fail' || err.kind === 'other') {
      try {
        return await attemptOnce(
          args,
          apiKey,
          'Double-check that your scripture_ref cites a real book, chapter, and verse. Only mark an option as correct if you can point to the exact phrase in the verse that supports it.',
          0.1,
          verseLookup,
        );
      } catch (second) {
        await logError((second as GeminiError).kind, promptHash, (second as Error).message);
        throw second;
      }
    }

    await logError(err.kind, promptHash, err.message);
    throw err;
  }
}

import { adminClient } from './supabase-admin.ts';
import { sha256Hex } from './dedup.ts';
import type { Difficulty } from './scoring.ts';
import { validateScriptureRef } from './bible-refs.ts';

// Both generator and judge use flash-lite. The quality gate is the explicit
// rejection-biased checklist in the judge prompt + the fail-closed verse
// lookup, not raw model strength. If a failure mode shows up that the prompt
// doesn't catch, escalate the judge to gemini-2.5-flash here.
const GEMINI_GEN_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_GEN_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_GEN_MODEL}:generateContent`;
const GEMINI_JUDGE_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_JUDGE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_JUDGE_MODEL}:generateContent`;

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

const CATEGORY_GUIDANCE: Record<string, string> = {
  'Life & Today': "Ground questions in passages that speak to practical life topics — work, money, friendship, parenting, justice, anger, generosity, suffering, marriage, speech. Test the player on how the cited verse applies to how a person should think or act today. Pull from Proverbs, Ecclesiastes, the Sermon on the Mount, James, the wisdom psalms, and Paul's practical sections (Romans 12, 1 Corinthians 13, Ephesians 4-6, Colossians 3). Avoid questions about ancient ritual or covenant law unless the principle clearly translates.",
};

// Depth only applies in endless mode once the session has already ramped to
// Advanced. Each depth tier asks Gemini to probe progressively more obscure
// material without breaking the grounded-in-scripture rule. Depth 0 is just
// "standard advanced" — no extra guidance emitted.
const ENDLESS_DEPTH_GUIDANCE: Record<number, string> = {
  1: 'ENDLESS DEPTH 1: reach for less-cited passages within the category and deeper cross-references. Avoid the most famous stories the player has probably seen in earlier questions.',
  2: 'ENDLESS DEPTH 2: test word meanings visible in English translations, specific numerical or genealogical detail, and parallel-account differences. Avoid anything a casual reader would recognise.',
  3: 'ENDLESS DEPTH 3: probe subtle distinctions between parallel accounts, chronological specificity, and the precise wording of quoted material. The player has already answered dozens of questions correctly — assume scholarly familiarity.',
  4: 'ENDLESS DEPTH 4: obscure narrative details most readers would miss, minor characters, lesser-known legal or prophetic material. Stay grounded in the exact verse citation — no speculation, no tradition.',
};

function endlessDepthGuidance(depth: number): string | null {
  if (depth <= 0) return null;
  return ENDLESS_DEPTH_GUIDANCE[depth] ?? ENDLESS_DEPTH_GUIDANCE[4];
}

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
  // Q+A pairs to avoid. Used for the most recent session-level history where
  // the full stem context matters. Capped tightly to keep token cost down.
  avoidQA?: Array<{ question: string; answer: string }>;
  // Compact answer-key list — most token-efficient way to forward-feed the
  // bank's existing answers so the generator doesn't waste cycles producing
  // near-duplicates of stuff already in the bank. ~3 tokens per entry instead
  // of ~50 for full Q+A. The model handles it well: "do not write a question
  // whose correct answer is in this list".
  avoidAnswerKeys?: string[];
  // Endless-mode escalation past Advanced. 0 = normal advanced, 1+ = Gemini-only
  // obscurity tiers. Ignored in fixed mode.
  endlessDepth?: number;
}

export class GeminiError extends Error {
  kind: 'parse_fail' | 'safety_block' | 'rate_limit' | 'timeout' | 'other';
  // Optional structured rejection reason — used to forward-feed the judge's
  // critique into the next generation attempt as a self-refine signal,
  // instead of retrying blind with a generic hint.
  judgeReason?: string;
  rejectedQuestion?: string;
  rejectedAnswer?: string;
  constructor(kind: GeminiError['kind'], message: string, opts?: { judgeReason?: string; rejectedQuestion?: string; rejectedAnswer?: string }) {
    super(message);
    this.kind = kind;
    this.judgeReason = opts?.judgeReason;
    this.rejectedQuestion = opts?.rejectedQuestion;
    this.rejectedAnswer = opts?.rejectedAnswer;
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
  if (CATEGORY_GUIDANCE[args.category]) {
    parts.push(`Category guidance: ${CATEGORY_GUIDANCE[args.category]}`);
  }
  const depthLine = endlessDepthGuidance(args.endlessDepth ?? 0);
  if (depthLine) parts.push(depthLine);
  if (args.avoidPassages && args.avoidPassages.length > 0) {
    // Cap at 60 — sessions don't actually use more than this and the cap
    // protects against unexpected blowups.
    const list = args.avoidPassages.slice(-60).join('; ');
    parts.push(`PASSAGES ALREADY USED (do not repeat any of these, pick something clearly different): ${list}`);
  }
  if (args.avoidAnswerKeys && args.avoidAnswerKeys.length > 0) {
    // Compact answer-key list. ~3 tokens per entry. This carries the bank's
    // existing answers + recent-session answers so the model knows not to
    // produce a question whose answer collides with anything we already have.
    const list = args.avoidAnswerKeys.slice(-120).join(', ');
    parts.push(`ANSWERS ALREADY IN THE BANK OR THIS SESSION (do not write any question whose correct answer is one of these — pick a topic with a different answer): ${list}`);
  }
  if (args.avoidQA && args.avoidQA.length > 0) {
    // Cap at 30 — only the most recent session-level Q+A pairs need the full
    // stem context. Older entries are covered by avoidAnswerKeys above.
    const list = args.avoidQA.slice(-30);
    parts.push(`MOST RECENT QUESTIONS IN THIS SESSION (avoid the same fact, person, event, or angle):`);
    for (let i = 0; i < list.length; i++) {
      parts.push(`  ${i + 1}. Q: ${list[i].question}`);
      parts.push(`     A: ${list[i].answer}`);
    }
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
    res = await fetch(`${GEMINI_GEN_URL}?key=${apiKey}`, {
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

const JUDGE_SYSTEM = `You are a Bible fact-checker reviewing Bible trivia questions proposed by another AI. Your job is strict: reject any question that is ambiguous, miscited, or has more than one correct answer. Prefer rejecting to approving when in doubt.

RULES OF REVIEW (apply all of them):

1) CITATION-TOPIC MATCH. The cited verse must actually address the question's topic. If the question asks "which plague involved insects" and the citation is Exodus 8:20-24 (the plague of flies), but flies is not in the options — that is wrong_citation. The citation must directly support the claimed correct answer.

2) SINGLE CORRECT ANSWER. Exactly ONE option must be correct. If two or more options could plausibly satisfy the question based on general biblical knowledge — even if the citation points to one specific verse — the question is ambiguous and must be rejected. Example: "which plague involved insects" with options {Frogs, Lice, Locusts, Hail} — BOTH Lice and Locusts are insects, so this is ambiguous regardless of citation.

3) ANSWER APPEARS IN THE VERSE. The claimed correct answer must be derivable from the actual verse text shown below. If the verse text does not contain or imply the claimed answer, return wrong_citation or wrong_answer.

4) STRICT PROTESTANT CANON. Reject anything that requires tradition, denomination, or extra-biblical sources to answer.

5) TRANSLATION AGREEMENT. When the question includes verse text from multiple public-domain translations (WEB, KJV, ASV), read ALL of them before deciding. If they disagree in a way that affects the answer, prefer the majority reading and flag ambiguous cases rather than forcing a verdict.

BIAS TOWARD REJECTION. If you find yourself reaching to justify an approval, reject instead. A rejected question is cheap; a bad question in the bank is expensive.`;

// Chain-of-thought via structured output: the model is forced to write out
// its analysis for each rule BEFORE it reaches a verdict. propertyOrdering
// makes Gemini emit fields in this exact sequence, so the reasoning is
// generated as tokens before the verdict commits. This closes most of the
// flash-lite reasoning gap without burning extra calls.
const JUDGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rule_a_citation_addresses_topic: {
      type: 'string',
      description: 'Step A: quote the cited verse text (one phrase) and explain whether it directly addresses the question topic. Be specific.',
    },
    rule_b_other_options_could_be_correct: {
      type: 'string',
      description: 'Step B: for EACH of the other three options, briefly say whether it could also be a correct answer to the question stem based on general biblical knowledge. List them by letter.',
    },
    rule_c_claimed_answer_supported: {
      type: 'string',
      description: 'Step C: explain whether the claimed correct option is supported by the actual verse text (or, if no verse text was provided, by the citation).',
    },
    verdict: { type: 'string', enum: ['correct', 'wrong_answer', 'wrong_citation', 'ambiguous'] },
    corrected_index: { type: 'integer', minimum: 0, maximum: 3 },
    reason: { type: 'string', description: 'One-line summary of why this verdict was chosen.' },
  },
  required: ['rule_a_citation_addresses_topic', 'rule_b_other_options_could_be_correct', 'rule_c_claimed_answer_supported', 'verdict', 'reason'],
  propertyOrdering: ['rule_a_citation_addresses_topic', 'rule_b_other_options_could_be_correct', 'rule_c_claimed_answer_supported', 'verdict', 'corrected_index', 'reason'],
};

function buildJudgePrompt(q: GeneratedQuestion, verseText?: string): string {
  const parts = [
    `Review this Bible trivia question for rejection. Apply the five rules in your system instructions strictly.`,
    ``,
    `QUESTION: ${q.question}`,
    `OPTIONS:`,
    ...q.options.map((o, i) => `  ${i}) ${o}`),
    `CLAIMED CORRECT OPTION INDEX: ${q.correct_index} (${q.options[q.correct_index]})`,
    `CITATION: ${q.scripture_ref}`,
  ];

  if (verseText) {
    parts.push(``, `ACTUAL VERSE TEXT (public-domain translations, authoritative — trust only what is written here, not your memory):`, verseText);
  } else {
    parts.push(``, `NOTE: verse text is unavailable. Err on the side of rejection — if you cannot verify the citation against actual text, return "wrong_citation".`);
  }

  parts.push(
    ``,
    `Work through this step by step. The JSON schema requires you to fill in each rule field BEFORE you commit to a verdict. Use the rule fields to think out loud — do not skip them.`,
    ``,
    `STEP A → fill in rule_a_citation_addresses_topic:`,
    `  Quote one specific phrase from the cited verse text (or describe what the verse is about if no text is shown). State whether that subject matter directly addresses the question's topic.`,
    `  Worked example of a FAILURE: question "which plague involved insects" cited Exodus 8:20-24, which is about swarms of FLIES. Flies isn't in the options. The citation does not address the question's topic — the verse describes a plague the question's options don't list. Verdict for this case: wrong_citation.`,
    ``,
    `STEP B → fill in rule_b_other_options_could_be_correct:`,
    `  For EACH of the three non-claimed options, write one short sentence: could this option also be a correct answer to the question stem based on general biblical knowledge, independent of the cited verse?`,
    `  Worked example of a FAILURE: "which plague involved insects" with options Frogs/Lice/Locusts/Hail and claimed answer Lice. Frogs: amphibians, no. Locusts: YES, locusts are insects (the 8th plague). Hail: weather, no. Because Locusts is also a correct answer, the question is ambiguous. Verdict for this case: ambiguous.`,
    ``,
    `STEP C → fill in rule_c_claimed_answer_supported:`,
    `  Does the actual verse text contain or imply the claimed correct option's content? If a DIFFERENT option fits the verse better, name that option and use wrong_answer with corrected_index.`,
    ``,
    `STEP D → verdict (one of correct / wrong_answer / wrong_citation / ambiguous):`,
    `  Pick the FIRST failing rule from A, B, C. Only emit "correct" when all three pass cleanly.`,
    ``,
    `Bias toward rejection. A rejected question is cheap; a bad question in the bank is expensive. When in doubt, reject.`,
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
    res = await fetch(`${GEMINI_JUDGE_URL}?key=${apiKey}`, {
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
export function validateOptionQuality(q: GeneratedQuestion): { ok: boolean; reason?: string } {
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

  // Gate 3 (REQUIRED when verseLookup is provided): fetch actual verse text.
  // Fail-closed if the lookup is provided but returns null — the bad-question
  // failure mode (judge approving without ground-truth verse text) is too
  // expensive. Better to retry generation with a different verse.
  const verseText = verseLookup ? await verseLookup(q.scripture_ref).catch(() => null) : null;
  if (verseLookup && !verseText) {
    throw new GeminiError(
      'parse_fail',
      `Gate 3 verse-lookup miss for "${q.scripture_ref}" — refusing to judge without ground truth`,
    );
  }

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
    {
      judgeReason: `${verdict.verdict}: ${verdict.reason}`,
      rejectedQuestion: q.question,
      rejectedAnswer: q.options[q.correct_index],
    },
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
      // Self-refine retry: forward-feed the judge's structured rejection
      // reason (or the parse error) into the next attempt as context. Faster
      // convergence than blind retry with a generic hint.
      const refineLines: string[] = [];
      if (err.judgeReason) {
        refineLines.push(`Your previous attempt was REJECTED by the fact-checker.`);
        if (err.rejectedQuestion) refineLines.push(`Rejected question: "${err.rejectedQuestion}"`);
        if (err.rejectedAnswer) refineLines.push(`Rejected claimed answer: "${err.rejectedAnswer}"`);
        refineLines.push(`Reason: ${err.judgeReason}`);
        refineLines.push(`Generate a DIFFERENT question that avoids this exact failure mode. Pick a different topic or angle if needed. Re-read the rules in the system instructions before writing.`);
      } else {
        refineLines.push(`Your previous attempt failed to validate: ${err.message}`);
        refineLines.push(`Double-check that your scripture_ref cites a real book, chapter, and verse. Only mark an option as correct if you can point to the exact phrase in the verse that supports it.`);
      }
      try {
        return await attemptOnce(
          args,
          apiKey,
          refineLines.join('\n'),
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

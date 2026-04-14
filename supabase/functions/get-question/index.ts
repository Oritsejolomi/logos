import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { sanitizeRecentHashes, sha256Hex } from '../_shared/dedup.ts';
import { generateQuestion, GeminiError } from '../_shared/gemini.ts';
import { verseLookup } from '../_shared/bible-lookup.ts';
import type { Difficulty, Pace } from '../_shared/scoring.ts';
import { TIMER_SECONDS } from '../_shared/scoring.ts';
import { rampingStateAt } from '../_shared/ramping.ts';

interface QuestionRow {
  id: string;
  question_text: string;
  options: string[];
  scripture_ref: string;
  correct_index: number;
  insight: string;
  content_hash_16?: string;
  category?: string;
  difficulty?: string;
}

const CONCRETE_CATEGORIES = [
  'Old Testament',
  'New Testament',
  'Prophets',
  'Psalms & Wisdom',
  'Parables',
  "Paul's Letters",
  'Theology',
  'Church History',
  'Life & Today',
];

function pickRandomConcreteCategory(): string {
  return CONCRETE_CATEGORIES[Math.floor(Math.random() * CONCRETE_CATEGORIES.length)];
}

function passageKey(ref: string): string {
  return ref.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:\-–,].*$/, '').trim();
}

function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchFromBank(
  category: string,
  difficulty: Difficulty,
  excludeHashes16: string[],
  excludeIds: string[],
  excludePassageKeys: string[],
  excludeAnswerKeys: string[],
): Promise<QuestionRow | null> {
  const db = adminClient();
  let query = db
    .from('questions')
    .select('id, question_text, options, scripture_ref, correct_index, insight, content_hash_16, category, difficulty')
    .eq('category', category)
    .eq('difficulty', difficulty)
    .is('deleted_at', null)
    .order('quality_score', { ascending: false })
    .limit(300);
  if (excludeIds.length > 0) query = query.not('id', 'in', `(${excludeIds.map((id) => `"${id}"`).join(',')})`);
  const { data, error } = await query;
  if (error || !data) return null;
  const excludeHashSet = new Set(excludeHashes16);
  const excludePassageSet = new Set(excludePassageKeys);
  const excludeAnswerSet = new Set(excludeAnswerKeys);
  let hashHits = 0;
  let answerHits = 0;
  const fresh = data.filter((row) => {
    if (excludePassageSet.has(passageKey(row.scripture_ref))) return false;
    if (row.content_hash_16 && excludeHashSet.has(row.content_hash_16)) {
      hashHits++;
      return false;
    }
    if (Array.isArray(row.options) && typeof row.correct_index === 'number') {
      const ans = normalizeAnswer(row.options[row.correct_index] ?? '');
      if (ans && excludeAnswerSet.has(ans)) {
        answerHits++;
        return false;
      }
    }
    return true;
  });
  console.log(`[fetchFromBank] cat=${category} diff=${difficulty} hashes_in=${excludeHashes16.length} answers_in=${excludeAnswerKeys.length} candidates=${data.length} hash_hits=${hashHits} answer_hits=${answerHits} eligible=${fresh.length}`);
  if (fresh.length === 0) return null;
  const pick = fresh[Math.floor(Math.random() * Math.min(fresh.length, 10))];
  return pick as unknown as QuestionRow;
}

async function fetchBankAnswerKeys(
  category: string,
  difficulty: Difficulty,
): Promise<string[]> {
  const db = adminClient();
  const { data } = await db
    .from('questions')
    .select('options, correct_index')
    .eq('category', category)
    .eq('difficulty', difficulty)
    .is('deleted_at', null)
    .order('quality_score', { ascending: false })
    .limit(80);
  if (!data) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of data) {
    if (!Array.isArray(r.options) || typeof r.correct_index !== 'number') continue;
    const ans = normalizeAnswer(r.options[r.correct_index] ?? '');
    if (!ans || seen.has(ans)) continue;
    seen.add(ans);
    out.push(ans);
  }
  return out;
}

async function generateAndStore(
  category: string,
  difficulty: Difficulty,
  recentHashes: string[],
  avoidPassages: string[],
  avoidQA: Array<{ question: string; answer: string }>,
  avoidAnswerKeys: string[],
  endlessDepth: number,
): Promise<QuestionRow> {
  const db = adminClient();
  const generated = await generateQuestion(
    { category, difficulty, recentHashes, avoidPassages, avoidQA, avoidAnswerKeys, endlessDepth },
    verseLookup,
  );
  const content_hash = await sha256Hex(generated.question);

  const { data, error } = await db
    .from('questions')
    .insert({
      category,
      difficulty,
      question_text: generated.question,
      options: generated.options,
      correct_index: generated.correct_index,
      scripture_ref: generated.scripture_ref,
      insight: generated.insight,
      content_hash,
    })
    .select('id, question_text, options, scripture_ref, correct_index, insight, content_hash_16, category')
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await db
        .from('questions')
        .select('id, question_text, options, scripture_ref, correct_index, insight, content_hash_16, category')
        .eq('content_hash', content_hash)
        .single();
      if (existing) return existing as unknown as QuestionRow;
    }
    throw new Error(`Failed to store question: ${error.message}`);
  }

  return data as unknown as QuestionRow;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { session_id, player_uuid, recent_hashes } = body as {
    session_id?: string;
    player_uuid?: string;
    recent_hashes?: unknown;
  };

  if (!session_id || !player_uuid) return errorResponse(400, 'session_id and player_uuid required');

  const cleanedHashes = sanitizeRecentHashes(recent_hashes);
  const db = adminClient();

  const { data: session, error: sessionErr } = await db
    .from('solo_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('player_uuid', player_uuid)
    .single();

  if (sessionErr || !session) return errorResponse(404, 'Session not found');
  if (session.status !== 'active') return errorResponse(409, `Session is ${session.status}`);
  const isEndless = session.session_mode === 'endless';
  if (!isEndless && session.current_q_index >= session.question_count) {
    return errorResponse(409, 'All questions answered');
  }

  // Ramped difficulty + endless depth for this slot. Fixed mode always uses
  // the picked difficulty and depth 0.
  const ramp = isEndless
    ? rampingStateAt(session.difficulty as Difficulty, session.current_q_index)
    : { difficulty: session.difficulty as Difficulty, endlessDepth: 0 };

  // Idempotent re-fetch: if a question is already open, return it.
  if (session.current_question_id) {
    const { data: q } = await db
      .from('questions')
      .select('id, question_text, options, scripture_ref, content_hash_16, category, difficulty')
      .eq('id', session.current_question_id)
      .single();
    if (q) {
      const qDifficulty = (q.difficulty as Difficulty) ?? ramp.difficulty;
      const timerSeconds = TIMER_SECONDS[session.pace as Pace][qDifficulty];
      return jsonResponse({
        question_id: q.id,
        content_hash_16: q.content_hash_16,
        question_text: q.question_text,
        options: q.options,
        scripture_ref: q.scripture_ref,
        category: q.category,
        difficulty: qDifficulty,
        endless_depth: ramp.endlessDepth,
        lives_remaining: session.lives_remaining,
        question_index: session.current_q_index,
        opened_at: session.current_q_opened_at,
        timer_seconds: timerSeconds,
      });
    }
  }

  // Try the pre-generated queue first. If queued_question_ids[current_q_index]
  // points to a still-live question that hasn't been served, use it — zero
  // Gemini calls, instant response.
  const queuedIds: string[] = session.queued_question_ids ?? [];
  const servedIds: string[] = session.served_question_ids ?? [];

  let questionRow: QuestionRow | null = null;
  const queuedId = queuedIds[session.current_q_index];
  if (queuedId && !servedIds.includes(queuedId)) {
    const { data: q } = await db
      .from('questions')
      .select('id, question_text, options, scripture_ref, correct_index, insight, content_hash_16, category, difficulty')
      .eq('id', queuedId)
      .is('deleted_at', null)
      .single();
    if (q) questionRow = q as unknown as QuestionRow;
  }

  // Fallback path: bank lookup, then Gemini.
  if (!questionRow) {
    // Also include questions already queued for this session so the bank
    // lookup and answer-key dedup span the whole queue, not just served.
    const queuedAndServed = new Set<string>([...queuedIds, ...servedIds]);
    let servedPassages: string[] = [];
    const servedQA: Array<{ question: string; answer: string }> = [];
    const servedAnswerKeys: string[] = [];
    if (queuedAndServed.size > 0) {
      const { data: servedRows } = await db
        .from('questions')
        .select('scripture_ref, question_text, options, correct_index')
        .in('id', [...queuedAndServed]);
      servedPassages = (servedRows ?? []).map((r) => r.scripture_ref).filter((s): s is string => !!s);
      for (const r of servedRows ?? []) {
        if (r.question_text && Array.isArray(r.options) && typeof r.correct_index === 'number') {
          const answer = r.options[r.correct_index] ?? '';
          servedQA.push({ question: r.question_text, answer });
          const ans = normalizeAnswer(answer);
          if (ans) servedAnswerKeys.push(ans);
        }
      }
    }
    const servedPassageKeys = servedPassages.map(passageKey);

    const fallbackCategory = session.category === 'Random' ? pickRandomConcreteCategory() : session.category;
    // Use ramped difficulty for endless sessions. Fixed sessions use the pick.
    const fallbackDifficulty = ramp.difficulty;

    // Both modes fall back through bank → Gemini. The bank lookup honors
    // cleanedHashes AND answer-key dedup, so already-seen and same-answer
    // questions are excluded. Depth > 0 still skips the bank because stored
    // questions have no depth column.
    if (ramp.endlessDepth === 0) {
      questionRow = await fetchFromBank(
        fallbackCategory,
        fallbackDifficulty,
        cleanedHashes,
        [...queuedAndServed],
        servedPassageKeys,
        servedAnswerKeys,
      );
    }
    if (!questionRow) {
      try {
        // Forward-feed the bank's answer keys for this category+difficulty so
        // the generator avoids producing near-dupes of existing rows. Merge
        // with the session's own answer keys.
        const bankKeys = await fetchBankAnswerKeys(fallbackCategory, fallbackDifficulty);
        const mergedAnswerKeys = [...servedAnswerKeys, ...bankKeys];
        questionRow = await generateAndStore(
          fallbackCategory,
          fallbackDifficulty,
          cleanedHashes,
          servedPassages,
          servedQA,
          mergedAnswerKeys,
          ramp.endlessDepth,
        );
      } catch (err) {
        const ge = err as GeminiError;
        return errorResponse(503, `Gemini unavailable: ${ge.kind ?? 'unknown'}`);
      }
    }
  }

  const openedAt = new Date().toISOString();
  const nextServed = [...servedIds, questionRow.id];
  const { error: updateErr } = await db
    .from('solo_sessions')
    .update({
      current_question_id: questionRow.id,
      current_q_opened_at: openedAt,
      prefetched_question_id: null,
      served_question_ids: nextServed,
    })
    .eq('id', session_id)
    .eq('status', 'active');

  if (updateErr) return errorResponse(500, 'Failed to open question');

  const qDifficulty = (questionRow.difficulty as Difficulty) ?? ramp.difficulty;
  const timerSeconds = TIMER_SECONDS[session.pace as Pace][qDifficulty];
  return jsonResponse({
    question_id: questionRow.id,
    content_hash_16: questionRow.content_hash_16,
    question_text: questionRow.question_text,
    options: questionRow.options,
    scripture_ref: questionRow.scripture_ref,
    category: questionRow.category,
    difficulty: qDifficulty,
    endless_depth: ramp.endlessDepth,
    lives_remaining: session.lives_remaining,
    question_index: session.current_q_index,
    opened_at: openedAt,
    timer_seconds: timerSeconds,
  });
});

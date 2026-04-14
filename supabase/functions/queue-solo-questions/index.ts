import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { generateQuestion } from '../_shared/gemini.ts';
import { verseLookup } from '../_shared/bible-lookup.ts';
import { sanitizeRecentHashes, sha256Hex } from '../_shared/dedup.ts';
import { rampingStateAt } from '../_shared/ramping.ts';
import type { Difficulty } from '../_shared/scoring.ts';

// Pre-generates questions for a solo session.
//
// FIXED mode: pre-fills all remaining slots in parallel up to question_count,
// so every Next click serves an already-stored question instantly.
//
// ENDLESS mode: rolling buffer — keeps ENDLESS_BUFFER questions ahead of the
// player's current_q_index and tops up on every answer submit. No upper bound.
//
// Idempotent via queue_started_at lock; safe to call repeatedly.

const ENDLESS_BUFFER = 5;

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

// Pulls the bank's existing answer-key list for a category+difficulty so the
// generator can be forward-fed the full bank state. Compact format: just the
// normalized answer strings, deduped. Top 80 by quality_score.
async function fetchBankAnswerKeys(
  db: ReturnType<typeof adminClient>,
  category: string,
  difficulty: Difficulty,
): Promise<string[]> {
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

async function bankLookupExcluding(
  db: ReturnType<typeof adminClient>,
  category: string,
  difficulty: Difficulty,
  excludeIds: Set<string>,
  excludePassageKeys: Set<string>,
  excludeHashes16: Set<string>,
  excludeAnswerKeys: Set<string>,
): Promise<{ id: string; scripture_ref: string; question_text: string; answerKey: string } | null> {
  let query = db
    .from('questions')
    .select('id, scripture_ref, question_text, content_hash_16, options, correct_index')
    .eq('category', category)
    .eq('difficulty', difficulty)
    .is('deleted_at', null)
    .order('quality_score', { ascending: false })
    .limit(300);
  const excludeList = [...excludeIds];
  if (excludeList.length > 0) query = query.not('id', 'in', `(${excludeList.map((id) => `"${id}"`).join(',')})`);
  const { data } = await query;
  if (!data) return null;
  for (const row of data) {
    if (excludePassageKeys.has(passageKey(row.scripture_ref))) continue;
    if (row.content_hash_16 && excludeHashes16.has(row.content_hash_16)) continue;
    let answerKey = '';
    if (Array.isArray(row.options) && typeof row.correct_index === 'number') {
      answerKey = normalizeAnswer(row.options[row.correct_index] ?? '');
      if (answerKey && excludeAnswerKeys.has(answerKey)) continue;
    }
    return { id: row.id, scripture_ref: row.scripture_ref, question_text: row.question_text, answerKey };
  }
  return null;
}

async function generateOne(
  db: ReturnType<typeof adminClient>,
  category: string,
  difficulty: Difficulty,
  recentHashes: string[],
  avoidPassages: string[],
  avoidQA: Array<{ question: string; answer: string }>,
  avoidAnswerKeys: string[],
  endlessDepth: number,
): Promise<{ id: string; scripture_ref: string; question_text: string } | null> {
  try {
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
      .select('id, scripture_ref, question_text')
      .single();
    if (error && error.code === '23505') {
      const { data: existing } = await db
        .from('questions')
        .select('id, scripture_ref, question_text')
        .eq('content_hash', content_hash)
        .single();
      return existing ?? null;
    }
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
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
  const recentSet = new Set(cleanedHashes);

  const db = adminClient();

  const { data: session } = await db
    .from('solo_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('player_uuid', player_uuid)
    .single();
  if (!session) return errorResponse(404, 'Session not found');
  if (session.status !== 'active') return jsonResponse({ ok: true, skipped: `session is ${session.status}` });

  const queued: string[] = session.queued_question_ids ?? [];
  const currentIdx: number = session.current_q_index ?? 0;
  const isEndless = session.session_mode === 'endless';

  // Target queue length depends on mode. Fixed = full session; endless =
  // current_q_index + buffer (rolling).
  const targetLength = isEndless
    ? currentIdx + ENDLESS_BUFFER
    : (session.question_count as number);

  if (queued.length >= targetLength) {
    return jsonResponse({ ok: true, already_full: true, queued: queued.length });
  }

  // Idempotent lock.
  const { data: locked } = await db
    .from('solo_sessions')
    .update({ queue_started_at: new Date().toISOString() })
    .eq('id', session_id)
    .or('queue_started_at.is.null,queue_started_at.lt.' + new Date(Date.now() - 60_000).toISOString())
    .select('id')
    .single();
  if (!locked) return jsonResponse({ ok: true, noop: 'already queueing' });

  // Build exclusion sets from already-queued + already-served questions.
  const combinedIds = new Set<string>([...queued, ...(session.served_question_ids ?? [])]);
  const combinedPassageKeys = new Set<string>();
  const combinedAnswerKeys = new Set<string>();
  const combinedQA: Array<{ question: string; answer: string }> = [];
  if (combinedIds.size > 0) {
    const { data: rows } = await db
      .from('questions')
      .select('scripture_ref, question_text, options, correct_index')
      .in('id', [...combinedIds]);
    for (const r of rows ?? []) {
      if (r.scripture_ref) combinedPassageKeys.add(passageKey(r.scripture_ref));
      if (r.question_text && Array.isArray(r.options) && typeof r.correct_index === 'number') {
        const answer = r.options[r.correct_index] ?? '';
        combinedQA.push({ question: r.question_text, answer });
        const ans = normalizeAnswer(answer);
        if (ans) combinedAnswerKeys.add(ans);
      }
    }
  }

  const isRandom = session.category === 'Random';
  const pickedDifficulty = session.difficulty as Difficulty;
  const slotsToFill = targetLength - queued.length;
  const startSlotIndex = queued.length;

  // Per-slot ramping for endless. Fixed mode stays at the picked difficulty.
  const slotCategories: string[] = [];
  const slotDifficulties: Difficulty[] = [];
  const slotDepths: number[] = [];
  for (let i = 0; i < slotsToFill; i++) {
    const absIndex = startSlotIndex + i;
    slotCategories.push(isRandom ? pickRandomConcreteCategory() : session.category);
    if (isEndless) {
      const r = rampingStateAt(pickedDifficulty, absIndex);
      slotDifficulties.push(r.difficulty);
      slotDepths.push(r.endlessDepth);
    } else {
      slotDifficulties.push(pickedDifficulty);
      slotDepths.push(0);
    }
  }

  // Phase 1: drain the bank sequentially, respecting hash + answer-key filters
  // so already-seen and same-answer questions both get excluded.
  const filledIds: string[] = [...queued];
  let bankSlotsMissed = 0;
  for (let i = 0; i < slotsToFill; i++) {
    if (slotDepths[i] > 0) continue;
    const hit = await bankLookupExcluding(
      db,
      slotCategories[i],
      slotDifficulties[i],
      combinedIds,
      combinedPassageKeys,
      recentSet,
      combinedAnswerKeys,
    );
    if (!hit) {
      bankSlotsMissed++;
      continue;
    }
    filledIds.push(hit.id);
    combinedIds.add(hit.id);
    combinedPassageKeys.add(passageKey(hit.scripture_ref));
    combinedQA.push({ question: hit.question_text, answer: '' });
    if (hit.answerKey) combinedAnswerKeys.add(hit.answerKey);
  }
  console.log(`[queue-solo-questions] mode=${session.session_mode} hashes_received=${cleanedHashes.length} answer_keys=${combinedAnswerKeys.size} bank_hits=${filledIds.length - queued.length} slots_missed=${bankSlotsMissed}`);

  // Phase 2: parallel Gemini generation for any remaining slots (or all depth>0 slots).
  const stillNeeded = targetLength - filledIds.length;
  if (stillNeeded > 0) {
    const baseAvoidPassages = [...combinedPassageKeys];
    const baseAvoidQA = [...combinedQA];
    // Cache bank answer-key lookups per (category, difficulty) to avoid
    // duplicate DB hits when multiple slots share the same bucket.
    const bankKeyCache = new Map<string, string[]>();
    const fetchBankKeys = async (cat: string, diff: Difficulty): Promise<string[]> => {
      const k = `${cat}|${diff}`;
      let v = bankKeyCache.get(k);
      if (!v) {
        v = await fetchBankAnswerKeys(db, cat, diff);
        bankKeyCache.set(k, v);
      }
      return v;
    };

    // The slots needing generation are the last N target slots wey bank no fit serve.
    const genStartAbsIndex = filledIds.length;
    const genSlots = Array.from({ length: stillNeeded }, (_, i) => {
      const absIdx = genStartAbsIndex + i;
      const relIdx = absIdx - startSlotIndex;
      const relIdxClamped = Math.min(Math.max(relIdx, 0), slotsToFill - 1);
      return {
        category: isRandom ? pickRandomConcreteCategory() : slotCategories[relIdxClamped],
        difficulty: slotDifficulties[relIdxClamped],
        depth: slotDepths[relIdxClamped],
      };
    });
    const results = await Promise.allSettled(
      genSlots.map(async (slot) => {
        const bankKeys = await fetchBankKeys(slot.category, slot.difficulty);
        const mergedAnswerKeys = [...combinedAnswerKeys, ...bankKeys];
        return generateOne(
          db,
          slot.category,
          slot.difficulty,
          cleanedHashes,
          baseAvoidPassages,
          baseAvoidQA,
          mergedAnswerKeys,
          slot.depth,
        );
      }),
    );
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (combinedIds.has(r.value.id)) continue;
      const k = passageKey(r.value.scripture_ref);
      if (combinedPassageKeys.has(k)) continue;
      filledIds.push(r.value.id);
      combinedIds.add(r.value.id);
      combinedPassageKeys.add(k);
    }
  }

  const { error: updErr } = await db
    .from('solo_sessions')
    .update({
      queued_question_ids: filledIds,
      queue_started_at: null,
    })
    .eq('id', session_id);
  if (updErr) return errorResponse(500, `Failed to persist queue: ${updErr.message}`);

  return jsonResponse({
    ok: true,
    queued: filledIds.length,
    target: targetLength,
  });
});

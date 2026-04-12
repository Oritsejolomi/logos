import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { generateQuestion } from '../_shared/gemini.ts';
import { verseLookup } from '../_shared/bible-lookup.ts';
import { sha256Hex } from '../_shared/dedup.ts';
import type { Difficulty } from '../_shared/scoring.ts';

// Pre-generates all remaining questions for a solo session in parallel, so
// the user only waits on Q1 from get-question and every subsequent Next click
// serves an already-stored question instantly.
//
// Idempotent: a lock on queue_started_at prevents duplicate concurrent fills.
// Safe to call multiple times; will do nothing if the queue is already full.

function passageKey(ref: string): string {
  return ref.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:\-–,].*$/, '').trim();
}

async function bankLookupExcluding(
  db: ReturnType<typeof adminClient>,
  category: string,
  difficulty: Difficulty,
  excludeIds: Set<string>,
  excludePassageKeys: Set<string>,
): Promise<{ id: string; scripture_ref: string; question_text: string } | null> {
  let query = db
    .from('questions')
    .select('id, scripture_ref, question_text')
    .eq('category', category)
    .eq('difficulty', difficulty)
    .is('deleted_at', null)
    .order('quality_score', { ascending: false })
    .limit(100);
  const excludeList = [...excludeIds];
  if (excludeList.length > 0) query = query.not('id', 'in', `(${excludeList.map((id) => `"${id}"`).join(',')})`);
  const { data } = await query;
  if (!data) return null;
  for (const row of data) {
    if (!excludePassageKeys.has(passageKey(row.scripture_ref))) return row;
  }
  return null;
}

async function generateOne(
  db: ReturnType<typeof adminClient>,
  category: string,
  difficulty: Difficulty,
  avoidPassages: string[],
  avoidQuestionTexts: string[],
): Promise<{ id: string; scripture_ref: string; question_text: string } | null> {
  try {
    const generated = await generateQuestion(
      { category, difficulty, recentHashes: [], avoidPassages, avoidQuestionTexts },
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

  const { session_id, player_uuid } = body as { session_id?: string; player_uuid?: string };
  if (!session_id || !player_uuid) return errorResponse(400, 'session_id and player_uuid required');

  const db = adminClient();

  const { data: session } = await db
    .from('solo_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('player_uuid', player_uuid)
    .single();
  if (!session) return errorResponse(404, 'Session not found');
  if (session.status !== 'active') return jsonResponse({ ok: true, skipped: `session is ${session.status}` });

  const needed = session.question_count;
  const queued: string[] = session.queued_question_ids ?? [];
  if (queued.length >= needed) return jsonResponse({ ok: true, already_full: true, queued: queued.length });

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
  let combinedPassageKeys = new Set<string>();
  let combinedTexts: string[] = [];
  if (combinedIds.size > 0) {
    const { data: rows } = await db
      .from('questions')
      .select('scripture_ref, question_text')
      .in('id', [...combinedIds]);
    for (const r of rows ?? []) {
      if (r.scripture_ref) combinedPassageKeys.add(passageKey(r.scripture_ref));
      if (r.question_text) combinedTexts.push(r.question_text);
    }
  }

  const slotsToFill = needed - queued.length;

  // Phase 1: drain the bank sequentially so each pick excludes the previous.
  const filledIds: string[] = [...queued];
  for (let i = 0; i < slotsToFill; i++) {
    const hit = await bankLookupExcluding(
      db,
      session.category,
      session.difficulty as Difficulty,
      combinedIds,
      combinedPassageKeys,
    );
    if (!hit) break;
    filledIds.push(hit.id);
    combinedIds.add(hit.id);
    combinedPassageKeys.add(passageKey(hit.scripture_ref));
    combinedTexts.push(hit.question_text);
  }

  // Phase 2: parallel Gemini generation for any remaining slots.
  const stillNeeded = needed - filledIds.length;
  if (stillNeeded > 0) {
    const baseAvoidPassages = [...combinedPassageKeys];
    const baseAvoidTexts = [...combinedTexts];
    const results = await Promise.allSettled(
      Array.from({ length: stillNeeded }, () =>
        generateOne(
          db,
          session.category,
          session.difficulty as Difficulty,
          baseAvoidPassages,
          baseAvoidTexts,
        ),
      ),
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

  // Persist the filled queue.
  const { error: updErr } = await db
    .from('solo_sessions')
    .update({
      queued_question_ids: filledIds,
      queue_started_at: null, // release the lock
    })
    .eq('id', session_id);
  if (updErr) return errorResponse(500, `Failed to persist queue: ${updErr.message}`);

  return jsonResponse({
    ok: true,
    queued: filledIds.length,
    requested: needed,
    from_bank: filledIds.length - stillNeeded,
    from_gemini: Math.min(stillNeeded, filledIds.length - (needed - stillNeeded)),
  });
});

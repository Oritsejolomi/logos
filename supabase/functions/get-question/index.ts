import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { sanitizeRecentHashes, sha256Hex } from '../_shared/dedup.ts';
import { generateQuestion, GeminiError } from '../_shared/gemini.ts';
import { verseLookup } from '../_shared/bible-lookup.ts';
import type { Difficulty, Pace } from '../_shared/scoring.ts';
import { TIMER_SECONDS } from '../_shared/scoring.ts';

interface QuestionRow {
  id: string;
  question_text: string;
  options: string[];
  scripture_ref: string;
  correct_index: number;
  insight: string;
  content_hash_16?: string;
}

function passageKey(ref: string): string {
  return ref.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:\-–,].*$/, '').trim();
}

async function fetchFromBank(
  category: string,
  difficulty: Difficulty,
  excludeHashes16: string[],
  excludeIds: string[],
  excludePassageKeys: string[],
): Promise<QuestionRow | null> {
  const db = adminClient();
  let query = db
    .from('questions')
    .select('id, question_text, options, scripture_ref, correct_index, insight, content_hash_16')
    .eq('category', category)
    .eq('difficulty', difficulty)
    .is('deleted_at', null)
    .order('quality_score', { ascending: false })
    .limit(100);
  if (excludeIds.length > 0) query = query.not('id', 'in', `(${excludeIds.map((id) => `"${id}"`).join(',')})`);
  const { data, error } = await query;
  if (error || !data) return null;
  const excludePassageSet = new Set(excludePassageKeys);
  const fresh = data.filter((row) =>
    !excludeHashes16.includes(row.content_hash_16) &&
    !excludePassageSet.has(passageKey(row.scripture_ref)),
  );
  if (fresh.length === 0) return null;
  const pick = fresh[Math.floor(Math.random() * Math.min(fresh.length, 10))];
  return pick as unknown as QuestionRow;
}

async function generateAndStore(
  category: string,
  difficulty: Difficulty,
  recentHashes: string[],
  avoidPassages: string[],
  avoidQuestionTexts: string[],
): Promise<QuestionRow> {
  const db = adminClient();
  const generated = await generateQuestion(
    { category, difficulty, recentHashes, avoidPassages, avoidQuestionTexts },
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
    .select('id, question_text, options, scripture_ref, correct_index, insight, content_hash_16')
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await db
        .from('questions')
        .select('id, question_text, options, scripture_ref, correct_index, insight, content_hash_16')
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
  if (session.current_q_index >= session.question_count) return errorResponse(409, 'All questions answered');

  // Idempotent re-fetch: if a question is already open, return it.
  if (session.current_question_id) {
    const { data: q } = await db
      .from('questions')
      .select('id, question_text, options, scripture_ref, content_hash_16')
      .eq('id', session.current_question_id)
      .single();
    if (q) {
      const timerSeconds = TIMER_SECONDS[session.pace as Pace][session.difficulty as Difficulty];
      return jsonResponse({
        question_id: q.id,
        content_hash_16: q.content_hash_16,
        question_text: q.question_text,
        options: q.options,
        scripture_ref: q.scripture_ref,
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
      .select('id, question_text, options, scripture_ref, correct_index, insight, content_hash_16')
      .eq('id', queuedId)
      .is('deleted_at', null)
      .single();
    if (q) questionRow = q as unknown as QuestionRow;
  }

  // Fallback path: bank lookup, then Gemini.
  if (!questionRow) {
    let servedPassages: string[] = [];
    let servedTexts: string[] = [];
    if (servedIds.length > 0) {
      const { data: servedRows } = await db
        .from('questions')
        .select('scripture_ref, question_text')
        .in('id', servedIds);
      servedPassages = (servedRows ?? []).map((r) => r.scripture_ref).filter((s): s is string => !!s);
      servedTexts = (servedRows ?? []).map((r) => r.question_text).filter((s): s is string => !!s);
    }
    const servedPassageKeys = servedPassages.map(passageKey);

    questionRow = await fetchFromBank(
      session.category,
      session.difficulty as Difficulty,
      cleanedHashes,
      servedIds,
      servedPassageKeys,
    );
    if (!questionRow) {
      try {
        questionRow = await generateAndStore(
          session.category,
          session.difficulty as Difficulty,
          cleanedHashes,
          servedPassages,
          servedTexts,
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

  const timerSeconds = TIMER_SECONDS[session.pace as Pace][session.difficulty as Difficulty];
  return jsonResponse({
    question_id: questionRow.id,
    content_hash_16: questionRow.content_hash_16,
    question_text: questionRow.question_text,
    options: questionRow.options,
    scripture_ref: questionRow.scripture_ref,
    question_index: session.current_q_index,
    opened_at: openedAt,
    timer_seconds: timerSeconds,
  });
});

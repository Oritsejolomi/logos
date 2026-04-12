import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { pointsForAnswer, type Difficulty, type Pace } from '../_shared/scoring.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { session_id, player_uuid, selected_index } = body as {
    session_id?: string;
    player_uuid?: string;
    selected_index?: number | null;
  };

  if (!session_id || !player_uuid) return errorResponse(400, 'session_id and player_uuid required');
  if (selected_index !== null && (typeof selected_index !== 'number' || selected_index < 0 || selected_index > 3)) {
    return errorResponse(400, 'selected_index must be 0-3 or null (timeout)');
  }

  const db = adminClient();

  const { data: session, error: sessErr } = await db
    .from('solo_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('player_uuid', player_uuid)
    .single();

  if (sessErr || !session) return errorResponse(404, 'Session not found');
  if (session.status !== 'active') return errorResponse(409, `Session is ${session.status}`);
  if (!session.current_question_id || !session.current_q_opened_at) {
    return errorResponse(409, 'No question is currently open');
  }

  const { data: question, error: qErr } = await db
    .from('questions')
    .select('id, correct_index, insight, scripture_ref')
    .eq('id', session.current_question_id)
    .single();

  if (qErr || !question) return errorResponse(500, 'Question missing');

  const openedAt = new Date(session.current_q_opened_at).getTime();
  const now = Date.now();
  const timeMs = Math.max(0, now - openedAt);

  const isCorrect = selected_index !== null && selected_index === question.correct_index;
  const { points, newStreak, multiplier } = pointsForAnswer({
    difficulty: session.difficulty as Difficulty,
    pace: session.pace as Pace,
    isCorrect,
    timeMs,
    currentStreak: session.streak,
  });

  const nextIndex = session.current_q_index + 1;
  const isFinished = nextIndex >= session.question_count;

  // Conditional UPDATE: current_question_id must still match. Protects against
  // double-submit races — only the first call updates the row.
  const { data: updated, error: updErr } = await db
    .from('solo_sessions')
    .update({
      score: session.score + points,
      streak: newStreak,
      current_q_index: nextIndex,
      current_question_id: null,
      current_q_opened_at: null,
      total_time_ms: session.total_time_ms + timeMs,
      status: isFinished ? 'finished' : 'active',
      finished_at: isFinished ? new Date().toISOString() : null,
    })
    .eq('id', session_id)
    .eq('current_question_id', question.id)
    .select('score, streak, current_q_index, status')
    .single();

  if (updErr || !updated) return errorResponse(409, 'Answer already submitted or session advanced');

  // Best-effort play_count increment — a failure here only weakens the
  // early-skepticism gate slightly, it does not break the user's flow.
  const { error: rpcErr } = await db.rpc('increment_play_count', { q_id: question.id });
  if (rpcErr) console.warn('increment_play_count failed:', rpcErr.message);

  return jsonResponse({
    is_correct: isCorrect,
    correct_index: question.correct_index,
    points_awarded: points,
    new_score: updated.score,
    new_streak: updated.streak,
    multiplier,
    insight: question.insight,
    scripture_ref: question.scripture_ref,
    session_status: updated.status,
    next_question_index: updated.current_q_index,
    total_time_ms: session.total_time_ms + timeMs,
  });
});

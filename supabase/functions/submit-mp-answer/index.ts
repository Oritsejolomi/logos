import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { pointsForAnswer, type Difficulty, type Pace } from '../_shared/scoring.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { room_id, player_uuid, selected_index } = body as {
    room_id?: string;
    player_uuid?: string;
    selected_index?: number | null;
  };

  if (!room_id || !player_uuid) return errorResponse(400, 'room_id and player_uuid required');
  if (selected_index !== null && (typeof selected_index !== 'number' || selected_index < 0 || selected_index > 3)) {
    return errorResponse(400, 'selected_index must be 0-3 or null');
  }

  const db = adminClient();

  const { data: room, error: roomErr } = await db
    .from('rooms')
    .select('status, difficulty, pace, question_ids, current_q_index, current_q_opened_at, current_q_ends_at')
    .eq('id', room_id)
    .single();
  if (roomErr || !room) return errorResponse(404, 'Room not found');
  if (room.status !== 'in_progress') return errorResponse(409, `Room is ${room.status}`);

  const now = Date.now();
  const opened = room.current_q_opened_at ? new Date(room.current_q_opened_at).getTime() : 0;
  const ends = room.current_q_ends_at ? new Date(room.current_q_ends_at).getTime() : 0;
  if (now < opened) return errorResponse(409, 'Question not yet open (insight window)');
  if (now > ends) return errorResponse(409, 'Question timer expired');

  const idx = room.current_q_index;
  const questionId = room.question_ids?.[idx];
  if (!questionId) return errorResponse(500, 'No question at current index');

  const { data: question, error: qErr } = await db
    .from('questions')
    .select('correct_index')
    .eq('id', questionId)
    .single();
  if (qErr || !question) return errorResponse(500, 'Question missing');

  // Load the current player row for streak/score baseline.
  const { data: rp, error: rpErr } = await db
    .from('room_players')
    .select('id, score, streak')
    .eq('room_id', room_id)
    .eq('player_uuid', player_uuid)
    .single();
  if (rpErr || !rp) return errorResponse(404, 'Player not in room');

  const timeMs = Math.max(0, now - opened);
  const isCorrect = selected_index !== null && selected_index === question.correct_index;
  const { points, newStreak, multiplier } = pointsForAnswer({
    difficulty: room.difficulty as Difficulty,
    pace: room.pace as Pace,
    isCorrect,
    timeMs,
    currentStreak: rp.streak,
  });

  // Insert the answer row. Unique (room_id, question_index, player_uuid) prevents double-submit.
  const { error: ansErr } = await db.from('room_answers').insert({
    room_id,
    question_id: questionId,
    question_index: idx,
    player_uuid,
    selected_index,
    is_correct: isCorrect,
    time_ms: timeMs,
    points_awarded: points,
  });
  if (ansErr) {
    if (ansErr.code === '23505') return errorResponse(409, 'Answer already submitted');
    return errorResponse(500, `Failed to record answer: ${ansErr.message}`);
  }

  // Update the player's score/streak/multiplier. The stored multiplier is the
  // one that was APPLIED to this answer — same semantics as solo submit-answer.
  // For a wrong answer, pointsForAnswer returns 1.0 (reset), which is correct.
  const { data: updated } = await db
    .from('room_players')
    .update({
      score: rp.score + points,
      streak: newStreak,
      multiplier,
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', rp.id)
    .select('score, streak, multiplier')
    .single();

  // Best-effort play_count increment.
  await db.rpc('increment_play_count', { q_id: questionId });

  return jsonResponse({
    is_correct: isCorrect,
    points_awarded: points,
    new_score: updated?.score ?? rp.score + points,
    new_streak: updated?.streak ?? newStreak,
    multiplier: updated?.multiplier ?? multiplier,
    time_ms: timeMs,
  });
});

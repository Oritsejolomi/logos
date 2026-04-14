import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { pointsForAnswer, type Difficulty, type Pace } from '../_shared/scoring.ts';

const ENDLESS_LIFE_REGEN_EVERY = 7;
const ENDLESS_MAX_LIVES = 3;

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
    .select('status, difficulty, pace, question_ids, current_q_index, current_q_opened_at, current_q_ends_at, session_mode, mp_variant, shared_lives')
    .eq('id', room_id)
    .single();
  if (roomErr || !room) return errorResponse(404, 'Room not found');
  if (room.status !== 'in_progress') return errorResponse(409, `Room is ${room.status}`);

  const now = Date.now();
  const opened = room.current_q_opened_at ? new Date(room.current_q_opened_at).getTime() : 0;
  const ends = room.current_q_ends_at ? new Date(room.current_q_ends_at).getTime() : 0;
  if (now < opened) return errorResponse(409, 'Question not yet open (insight window)');
  if (now > ends) return errorResponse(409, 'Question timer expired');

  const idx = room.current_q_index as number;
  const questionId = room.question_ids?.[idx];
  if (!questionId) return errorResponse(500, 'No question at current index');

  const { data: question, error: qErr } = await db
    .from('questions')
    .select('correct_index, difficulty')
    .eq('id', questionId)
    .single();
  if (qErr || !question) return errorResponse(500, 'Question missing');

  const { data: rp, error: rpErr } = await db
    .from('room_players')
    .select('id, score, streak, lives_remaining, correct_count, eliminated_at')
    .eq('room_id', room_id)
    .eq('player_uuid', player_uuid)
    .single();
  if (rpErr || !rp) return errorResponse(404, 'Player not in room');

  // Block eliminated players from submitting.
  if (rp.eliminated_at) return errorResponse(409, 'Player is eliminated');

  // Read any prior answer for this round — answer change rollback.
  const { data: prior } = await db
    .from('room_answers')
    .select('points_awarded, streak_before, is_correct')
    .eq('room_id', room_id)
    .eq('question_index', idx)
    .eq('player_uuid', player_uuid)
    .maybeSingle();

  const baselineStreak = prior && prior.streak_before !== null
    ? (prior.streak_before as number)
    : (rp.streak as number);
  const rolledBackScore = prior ? (rp.score as number) - (prior.points_awarded ?? 0) : (rp.score as number);

  const timeMs = Math.max(0, now - opened);
  const isCorrect = selected_index !== null && selected_index === question.correct_index;
  const { points, newStreak, multiplier, basePoints, speedBonus } = pointsForAnswer({
    difficulty: (question.difficulty as Difficulty) ?? (room.difficulty as Difficulty),
    pace: room.pace as Pace,
    isCorrect,
    timeMs,
    currentStreak: baselineStreak,
  });

  const { error: ansErr } = await db
    .from('room_answers')
    .upsert({
      room_id,
      question_id: questionId,
      question_index: idx,
      player_uuid,
      selected_index,
      is_correct: isCorrect,
      time_ms: timeMs,
      points_awarded: points,
      streak_before: baselineStreak,
    }, { onConflict: 'room_id,question_index,player_uuid' });
  if (ansErr) return errorResponse(500, `Failed to record answer: ${ansErr.message}`);

  // --- endless life bookkeeping ---
  const isEndless = room.session_mode === 'endless';
  const isReSubmit = !!prior;
  const priorWasCorrect = prior?.is_correct ?? false;
  const correctnessChanged = isReSubmit && priorWasCorrect !== isCorrect;
  // Net life delta relative to the prior submit (if any). First submit: -1 on
  // wrong, 0 on correct. Re-submit: flip the previous life delta if correctness changed.
  let lifeDelta = 0;
  if (isEndless) {
    if (!isReSubmit) {
      lifeDelta = isCorrect ? 0 : -1;
    } else if (correctnessChanged) {
      // previously wrong (−1) now right → +1 ; previously right (0) now wrong → −1
      lifeDelta = priorWasCorrect ? -1 : +1;
    }
  }

  // Correct-count delta for life regen tracking. Correct answers always count,
  // but on a re-submit we don't want to double-count or inflate the regen counter.
  let correctDelta = 0;
  if (isEndless) {
    if (!isReSubmit) correctDelta = isCorrect ? 1 : 0;
    else if (correctnessChanged) correctDelta = isCorrect ? +1 : -1;
  }

  const newCorrectCount = Math.max(0, (rp.correct_count ?? 0) + correctDelta);

  let newLives = rp.lives_remaining as number | null;
  let eliminatedAt: string | null = null;
  let newSharedLives = room.shared_lives as number | null;

  // Regen fires on 7 correct answers IN A ROW — i.e. when newStreak is a
  // positive multiple of 7. Guard against double-granting on a re-submit:
  // if the prior submit was already correct, the regen was already processed
  // on that submit and we must not fire again.
  const regenEligible = isCorrect
    && newStreak > 0
    && newStreak % ENDLESS_LIFE_REGEN_EVERY === 0
    && !(isReSubmit && priorWasCorrect);

  if (isEndless && room.mp_variant === 'battle_royale') {
    newLives = Math.max(0, (newLives ?? 0) + lifeDelta);
    if (regenEligible && (newLives ?? 0) < ENDLESS_MAX_LIVES) {
      newLives = (newLives ?? 0) + 1;
    }
    if ((newLives ?? 0) === 0) eliminatedAt = new Date().toISOString();
  } else if (isEndless && room.mp_variant === 'co_op') {
    newSharedLives = Math.max(0, (newSharedLives ?? 0) + lifeDelta);
    if (regenEligible && (newSharedLives ?? 0) < ENDLESS_MAX_LIVES) {
      newSharedLives = (newSharedLives ?? 0) + 1;
    }
  }

  const rpUpdate: Record<string, unknown> = {
    score: rolledBackScore + points,
    streak: newStreak,
    multiplier,
    last_seen_at: new Date().toISOString(),
  };
  if (isEndless) {
    rpUpdate.correct_count = newCorrectCount;
    if (room.mp_variant === 'battle_royale') {
      rpUpdate.lives_remaining = newLives;
      if (eliminatedAt) rpUpdate.eliminated_at = eliminatedAt;
    }
  }

  const { data: updated } = await db
    .from('room_players')
    .update(rpUpdate)
    .eq('id', rp.id)
    .select('score, streak, multiplier, lives_remaining, correct_count, eliminated_at')
    .single();

  // Apply shared_lives update on room row if co_op and value changed.
  if (isEndless && room.mp_variant === 'co_op' && newSharedLives !== room.shared_lives) {
    await db.from('rooms').update({ shared_lives: newSharedLives }).eq('id', room_id);
  }

  // Best-effort play_count increment — only on first submit.
  if (!prior) {
    await db.rpc('increment_play_count', { q_id: questionId });
  }

  return jsonResponse({
    is_correct: isCorrect,
    points_awarded: points,
    base_points: basePoints,
    speed_bonus: speedBonus,
    new_score: updated?.score ?? rolledBackScore + points,
    new_streak: updated?.streak ?? newStreak,
    multiplier: updated?.multiplier ?? multiplier,
    time_ms: timeMs,
    lives_remaining: updated?.lives_remaining ?? null,
    correct_count: updated?.correct_count ?? null,
    eliminated: !!updated?.eliminated_at,
    shared_lives: isEndless && room.mp_variant === 'co_op' ? newSharedLives : null,
  });
});

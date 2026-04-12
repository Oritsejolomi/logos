import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { broadcastToRoom } from '../_shared/realtime.ts';
import { TIMER_SECONDS, type Difficulty, type Pace } from '../_shared/scoring.ts';

const INSIGHT_WINDOW_MS = 8_000;

const ALL_CATEGORIES = [
  'Old Testament',
  'New Testament',
  'Prophets',
  'Psalms & Wisdom',
  'Parables',
  "Paul's Letters",
  'Theology',
  'Church History',
];

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { room_id } = body as { room_id?: string };
  if (!room_id) return errorResponse(400, 'room_id required');

  const db = adminClient();

  const { data: room, error: roomErr } = await db
    .from('rooms')
    .select('*')
    .eq('id', room_id)
    .single();

  if (roomErr || !room) return errorResponse(404, 'Room not found');

  const now = Date.now();
  const timerSecs = TIMER_SECONDS[room.pace as Pace]?.[room.difficulty as Difficulty] ?? 30;

  // --------------------------------------------------------------------
  // category_select → generating
  // --------------------------------------------------------------------
  if (room.status === 'category_select') {
    const endsAt = room.category_select_ends_at ? new Date(room.category_select_ends_at).getTime() : 0;
    if (now < endsAt) return jsonResponse({ ok: true, noop: 'category_select in progress' });

    // Gather picks. If any, pick randomly from picks. Otherwise random full list.
    const { data: picks } = await db
      .from('room_players')
      .select('category_pick')
      .eq('room_id', room_id)
      .not('category_pick', 'is', null);
    const pickPool = (picks ?? []).map((p) => p.category_pick as string);
    const chosen = pickPool.length > 0
      ? pickPool[Math.floor(Math.random() * pickPool.length)]
      : ALL_CATEGORIES[Math.floor(Math.random() * ALL_CATEGORIES.length)];

    // Conditional transition: only one tick wins the resolve.
    const { data: advanced, error } = await db
      .from('rooms')
      .update({
        status: 'generating',
        category: chosen,
      })
      .eq('id', room_id)
      .eq('status', 'category_select')
      .select('id, status, category')
      .single();

    if (error || !advanced) return jsonResponse({ ok: true, noop: 'already resolved by another tick' });

    return jsonResponse({
      ok: true,
      transition: 'category_select → generating',
      category: chosen,
    });
  }

  // --------------------------------------------------------------------
  // generating → (start-room-questions owns this transition, not tick)
  // --------------------------------------------------------------------
  if (room.status === 'generating') {
    return jsonResponse({ ok: true, noop: 'waiting for question generation' });
  }

  // --------------------------------------------------------------------
  // in_progress: round advance or insight window
  // --------------------------------------------------------------------
  if (room.status !== 'in_progress') {
    return jsonResponse({ ok: true, noop: `status=${room.status}` });
  }

  const opened = room.current_q_opened_at ? new Date(room.current_q_opened_at).getTime() : 0;
  const ends = room.current_q_ends_at ? new Date(room.current_q_ends_at).getTime() : 0;

  // Insight window: question is scheduled to open in the future (between rounds).
  if (now < opened) {
    return jsonResponse({ ok: true, noop: 'insight window' });
  }

  // Check round close conditions.
  const { count: answeredCount } = await db
    .from('room_answers')
    .select('*', { count: 'exact', head: true })
    .eq('room_id', room_id)
    .eq('question_index', room.current_q_index);

  const { count: playerCount } = await db
    .from('room_players')
    .select('*', { count: 'exact', head: true })
    .eq('room_id', room_id);

  const timedOut = now >= ends;
  const allAnswered = (answeredCount ?? 0) >= (playerCount ?? 0);

  if (!timedOut && !allAnswered) {
    return jsonResponse({
      ok: true,
      noop: 'round active',
      answered_count: answeredCount ?? 0,
      player_count: playerCount ?? 0,
    });
  }

  // Close the round. Gather data for the round_closed broadcast BEFORE we
  // advance, so the payload references the round that just closed.
  const closingIndex = room.current_q_index;
  const questionId = room.question_ids?.[closingIndex];

  let correctIndex: number | null = null;
  let insight: string | null = null;
  let scriptureRef: string | null = null;
  if (questionId) {
    const { data: q } = await db
      .from('questions')
      .select('correct_index, insight, scripture_ref')
      .eq('id', questionId)
      .single();
    if (q) {
      correctIndex = q.correct_index;
      insight = q.insight;
      scriptureRef = q.scripture_ref;
    }
  }

  const { data: answers } = await db
    .from('room_answers')
    .select('player_uuid, selected_index, is_correct, points_awarded, time_ms')
    .eq('room_id', room_id)
    .eq('question_index', closingIndex);

  const { data: players } = await db
    .from('room_players')
    .select('player_uuid, display_username, score, streak, multiplier, is_host')
    .eq('room_id', room_id);

  const playerResults = (players ?? []).map((p) => {
    const a = (answers ?? []).find((x) => x.player_uuid === p.player_uuid);
    return {
      player_uuid: p.player_uuid,
      display_username: p.display_username,
      selected_index: a?.selected_index ?? null,
      is_correct: a?.is_correct ?? false,
      points_awarded: a?.points_awarded ?? 0,
      time_ms: a?.time_ms ?? null,
      score: p.score,
      streak: p.streak,
      multiplier: p.multiplier,
    };
  });

  const isLastRound = closingIndex + 1 >= room.question_count;
  const nextOpenedAt = new Date(now + INSIGHT_WINDOW_MS).toISOString();
  const nextEndsAt = new Date(now + INSIGHT_WINDOW_MS + timerSecs * 1000).toISOString();

  if (isLastRound) {
    // Transition directly to finished. Still broadcast the reveal.
    const { data: advanced, error } = await db
      .from('rooms')
      .update({
        status: 'finished',
      })
      .eq('id', room_id)
      .eq('status', 'in_progress')
      .eq('current_q_index', closingIndex)
      .select('id')
      .single();
    if (error || !advanced) return jsonResponse({ ok: true, noop: 'already advanced' });
  } else {
    const { data: advanced, error } = await db
      .from('rooms')
      .update({
        current_q_index: closingIndex + 1,
        current_q_opened_at: nextOpenedAt,
        current_q_ends_at: nextEndsAt,
      })
      .eq('id', room_id)
      .eq('status', 'in_progress')
      .eq('current_q_index', closingIndex)
      .select('id')
      .single();
    if (error || !advanced) return jsonResponse({ ok: true, noop: 'already advanced' });
  }

  // Broadcast the round reveal with the rich payload.
  await broadcastToRoom(room.room_code, 'round_closed', {
    closed_index: closingIndex,
    correct_index: correctIndex,
    insight,
    scripture_ref: scriptureRef,
    player_results: playerResults,
    is_final: isLastRound,
    next_question_opens_at: isLastRound ? null : nextOpenedAt,
  });

  return jsonResponse({
    ok: true,
    transition: isLastRound ? 'in_progress → finished' : `round ${closingIndex} → ${closingIndex + 1}`,
    closed_index: closingIndex,
  });
});

import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { broadcastToRoom } from '../_shared/realtime.ts';
import { TIMER_SECONDS, type Difficulty, type Pace } from '../_shared/scoring.ts';
import { rampingStateAt } from '../_shared/ramping.ts';

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
  'Life & Today',
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
  const isEndless = room.session_mode === 'endless';
  const pickedDifficulty = room.difficulty as Difficulty;

  // For endless rooms, the question at current_q_index was generated at the
  // ramped difficulty. Timer for the NEXT round uses the next ramped tier.
  const nextRoundDifficulty = isEndless
    ? rampingStateAt(pickedDifficulty, (room.current_q_index as number) + 1).difficulty
    : pickedDifficulty;
  const nextTimerSecs = TIMER_SECONDS[room.pace as Pace]?.[nextRoundDifficulty] ?? 30;

  // --------------------------------------------------------------------
  // category_select → generating
  // --------------------------------------------------------------------
  if (room.status === 'category_select') {
    const endsAt = room.category_select_ends_at ? new Date(room.category_select_ends_at).getTime() : 0;
    if (now < endsAt) return jsonResponse({ ok: true, noop: 'category_select in progress' });

    const { data: picks } = await db
      .from('room_players')
      .select('category_pick')
      .eq('room_id', room_id)
      .not('category_pick', 'is', null);
    const pickPool = (picks ?? []).map((p) => p.category_pick as string);
    const chosen = pickPool.length > 0
      ? pickPool[Math.floor(Math.random() * pickPool.length)]
      : ALL_CATEGORIES[Math.floor(Math.random() * ALL_CATEGORIES.length)];

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

  if (room.status === 'generating') {
    return jsonResponse({ ok: true, noop: 'waiting for question generation' });
  }

  if (room.status !== 'in_progress') {
    return jsonResponse({ ok: true, noop: `status=${room.status}` });
  }

  const opened = room.current_q_opened_at ? new Date(room.current_q_opened_at).getTime() : 0;
  const ends = room.current_q_ends_at ? new Date(room.current_q_ends_at).getTime() : 0;

  if (now < opened) {
    return jsonResponse({ ok: true, noop: 'insight window' });
  }

  // Check round close conditions. In battle royale we only block on alive
  // players; eliminated players can't answer anyway.
  const { count: answeredCount } = await db
    .from('room_answers')
    .select('*', { count: 'exact', head: true })
    .eq('room_id', room_id)
    .eq('question_index', room.current_q_index);

  let expectedAnswerCount: number;
  if (isEndless && room.mp_variant === 'battle_royale') {
    const { count: aliveCount } = await db
      .from('room_players')
      .select('*', { count: 'exact', head: true })
      .eq('room_id', room_id)
      .is('eliminated_at', null);
    expectedAnswerCount = aliveCount ?? 0;
  } else {
    const { count: playerCount } = await db
      .from('room_players')
      .select('*', { count: 'exact', head: true })
      .eq('room_id', room_id);
    expectedAnswerCount = playerCount ?? 0;
  }

  const timedOut = now >= ends;
  const allAnswered = (answeredCount ?? 0) >= expectedAnswerCount;

  if (!timedOut && !allAnswered) {
    return jsonResponse({
      ok: true,
      noop: 'round active',
      answered_count: answeredCount ?? 0,
      expected_answer_count: expectedAnswerCount,
    });
  }

  // Close the round. Gather data for the round_closed broadcast BEFORE we
  // advance, so the payload references the round that just closed.
  const closingIndex = room.current_q_index as number;
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
    .select('player_uuid, display_username, score, streak, multiplier, is_host, lives_remaining, eliminated_at, correct_count')
    .eq('room_id', room_id);

  // --- ENDLESS: project life losses for timed-out players IN MEMORY first ---
  // We do NOT write to room_players yet. Two concurrent tick-room calls could
  // both pass the timed_out guard above and both deduct lives, so we must
  // atomically claim the round-close on rooms BEFORE we touch room_players.
  // Only the tick that wins the conditional UPDATE applies the dock writes.
  let newSharedLives = room.shared_lives as number | null;
  type DockUpdate = { player_uuid: string; newLives: number; eliminatedAt: string | null };
  const dockUpdates: DockUpdate[] = [];
  if (isEndless) {
    const answeredBy = new Set((answers ?? []).map((a) => a.player_uuid));
    for (const p of players ?? []) {
      if (p.eliminated_at) continue; // already out
      if (answeredBy.has(p.player_uuid)) continue; // already counted

      if (room.mp_variant === 'battle_royale') {
        const newLives = Math.max(0, (p.lives_remaining ?? 0) - 1);
        const eliminatedAt = newLives === 0 ? new Date().toISOString() : null;
        dockUpdates.push({ player_uuid: p.player_uuid, newLives, eliminatedAt });
      } else if (room.mp_variant === 'co_op') {
        newSharedLives = Math.max(0, (newSharedLives ?? 0) - 1);
        dockUpdates.push({ player_uuid: p.player_uuid, newLives: 0, eliminatedAt: null });
      }
    }
  }

  // End-of-game detection (computed against the PROJECTED post-dock state).
  let isLastRound: boolean;
  if (!isEndless) {
    isLastRound = closingIndex + 1 >= (room.question_count as number);
  } else if (room.mp_variant === 'battle_royale') {
    const dockByPlayer = new Map(dockUpdates.map((d) => [d.player_uuid, d]));
    const projectedAlive = (players ?? []).filter((p) => {
      if (p.eliminated_at) return false;
      const dock = dockByPlayer.get(p.player_uuid);
      if (dock) return dock.newLives > 0;
      return true; // answered the round, still alive
    }).length;
    const totalPlayers = (players ?? []).length;
    // End when: zero alive, or only 1 alive AND there were more than 1 players to begin with.
    isLastRound = projectedAlive === 0 || (projectedAlive <= 1 && totalPlayers > 1);
  } else {
    // co_op
    isLastRound = (newSharedLives ?? 0) <= 0;
  }

  const nextOpenedAt = new Date(now + INSIGHT_WINDOW_MS).toISOString();
  const nextEndsAt = new Date(now + INSIGHT_WINDOW_MS + nextTimerSecs * 1000).toISOString();

  // Atomic claim of the round-close. Only one concurrent tick wins this UPDATE
  // (gated on current_q_index = closingIndex), so only one tick proceeds to
  // apply the dock writes below. Losers bail with a noop.
  const advancePayload: Record<string, unknown> = isLastRound
    ? { status: 'finished' }
    : {
        current_q_index: closingIndex + 1,
        current_q_opened_at: nextOpenedAt,
        current_q_ends_at: nextEndsAt,
      };
  if (isEndless && room.mp_variant === 'co_op' && newSharedLives !== room.shared_lives) {
    advancePayload.shared_lives = newSharedLives;
  }
  const { data: advanced, error: advanceErr } = await db
    .from('rooms')
    .update(advancePayload)
    .eq('id', room_id)
    .eq('status', 'in_progress')
    .eq('current_q_index', closingIndex)
    .select('id')
    .single();
  if (advanceErr || !advanced) {
    return jsonResponse({ ok: true, noop: 'already advanced by another tick' });
  }

  // We won the race. Apply the dock writes exactly once.
  for (const dock of dockUpdates) {
    const updates: Record<string, unknown> = {
      streak: 0,
      multiplier: 1.0,
    };
    if (room.mp_variant === 'battle_royale') {
      updates.lives_remaining = dock.newLives;
      if (dock.eliminatedAt) updates.eliminated_at = dock.eliminatedAt;
    }
    await db
      .from('room_players')
      .update(updates)
      .eq('room_id', room_id)
      .eq('player_uuid', dock.player_uuid);
  }

  // Re-load player state for the broadcast after life adjustments.
  const { data: playersAfter } = await db
    .from('room_players')
    .select('player_uuid, display_username, score, streak, multiplier, is_host, lives_remaining, eliminated_at, correct_count')
    .eq('room_id', room_id);

  const playerResults = (playersAfter ?? []).map((p) => {
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
      lives_remaining: p.lives_remaining,
      eliminated: !!p.eliminated_at,
    };
  });

  await broadcastToRoom(room.room_code, 'round_closed', {
    closed_index: closingIndex,
    correct_index: correctIndex,
    insight,
    scripture_ref: scriptureRef,
    player_results: playerResults,
    is_final: isLastRound,
    next_question_opens_at: isLastRound ? null : nextOpenedAt,
    shared_lives: isEndless && room.mp_variant === 'co_op' ? newSharedLives : null,
  });

  return jsonResponse({
    ok: true,
    transition: isLastRound ? 'in_progress → finished' : `round ${closingIndex} → ${closingIndex + 1}`,
    closed_index: closingIndex,
  });
});

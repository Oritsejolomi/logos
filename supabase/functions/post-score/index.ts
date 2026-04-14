import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { validateScoreSubmission, type Difficulty, type Pace, type SessionMode } from '../_shared/scoring.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { session_id, player_uuid, username, mode = 'solo' } = body as {
    session_id?: string;
    player_uuid?: string;
    username?: string;
    mode?: string;
  };

  if (!session_id || !player_uuid) return errorResponse(400, 'session_id and player_uuid required');
  if (!username || typeof username !== 'string' || username.length > 40) return errorResponse(400, 'username required');
  if (!['solo', 'multiplayer'].includes(mode)) return errorResponse(400, 'invalid mode');

  const db = adminClient();

  if (mode === 'solo') {
    const { data: session, error } = await db
      .from('solo_sessions')
      .select('*')
      .eq('id', session_id)
      .eq('player_uuid', player_uuid)
      .single();

    if (error || !session) return errorResponse(404, 'Session not found');
    if (session.status !== 'finished') return errorResponse(409, `Session is ${session.status}, cannot post score`);

    const sessionMode = (session.session_mode as SessionMode) ?? 'fixed';
    // For endless, "question_count" in the scores row reflects how many
    // questions the player got through before dying. For fixed, use the
    // session's question_count as usual.
    const questionCount = sessionMode === 'endless'
      ? (session.current_q_index as number)
      : (session.question_count as number);

    const check = validateScoreSubmission({
      score: session.score,
      questionCount,
      difficulty: session.difficulty as Difficulty,
      pace: session.pace as Pace,
      totalTimeMs: session.total_time_ms,
      sessionMode,
    });

    if (!check.ok) return errorResponse(400, `Score validation failed: ${check.reason}`);

    const { data: inserted, error: insErr } = await db
      .from('scores')
      .insert({
        username: username.trim(),
        score: session.score,
        category: session.category,
        difficulty: session.difficulty,
        pace: session.pace,
        question_count: questionCount,
        total_time_ms: session.total_time_ms,
        mode: 'solo',
        session_mode: sessionMode,
        source_session_id: session_id,
      })
      .select('id')
      .single();

    if (insErr) {
      if (insErr.code === '23505') {
        // Idempotent: the score was already posted for this session. Return
        // the existing row's rank instead of a hard error. Protects against
        // double-click, retry-after-network-flake, and browser back/forward.
        const { data: existing } = await db
          .from('scores')
          .select('id')
          .eq('source_session_id', session_id)
          .eq('mode', 'solo')
          .maybeSingle();
        const { count } = await db
          .from('scores')
          .select('*', { count: 'exact', head: true })
          .eq('mode', 'solo')
          .eq('session_mode', sessionMode)
          .or(`score.gt.${session.score},and(score.eq.${session.score},total_time_ms.lt.${session.total_time_ms})`);
        return jsonResponse({
          score_id: existing?.id ?? null,
          rank: (count ?? 0) + 1,
          already_posted: true,
        });
      }
      return errorResponse(500, `Failed to insert score: ${insErr.message}`);
    }

    // Rank within the same mode + session_mode board.
    const { count } = await db
      .from('scores')
      .select('*', { count: 'exact', head: true })
      .eq('mode', 'solo')
      .eq('session_mode', sessionMode)
      .or(`score.gt.${session.score},and(score.eq.${session.score},total_time_ms.lt.${session.total_time_ms})`);

    return jsonResponse({
      score_id: inserted.id,
      rank: (count ?? 0) + 1,
    });
  }

  // Multiplayer mode: session_id is the room_id.
  const { data: room, error: roomErr } = await db
    .from('rooms')
    .select('status, category, difficulty, pace, question_count, session_mode, mp_variant, current_q_index')
    .eq('id', session_id)
    .single();
  if (roomErr || !room) return errorResponse(404, 'Room not found');
  if (room.status !== 'finished') return errorResponse(409, `Room is ${room.status}, cannot post score`);

  const { data: player, error: playerErr } = await db
    .from('room_players')
    .select('score, correct_count')
    .eq('room_id', session_id)
    .eq('player_uuid', player_uuid)
    .single();
  if (playerErr || !player) return errorResponse(404, 'Player not in room');

  const { data: answers } = await db
    .from('room_answers')
    .select('time_ms')
    .eq('room_id', session_id)
    .eq('player_uuid', player_uuid);
  const totalTimeMs = (answers ?? []).reduce((acc, row) => acc + (row.time_ms ?? 0), 0);
  if (totalTimeMs <= 0) return errorResponse(409, 'No valid timing data');

  const sessionMode = (room.session_mode as SessionMode) ?? 'fixed';
  const questionCount = sessionMode === 'endless'
    ? ((answers ?? []).length || (room.current_q_index as number))
    : (room.question_count as number);

  const check = validateScoreSubmission({
    score: player.score,
    questionCount,
    difficulty: room.difficulty as Difficulty,
    pace: room.pace as Pace,
    totalTimeMs,
    sessionMode,
  });
  if (!check.ok) return errorResponse(400, `Score validation failed: ${check.reason}`);

  const { data: inserted, error: insErr } = await db
    .from('scores')
    .insert({
      username: username.trim(),
      score: player.score,
      category: room.category,
      difficulty: room.difficulty,
      pace: room.pace,
      question_count: questionCount,
      total_time_ms: totalTimeMs,
      mode: 'multiplayer',
      session_mode: sessionMode,
      mp_variant: room.mp_variant ?? null,
      source_session_id: session_id,
    })
    .select('id')
    .single();

  if (insErr) {
    if (insErr.code === '23505') {
      const { data: existing } = await db
        .from('scores')
        .select('id')
        .eq('source_session_id', session_id)
        .eq('mode', 'multiplayer')
        .maybeSingle();
      const { count } = await db
        .from('scores')
        .select('*', { count: 'exact', head: true })
        .eq('mode', 'multiplayer')
        .eq('session_mode', sessionMode)
        .or(`score.gt.${player.score},and(score.eq.${player.score},total_time_ms.lt.${totalTimeMs})`);
      return jsonResponse({
        score_id: existing?.id ?? null,
        rank: (count ?? 0) + 1,
        already_posted: true,
      });
    }
    return errorResponse(500, `Failed to insert score: ${insErr.message}`);
  }

  const { count } = await db
    .from('scores')
    .select('*', { count: 'exact', head: true })
    .eq('mode', 'multiplayer')
    .eq('session_mode', sessionMode)
    .or(`score.gt.${player.score},and(score.eq.${player.score},total_time_ms.lt.${totalTimeMs})`);

  return jsonResponse({
    score_id: inserted.id,
    rank: (count ?? 0) + 1,
  });
});

import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { room_code, player_uuid, username } = body as {
    room_code?: string;
    player_uuid?: string;
    username?: string;
  };

  if (!room_code || typeof room_code !== 'string') return errorResponse(400, 'room_code required');
  if (!player_uuid || typeof player_uuid !== 'string') return errorResponse(400, 'player_uuid required');
  if (!username || typeof username !== 'string' || username.length > 40) return errorResponse(400, 'username required');

  const normalizedCode = room_code.trim().toUpperCase();
  const trimmedUsername = username.trim();

  const db = adminClient();

  const { data: room, error: roomErr } = await db
    .from('rooms')
    .select('id, status, max_players, category, difficulty, pace, question_count, host_player_uuid, session_mode, mp_variant')
    .eq('room_code', normalizedCode)
    .single();

  if (roomErr || !room) return errorResponse(404, 'Room not found');
  if (room.status !== 'lobby' && room.status !== 'category_select') {
    return errorResponse(409, `Room is ${room.status}, cannot join`);
  }

  // Re-join case: if this player_uuid already has a row in the room, return the
  // existing state idempotently rather than erroring.
  const { data: existing } = await db
    .from('room_players')
    .select('id, display_username, score, streak, is_host')
    .eq('room_id', room.id)
    .eq('player_uuid', player_uuid)
    .maybeSingle();

  if (existing) {
    // Refresh last_seen_at to mark the player as active.
    await db.from('room_players').update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
    return jsonResponse({
      room_id: room.id,
      room_code: normalizedCode,
      status: room.status,
      display_username: existing.display_username,
      is_host: existing.is_host,
      difficulty: room.difficulty,
      pace: room.pace,
      question_count: room.question_count,
    });
  }

  // Enforce max_players (excluding this player since they're not in yet).
  const { count: playerCount } = await db
    .from('room_players')
    .select('*', { count: 'exact', head: true })
    .eq('room_id', room.id);
  if ((playerCount ?? 0) >= room.max_players) {
    return errorResponse(409, `Room is full (${room.max_players} max)`);
  }

  // Resolve username collision within this room by appending a numeric suffix.
  const { data: sameName } = await db
    .from('room_players')
    .select('display_username')
    .eq('room_id', room.id)
    .ilike('display_username', `${trimmedUsername}%`);

  let displayUsername = trimmedUsername;
  if (sameName && sameName.length > 0) {
    const taken = new Set(sameName.map((r) => r.display_username.toLowerCase()));
    if (taken.has(trimmedUsername.toLowerCase())) {
      let n = 2;
      while (taken.has(`${trimmedUsername.toLowerCase()} ${n}`)) n++;
      displayUsername = `${trimmedUsername} ${n}`;
    }
  }

  const insertRow: Record<string, unknown> = {
    room_id: room.id,
    player_uuid,
    username: trimmedUsername,
    display_username: displayUsername,
    is_host: false,
  };
  if (room.session_mode === 'endless' && room.mp_variant === 'battle_royale') {
    insertRow.lives_remaining = 3;
  }
  const { error: insErr } = await db.from('room_players').insert(insertRow);
  if (insErr) return errorResponse(500, `Failed to join: ${insErr.message}`);

  return jsonResponse({
    room_id: room.id,
    room_code: normalizedCode,
    status: room.status,
    display_username: displayUsername,
    is_host: false,
    difficulty: room.difficulty,
    pace: room.pace,
    question_count: room.question_count,
    session_mode: room.session_mode,
    mp_variant: room.mp_variant,
  });
});

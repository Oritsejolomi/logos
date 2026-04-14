import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

// Unambiguous alphabet: no 0/O, no 1/I/L. Keeps room codes shareable by voice.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const ENDLESS_STARTING_LIVES = 3;

function randomCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const {
    host_player_uuid, host_username,
    difficulty, pace = 'arcade', question_count, max_players = 50,
    session_mode = 'fixed',
    mp_variant,
  } = body as {
    host_player_uuid?: string;
    host_username?: string;
    difficulty?: string;
    pace?: string;
    question_count?: number;
    max_players?: number;
    session_mode?: string;
    mp_variant?: string;
  };

  if (!host_player_uuid || typeof host_player_uuid !== 'string') return errorResponse(400, 'host_player_uuid required');
  if (!host_username || typeof host_username !== 'string' || host_username.length > 40) return errorResponse(400, 'host_username required');
  if (!['beginner','intermediate','advanced'].includes(difficulty ?? '')) return errorResponse(400, 'invalid difficulty');
  if (!['speedy','arcade','meditative'].includes(pace)) return errorResponse(400, 'invalid pace');
  if (!['fixed','endless'].includes(session_mode)) return errorResponse(400, 'invalid session_mode');

  const isEndless = session_mode === 'endless';
  if (!isEndless && ![5,10,15].includes(question_count ?? 0)) {
    return errorResponse(400, 'question_count must be 5/10/15 in fixed mode');
  }
  if (isEndless && !['battle_royale','co_op'].includes(mp_variant ?? '')) {
    return errorResponse(400, 'mp_variant must be battle_royale or co_op for endless rooms');
  }
  if (max_players < 2 || max_players > 50) return errorResponse(400, 'max_players must be 2-50');

  const db = adminClient();

  const roomInsert: Record<string, unknown> = {
    status: 'lobby',
    difficulty,
    pace,
    max_players,
    host_player_uuid,
    session_mode,
  };
  if (isEndless) {
    roomInsert.mp_variant = mp_variant;
    roomInsert.question_count = null;
    // Co-op rooms share a pool of lives across the team. Battle royale gives
    // each player their own lives (stored on room_players).
    if (mp_variant === 'co_op') {
      roomInsert.shared_lives = ENDLESS_STARTING_LIVES;
    }
  } else {
    roomInsert.question_count = question_count;
  }

  // Insert the room, retrying on room_code collisions.
  let roomRow: { id: string; room_code: string } | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const { data, error } = await db
      .from('rooms')
      .insert({ ...roomInsert, room_code: code })
      .select('id, room_code')
      .single();
    if (!error && data) { roomRow = data; break; }
    if (error && error.code !== '23505') {
      return errorResponse(500, `Failed to create room: ${error.message}`);
    }
  }
  if (!roomRow) return errorResponse(503, 'Could not allocate a unique room code, please retry');

  // Insert the host as the first room_player. Battle royale players each start
  // with their own lives; co-op players share the room pool so their personal
  // counter stays null.
  const hostPlayer: Record<string, unknown> = {
    room_id: roomRow.id,
    player_uuid: host_player_uuid,
    username: host_username.trim(),
    display_username: host_username.trim(),
    is_host: true,
  };
  if (isEndless && mp_variant === 'battle_royale') {
    hostPlayer.lives_remaining = ENDLESS_STARTING_LIVES;
  }
  const { error: rpErr } = await db.from('room_players').insert(hostPlayer);
  if (rpErr) return errorResponse(500, `Failed to add host: ${rpErr.message}`);

  return jsonResponse({
    room_id: roomRow.id,
    room_code: roomRow.room_code,
  });
});

import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

// Unambiguous alphabet: no 0/O, no 1/I/L. Keeps room codes shareable by voice.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

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
  } = body as {
    host_player_uuid?: string;
    host_username?: string;
    difficulty?: string;
    pace?: string;
    question_count?: number;
    max_players?: number;
  };

  if (!host_player_uuid || typeof host_player_uuid !== 'string') return errorResponse(400, 'host_player_uuid required');
  if (!host_username || typeof host_username !== 'string' || host_username.length > 40) return errorResponse(400, 'host_username required');
  if (!['beginner','intermediate','advanced'].includes(difficulty ?? '')) return errorResponse(400, 'invalid difficulty');
  if (!['speedy','arcade','meditative'].includes(pace)) return errorResponse(400, 'invalid pace');
  if (![5,10,15].includes(question_count ?? 0)) return errorResponse(400, 'question_count must be 5/10/15');
  if (max_players < 2 || max_players > 50) return errorResponse(400, 'max_players must be 2-50');

  const db = adminClient();

  // Insert the room, retrying on room_code collisions.
  let roomRow: { id: string; room_code: string } | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const { data, error } = await db
      .from('rooms')
      .insert({
        room_code: code,
        status: 'lobby',
        difficulty,
        pace,
        question_count,
        max_players,
        host_player_uuid,
      })
      .select('id, room_code')
      .single();
    if (!error && data) { roomRow = data; break; }
    if (error && error.code !== '23505') {
      return errorResponse(500, `Failed to create room: ${error.message}`);
    }
  }
  if (!roomRow) return errorResponse(503, 'Could not allocate a unique room code, please retry');

  // Insert the host as the first room_player.
  const { error: rpErr } = await db.from('room_players').insert({
    room_id: roomRow.id,
    player_uuid: host_player_uuid,
    username: host_username.trim(),
    display_username: host_username.trim(),
    is_host: true,
  });
  if (rpErr) return errorResponse(500, `Failed to add host: ${rpErr.message}`);

  return jsonResponse({
    room_id: roomRow.id,
    room_code: roomRow.room_code,
  });
});

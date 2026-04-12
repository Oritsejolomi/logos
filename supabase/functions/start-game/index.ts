import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

const CATEGORY_SELECT_SECONDS = 10;

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { room_id, player_uuid } = body as { room_id?: string; player_uuid?: string };
  if (!room_id || !player_uuid) return errorResponse(400, 'room_id and player_uuid required');

  const db = adminClient();

  const { data: room, error: roomErr } = await db
    .from('rooms')
    .select('status, host_player_uuid')
    .eq('id', room_id)
    .single();
  if (roomErr || !room) return errorResponse(404, 'Room not found');
  if (room.host_player_uuid !== player_uuid) return errorResponse(403, 'Only the host can start the game');
  if (room.status !== 'lobby') return errorResponse(409, `Room is ${room.status}, cannot start from here`);

  // Conditional UPDATE so two simultaneous start clicks don't both succeed.
  const endsAt = new Date(Date.now() + CATEGORY_SELECT_SECONDS * 1000).toISOString();
  const { data: updated, error: updErr } = await db
    .from('rooms')
    .update({
      status: 'category_select',
      category_select_ends_at: endsAt,
    })
    .eq('id', room_id)
    .eq('status', 'lobby')
    .select('id, status, category_select_ends_at')
    .single();

  if (updErr || !updated) return errorResponse(409, 'Room state changed, refresh');

  return jsonResponse({
    status: updated.status,
    category_select_ends_at: updated.category_select_ends_at,
    category_select_seconds: CATEGORY_SELECT_SECONDS,
  });
});

import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

const CATEGORIES = new Set([
  'Old Testament',
  'New Testament',
  'Prophets',
  'Psalms & Wisdom',
  'Parables',
  "Paul's Letters",
  'Theology',
  'Church History',
]);

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { room_id, player_uuid, category } = body as {
    room_id?: string;
    player_uuid?: string;
    category?: string;
  };

  if (!room_id || !player_uuid) return errorResponse(400, 'room_id and player_uuid required');
  if (!category || !CATEGORIES.has(category)) return errorResponse(400, 'unknown category');

  const db = adminClient();

  const { data: room } = await db
    .from('rooms')
    .select('status')
    .eq('id', room_id)
    .single();
  if (!room) return errorResponse(404, 'Room not found');
  if (room.status !== 'category_select') return errorResponse(409, `Room is ${room.status}, not in category select`);

  const { error: updErr } = await db
    .from('room_players')
    .update({
      category_pick: category,
      has_picked: true,
      last_seen_at: new Date().toISOString(),
    })
    .eq('room_id', room_id)
    .eq('player_uuid', player_uuid);

  if (updErr) return errorResponse(500, `Failed to record pick: ${updErr.message}`);

  return jsonResponse({ ok: true, category });
});

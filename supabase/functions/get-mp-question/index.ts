import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

// Returns the currently-active question for a multiplayer room. Intentionally
// omits correct_index and insight — those are only revealed via the
// round_closed broadcast from tick-room after the round ends.

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
    .select('status, question_ids, current_q_index, current_q_opened_at, current_q_ends_at, question_count')
    .eq('id', room_id)
    .single();

  if (roomErr || !room) return errorResponse(404, 'Room not found');
  if (room.status !== 'in_progress') return errorResponse(409, `Room is ${room.status}`);
  if (!room.question_ids || room.question_ids.length === 0) return errorResponse(500, 'Room has no questions');

  const idx = room.current_q_index;
  if (idx >= room.question_ids.length) return errorResponse(409, 'All questions consumed');

  const questionId = room.question_ids[idx];
  const { data: q, error: qErr } = await db
    .from('questions')
    .select('id, question_text, options, scripture_ref')
    .eq('id', questionId)
    .single();

  if (qErr || !q) return errorResponse(500, 'Question missing');

  return jsonResponse({
    question_id: q.id,
    question_index: idx,
    question_text: q.question_text,
    options: q.options,
    scripture_ref: q.scripture_ref,
    opened_at: room.current_q_opened_at,
    ends_at: room.current_q_ends_at,
    question_count: room.question_count,
  });
});

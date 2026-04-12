import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

// Returns the safe display fields of a solo_sessions row. Used by the client
// to recover after a refresh / direct URL hit to a finished session.

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { session_id, player_uuid } = body as { session_id?: string; player_uuid?: string };
  if (!session_id || !player_uuid) return errorResponse(400, 'session_id and player_uuid required');

  const db = adminClient();
  const { data, error } = await db
    .from('solo_sessions')
    .select('id, category, difficulty, pace, question_count, status, current_q_index, score, streak, total_time_ms')
    .eq('id', session_id)
    .eq('player_uuid', player_uuid)
    .single();

  if (error || !data) return errorResponse(404, 'Session not found');

  return jsonResponse({
    session_id: data.id,
    category: data.category,
    difficulty: data.difficulty,
    pace: data.pace,
    question_count: data.question_count,
    status: data.status,
    current_q_index: data.current_q_index,
    score: data.score,
    streak: data.streak,
    total_time_ms: data.total_time_ms,
  });
});

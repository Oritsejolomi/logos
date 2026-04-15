import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  const url = new URL(req.url);
  const username = url.searchParams.get('username');
  if (!username || !username.trim()) return errorResponse(400, 'username is required');

  const db = adminClient();
  const { data, error } = await db
    .from('scores')
    .select('id, username, score, category, difficulty, pace, question_count, total_time_ms, mode, session_mode, mp_variant, created_at')
    .ilike('username', username.trim())
    .order('score', { ascending: false })
    .order('total_time_ms', { ascending: true })
    .limit(200);

  if (error) return errorResponse(500, error.message);

  return jsonResponse({ scores: data ?? [] });
});

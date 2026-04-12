import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitParam ?? '100', 10) || 100, 1), 100);

  const db = adminClient();
  const { data, error } = await db
    .from('scores')
    .select('id, username, score, category, difficulty, pace, question_count, total_time_ms, mode, created_at')
    .order('score', { ascending: false })
    .order('total_time_ms', { ascending: true })
    .limit(limit);

  if (error) return errorResponse(500, error.message);

  return jsonResponse({ scores: data ?? [] });
});

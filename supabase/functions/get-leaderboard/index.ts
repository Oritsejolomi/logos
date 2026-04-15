import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitParam ?? '100', 10) || 100, 1), 100);

  const db = adminClient();
  // Fetch a larger set so we can deduplicate per-username and still have
  // enough rows to fill the requested limit after deduplication.
  const { data, error } = await db
    .from('scores')
    .select('id, username, score, category, difficulty, pace, question_count, total_time_ms, mode, session_mode, mp_variant, created_at')
    .order('score', { ascending: false })
    .order('total_time_ms', { ascending: true })
    .limit(2000);

  if (error) return errorResponse(500, error.message);

  // Keep only each user's best score (first occurrence, since sorted by score DESC).
  const seen = new Set<string>();
  const deduped: typeof data = [];
  for (const row of data ?? []) {
    const key = row.username.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
      if (deduped.length >= limit) break;
    }
  }

  return jsonResponse({ scores: deduped });
});

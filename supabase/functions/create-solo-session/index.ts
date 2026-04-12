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
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { player_uuid, username, category, difficulty, pace = 'arcade', question_count } = body as {
    player_uuid?: string;
    username?: string;
    category?: string;
    difficulty?: string;
    pace?: string;
    question_count?: number;
  };

  if (!player_uuid || typeof player_uuid !== 'string') return errorResponse(400, 'player_uuid required');
  if (!username || typeof username !== 'string' || username.length > 40) return errorResponse(400, 'username required (<=40 chars)');
  if (!category || !CATEGORIES.has(category)) return errorResponse(400, 'unknown category');
  if (!['beginner', 'intermediate', 'advanced'].includes(difficulty ?? '')) return errorResponse(400, 'invalid difficulty');
  if (!['speedy', 'arcade', 'meditative'].includes(pace)) return errorResponse(400, 'invalid pace');
  if (![5, 10, 15].includes(question_count ?? 0)) return errorResponse(400, 'question_count must be 5/10/15');

  const db = adminClient();

  // Abandon any prior active sessions for this player — defensive cleanup.
  await db
    .from('solo_sessions')
    .update({ status: 'abandoned' })
    .eq('player_uuid', player_uuid)
    .eq('status', 'active');

  // Pre-fill the queue from the bank: pick as many distinct-passage questions
  // as we can find without any Gemini calls. Any remaining slots will be
  // filled by queue-solo-questions which the client fires after Q1 loads.
  const filledIds: string[] = [];
  const filledPassageKeys = new Set<string>();
  const filledIdSet = new Set<string>();

  const passageKey = (ref: string) =>
    ref.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:\-–,].*$/, '').trim();

  for (let i = 0; i < (question_count as number); i++) {
    let query = db
      .from('questions')
      .select('id, scripture_ref')
      .eq('category', category)
      .eq('difficulty', difficulty)
      .is('deleted_at', null)
      .order('quality_score', { ascending: false })
      .limit(100);
    const excludeList = [...filledIdSet];
    if (excludeList.length > 0) query = query.not('id', 'in', `(${excludeList.map((id) => `"${id}"`).join(',')})`);
    const { data: bankRows } = await query;
    if (!bankRows) break;
    const fresh = bankRows.find((r) => !filledPassageKeys.has(passageKey(r.scripture_ref)));
    if (!fresh) break;
    filledIds.push(fresh.id);
    filledIdSet.add(fresh.id);
    filledPassageKeys.add(passageKey(fresh.scripture_ref));
  }

  const { data, error } = await db
    .from('solo_sessions')
    .insert({
      player_uuid,
      username: username.trim(),
      category,
      difficulty,
      pace,
      question_count,
      queued_question_ids: filledIds,
    })
    .select('id')
    .single();

  if (error) return errorResponse(500, 'Failed to create session', { detail: error.message });

  return jsonResponse({
    session_id: data.id,
    queued_from_bank: filledIds.length,
    needs_generation: (question_count as number) - filledIds.length,
  });
});

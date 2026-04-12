import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { sanitizeRecentHashes, sha256Hex } from '../_shared/dedup.ts';
import { generateQuestion } from '../_shared/gemini.ts';
import { verseLookup } from '../_shared/bible-lookup.ts';
import type { Difficulty } from '../_shared/scoring.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { session_id, player_uuid, recent_hashes } = body as {
    session_id?: string;
    player_uuid?: string;
    recent_hashes?: unknown;
  };

  if (!session_id || !player_uuid) return errorResponse(400, 'session_id and player_uuid required');

  const db = adminClient();
  const { data: session } = await db
    .from('solo_sessions')
    .select('*')
    .eq('id', session_id)
    .eq('player_uuid', player_uuid)
    .single();

  if (!session) return errorResponse(404, 'Session not found');
  if (session.status !== 'active') return jsonResponse({ ok: true, skipped: 'session not active' });
  if (session.prefetched_question_id) return jsonResponse({ ok: true, skipped: 'already prefetched' });
  if (session.current_q_index + 1 >= session.question_count) return jsonResponse({ ok: true, skipped: 'last question' });

  const cleanedHashes = sanitizeRecentHashes(recent_hashes);
  const servedIds: string[] = session.served_question_ids ?? [];

  // Prefer the bank (excluding within-session duplicates).
  let bankQuery = db
    .from('questions')
    .select('id, content_hash_16')
    .eq('category', session.category)
    .eq('difficulty', session.difficulty)
    .is('deleted_at', null)
    .order('quality_score', { ascending: false })
    .limit(40);
  if (servedIds.length > 0) bankQuery = bankQuery.not('id', 'in', `(${servedIds.map((id) => `"${id}"`).join(',')})`);
  const { data: bankRows } = await bankQuery;

  let questionId: string | null = null;
  if (bankRows) {
    const fresh = bankRows.filter((r) => !cleanedHashes.includes(r.content_hash_16));
    if (fresh.length > 0) questionId = fresh[Math.floor(Math.random() * Math.min(fresh.length, 10))].id;
  }

  if (!questionId) {
    let avoidPassages: string[] = [];
    if (servedIds.length > 0) {
      const { data: servedRows } = await db
        .from('questions')
        .select('scripture_ref')
        .in('id', servedIds);
      avoidPassages = (servedRows ?? []).map((r) => r.scripture_ref).filter((s): s is string => !!s);
    }

    try {
      const generated = await generateQuestion(
        {
          category: session.category,
          difficulty: session.difficulty as Difficulty,
          recentHashes: cleanedHashes,
          avoidPassages,
        },
        verseLookup,
      );
      const content_hash = await sha256Hex(generated.question);
      const { data: inserted, error } = await db
        .from('questions')
        .insert({
          category: session.category,
          difficulty: session.difficulty,
          question_text: generated.question,
          options: generated.options,
          correct_index: generated.correct_index,
          scripture_ref: generated.scripture_ref,
          insight: generated.insight,
          content_hash,
        })
        .select('id')
        .single();
      if (error && error.code === '23505') {
        const { data: existing } = await db
          .from('questions')
          .select('id')
          .eq('content_hash', content_hash)
          .single();
        questionId = existing?.id ?? null;
      } else if (inserted) {
        questionId = inserted.id;
      }
    } catch {
      return jsonResponse({ ok: false, skipped: 'generation failed, client will retry on next fetch' });
    }
  }

  if (!questionId) return jsonResponse({ ok: false });

  await db
    .from('solo_sessions')
    .update({ prefetched_question_id: questionId })
    .eq('id', session_id)
    .is('prefetched_question_id', null);

  return jsonResponse({ ok: true });
});

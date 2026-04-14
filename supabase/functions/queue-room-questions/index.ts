import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { generateQuestion } from '../_shared/gemini.ts';
import { verseLookup } from '../_shared/bible-lookup.ts';
import { sha256Hex } from '../_shared/dedup.ts';
import type { Difficulty } from '../_shared/scoring.ts';
import { rampingStateAt } from '../_shared/ramping.ts';

// Rolling top-up for endless MP rooms. Keeps the room's question_ids array
// BUFFER questions ahead of current_q_index. Client fires this after each
// round closes. Fire-and-forget from the client.

const BUFFER = 15;

function passageKey(ref: string): string {
  return ref.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:\-–,].*$/, '').trim();
}

async function bankLookupExcluding(
  db: ReturnType<typeof adminClient>,
  category: string,
  difficulty: Difficulty,
  excludeIds: Set<string>,
  excludePassageKeys: Set<string>,
): Promise<{ id: string; scripture_ref: string } | null> {
  let query = db
    .from('questions')
    .select('id, scripture_ref')
    .eq('category', category)
    .eq('difficulty', difficulty)
    .is('deleted_at', null)
    .order('quality_score', { ascending: false })
    .limit(80);
  const excludeList = [...excludeIds];
  if (excludeList.length > 0) query = query.not('id', 'in', `(${excludeList.map((id) => `"${id}"`).join(',')})`);
  const { data } = await query;
  if (!data) return null;
  for (const row of data) {
    if (!excludePassageKeys.has(passageKey(row.scripture_ref))) return row;
  }
  return null;
}

function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchBankAnswerKeys(
  db: ReturnType<typeof adminClient>,
  category: string,
  difficulty: Difficulty,
): Promise<string[]> {
  const { data } = await db
    .from('questions')
    .select('options, correct_index')
    .eq('category', category)
    .eq('difficulty', difficulty)
    .is('deleted_at', null)
    .order('quality_score', { ascending: false })
    .limit(80);
  if (!data) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of data) {
    if (!Array.isArray(r.options) || typeof r.correct_index !== 'number') continue;
    const ans = normalizeAnswer(r.options[r.correct_index] ?? '');
    if (!ans || seen.has(ans)) continue;
    seen.add(ans);
    out.push(ans);
  }
  return out;
}

async function generateOne(
  db: ReturnType<typeof adminClient>,
  category: string,
  difficulty: Difficulty,
  avoidPassages: string[],
  avoidAnswerKeys: string[],
  endlessDepth: number,
): Promise<{ id: string; scripture_ref: string } | null> {
  try {
    const generated = await generateQuestion(
      { category, difficulty, recentHashes: [], avoidPassages, avoidAnswerKeys, endlessDepth },
      verseLookup,
    );
    const content_hash = await sha256Hex(generated.question);
    const { data, error } = await db
      .from('questions')
      .insert({
        category,
        difficulty,
        question_text: generated.question,
        options: generated.options,
        correct_index: generated.correct_index,
        scripture_ref: generated.scripture_ref,
        insight: generated.insight,
        content_hash,
      })
      .select('id, scripture_ref')
      .single();
    if (error && error.code === '23505') {
      const { data: existing } = await db
        .from('questions')
        .select('id, scripture_ref')
        .eq('content_hash', content_hash)
        .single();
      return existing ?? null;
    }
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { room_id } = body as { room_id?: string };
  if (!room_id) return errorResponse(400, 'room_id required');

  const db = adminClient();

  const { data: room } = await db.from('rooms').select('*').eq('id', room_id).single();
  if (!room) return errorResponse(404, 'Room not found');
  if (room.session_mode !== 'endless') return jsonResponse({ ok: true, noop: 'not endless' });
  if (room.status !== 'in_progress') return jsonResponse({ ok: true, skipped: `status=${room.status}` });

  const currentIds: string[] = (room.question_ids as string[]) ?? [];
  const currentIdx: number = (room.current_q_index as number) ?? 0;
  const target = currentIdx + BUFFER;
  if (currentIds.length >= target) return jsonResponse({ ok: true, already_full: true, length: currentIds.length });

  // Idempotent lock via generation_started_at.
  const { data: locked } = await db
    .from('rooms')
    .update({ generation_started_at: new Date().toISOString() })
    .eq('id', room_id)
    .or('generation_started_at.is.null,generation_started_at.lt.' + new Date(Date.now() - 60_000).toISOString())
    .select('id')
    .single();
  if (!locked) return jsonResponse({ ok: true, noop: 'already queueing' });

  const pickedDifficulty = room.difficulty as Difficulty;
  const chosenIds: string[] = [...currentIds];
  const chosenIdSet = new Set<string>(chosenIds);
  const passageKeys = new Set<string>();

  // Build passage-key exclusion from already-chosen questions.
  if (chosenIds.length > 0) {
    const { data: rows } = await db
      .from('questions')
      .select('scripture_ref')
      .in('id', chosenIds);
    for (const r of rows ?? []) if (r.scripture_ref) passageKeys.add(passageKey(r.scripture_ref));
  }

  const slotsToFill = target - chosenIds.length;

  // Phase 1: bank (depth 0 only).
  for (let i = 0; i < slotsToFill; i++) {
    const absIdx = chosenIds.length;
    const slot = rampingStateAt(pickedDifficulty, absIdx);
    if (slot.endlessDepth > 0) continue;
    const hit = await bankLookupExcluding(db, room.category as string, slot.difficulty, chosenIdSet, passageKeys);
    if (!hit) continue;
    chosenIds.push(hit.id);
    chosenIdSet.add(hit.id);
    passageKeys.add(passageKey(hit.scripture_ref));
  }

  // Phase 2: parallel generation for any remaining slots.
  const stillNeeded = target - chosenIds.length;
  if (stillNeeded > 0) {
    const baseAvoid = [...passageKeys];
    const genStartIdx = chosenIds.length;
    const genSlots = Array.from({ length: stillNeeded }, (_, i) => rampingStateAt(pickedDifficulty, genStartIdx + i));
    const bankKeyCache = new Map<string, string[]>();
    const fetchBankKeys = async (diff: Difficulty): Promise<string[]> => {
      let v = bankKeyCache.get(diff);
      if (!v) {
        v = await fetchBankAnswerKeys(db, room.category as string, diff);
        bankKeyCache.set(diff, v);
      }
      return v;
    };
    const results = await Promise.allSettled(
      genSlots.map(async (slot) => {
        const bankKeys = await fetchBankKeys(slot.difficulty);
        return generateOne(db, room.category as string, slot.difficulty, baseAvoid, bankKeys, slot.endlessDepth);
      }),
    );
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (chosenIdSet.has(r.value.id)) continue;
      const k = passageKey(r.value.scripture_ref);
      if (passageKeys.has(k)) continue;
      chosenIds.push(r.value.id);
      chosenIdSet.add(r.value.id);
      passageKeys.add(k);
    }
  }

  const { error: updErr } = await db
    .from('rooms')
    .update({ question_ids: chosenIds, generation_started_at: null })
    .eq('id', room_id);
  if (updErr) return errorResponse(500, `Failed to update question_ids: ${updErr.message}`);

  return jsonResponse({ ok: true, length: chosenIds.length, target });
});

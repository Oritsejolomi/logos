import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { generateQuestion } from '../_shared/gemini.ts';
import { verseLookup } from '../_shared/bible-lookup.ts';
import { sha256Hex } from '../_shared/dedup.ts';
import { TIMER_SECONDS, type Difficulty, type Pace } from '../_shared/scoring.ts';

// Idempotent question generator for a room. Any client can call this after
// tick-room transitions the room to 'generating'. A conditional UPDATE on
// generation_started_at serves as a lock so only one invocation does the work.

function passageKey(ref: string): string {
  return ref.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:\-–,].*$/, '').trim();
}

async function bankLookupExcluding(
  category: string,
  difficulty: Difficulty,
  excludeIds: Set<string>,
  excludePassageKeys: Set<string>,
): Promise<{ id: string; scripture_ref: string } | null> {
  const db = adminClient();
  const excludeList = [...excludeIds];
  let query = db
    .from('questions')
    .select('id, scripture_ref')
    .eq('category', category)
    .eq('difficulty', difficulty)
    .is('deleted_at', null)
    .order('quality_score', { ascending: false })
    .limit(80);
  if (excludeList.length > 0) {
    query = query.not('id', 'in', `(${excludeList.map((id) => `"${id}"`).join(',')})`);
  }
  const { data } = await query;
  if (!data) return null;
  for (const row of data) {
    if (!excludePassageKeys.has(passageKey(row.scripture_ref))) return row;
  }
  return null;
}

async function generateOne(
  category: string,
  difficulty: Difficulty,
  avoidPassages: string[],
): Promise<{ id: string; scripture_ref: string } | null> {
  const db = adminClient();
  try {
    const generated = await generateQuestion(
      { category, difficulty, recentHashes: [], avoidPassages },
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
  if (room.status === 'in_progress') return jsonResponse({ ok: true, already_started: true });
  if (room.status !== 'generating') return errorResponse(409, `Room is ${room.status}, not generating`);
  if (!room.category) return errorResponse(500, 'Room has no category');

  // Idempotent lock. Only one invocation gets to do the work; others see the
  // row already has generation_started_at within the last 60s and wait.
  const { data: locked } = await db
    .from('rooms')
    .update({ generation_started_at: new Date().toISOString() })
    .eq('id', room_id)
    .eq('status', 'generating')
    .or('generation_started_at.is.null,generation_started_at.lt.' + new Date(Date.now() - 60_000).toISOString())
    .select('id')
    .single();

  if (!locked) return jsonResponse({ ok: true, noop: 'already generating' });

  // Collect N questions with diversity. First drain the bank sequentially so
  // each bank pick can exclude the previous one. Then parallel-generate the
  // remaining slots — independent Gemini calls run concurrently, which is
  // crucial for meeting a reasonable "preparing arena" window.
  const needed = room.question_count;
  const chosenIds: string[] = [];
  const chosenIdSet = new Set<string>();
  const passageKeys = new Set<string>();

  // Phase 1: bank draining.
  while (chosenIds.length < needed) {
    const bankHit = await bankLookupExcluding(
      room.category,
      room.difficulty as Difficulty,
      chosenIdSet,
      passageKeys,
    );
    if (!bankHit) break;
    chosenIds.push(bankHit.id);
    chosenIdSet.add(bankHit.id);
    passageKeys.add(passageKey(bankHit.scripture_ref));
  }

  // Phase 2: parallel generation of remaining slots. Pass a frozen copy of the
  // passage avoidance set to each call so they all avoid the same baseline.
  const remaining = needed - chosenIds.length;
  if (remaining > 0) {
    const baseAvoid = [...passageKeys];
    const results = await Promise.allSettled(
      Array.from({ length: remaining }, () =>
        generateOne(room.category, room.difficulty as Difficulty, baseAvoid),
      ),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        // Skip any duplicate id or passage that other parallel calls already added.
        if (chosenIdSet.has(r.value.id)) continue;
        const k = passageKey(r.value.scripture_ref);
        if (passageKeys.has(k)) continue;
        chosenIds.push(r.value.id);
        chosenIdSet.add(r.value.id);
        passageKeys.add(k);
      }
    }
  }

  if (chosenIds.length < needed) {
    // Release the lock so a future client attempt can retry.
    await db.from('rooms').update({ generation_started_at: null }).eq('id', room_id);
    return errorResponse(503, `Only generated ${chosenIds.length}/${needed} questions, retry`);
  }

  const timerSecs = TIMER_SECONDS[room.pace as Pace][room.difficulty as Difficulty];
  const now = Date.now();
  const INSIGHT = 3_000; // small lead-in before first question so clients render
  const openedAt = new Date(now + INSIGHT).toISOString();
  const endsAt = new Date(now + INSIGHT + timerSecs * 1000).toISOString();

  const { data: started, error: startErr } = await db
    .from('rooms')
    .update({
      status: 'in_progress',
      question_ids: chosenIds,
      current_q_index: 0,
      current_q_opened_at: openedAt,
      current_q_ends_at: endsAt,
    })
    .eq('id', room_id)
    .eq('status', 'generating')
    .select('id, current_q_opened_at, current_q_ends_at')
    .single();

  if (startErr || !started) return errorResponse(500, 'Failed to transition to in_progress');

  return jsonResponse({
    ok: true,
    question_count: chosenIds.length,
    current_q_opened_at: started.current_q_opened_at,
    current_q_ends_at: started.current_q_ends_at,
  });
});

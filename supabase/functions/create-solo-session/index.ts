import { adminClient, handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { sanitizeRecentHashes } from '../_shared/dedup.ts';
import { rampingStateAt } from '../_shared/ramping.ts';
import type { Difficulty } from '../_shared/scoring.ts';

const CONCRETE_CATEGORIES = [
  'Old Testament',
  'New Testament',
  'Prophets',
  'Psalms & Wisdom',
  'Parables',
  "Paul's Letters",
  'Theology',
  'Church History',
  'Life & Today',
];

const CATEGORIES = new Set([...CONCRETE_CATEGORIES, 'Random']);
const SESSION_MODES = new Set(['fixed', 'endless']);

// Rolling buffer size for endless sessions. queue-solo-questions keeps this
// many questions ahead of the player, topping up after every answer submit.
const ENDLESS_BUFFER = 5;
const ENDLESS_STARTING_LIVES = 3;

function pickRandomConcreteCategory(): string {
  return CONCRETE_CATEGORIES[Math.floor(Math.random() * CONCRETE_CATEGORIES.length)];
}

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

  const {
    player_uuid,
    username,
    category,
    difficulty,
    pace = 'arcade',
    question_count,
    recent_hashes,
    session_mode = 'fixed',
  } = body as {
    player_uuid?: string;
    username?: string;
    category?: string;
    difficulty?: string;
    pace?: string;
    question_count?: number;
    recent_hashes?: unknown;
    session_mode?: string;
  };

  if (!player_uuid || typeof player_uuid !== 'string') return errorResponse(400, 'player_uuid required');
  if (!username || typeof username !== 'string' || username.length > 40) return errorResponse(400, 'username required (<=40 chars)');
  if (!category || !CATEGORIES.has(category)) return errorResponse(400, 'unknown category');
  if (!['beginner', 'intermediate', 'advanced'].includes(difficulty ?? '')) return errorResponse(400, 'invalid difficulty');
  if (!['speedy', 'arcade', 'meditative'].includes(pace)) return errorResponse(400, 'invalid pace');
  if (!SESSION_MODES.has(session_mode)) return errorResponse(400, 'invalid session_mode');

  const isEndless = session_mode === 'endless';
  if (!isEndless && ![5, 10, 15].includes(question_count ?? 0)) {
    return errorResponse(400, 'question_count must be 5/10/15 in fixed mode');
  }

  const cleanedHashes = sanitizeRecentHashes(recent_hashes);
  const recentSet = new Set(cleanedHashes);

  const db = adminClient();

  // Abandon any prior active sessions for this player — defensive cleanup.
  await db
    .from('solo_sessions')
    .update({ status: 'abandoned' })
    .eq('player_uuid', player_uuid)
    .eq('status', 'active');

  // Both modes pre-fill from the bank when possible. The filter honors
  // recent_hashes so already-seen questions are excluded; freshness comes
  // from the dedup being correct, not from bypassing the bank.
  const slotsToFill = isEndless ? ENDLESS_BUFFER : (question_count as number);

  const filledIds: string[] = [];
  const filledPassageKeys = new Set<string>();
  const filledIdSet = new Set<string>();
  const isRandom = category === 'Random';
  const pickedDifficulty = difficulty as Difficulty;

  const passageKey = (ref: string) =>
    ref.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:\-–,].*$/, '').trim();

  // Answer-key dedup within the session: collapse near-dupe questions that
  // share a correct answer (e.g. three "first king of Israel" questions all
  // resolving to Saul, scattered across different chapters). The bank lookup
  // skips any candidate whose normalized correct answer matches one already
  // queued for this session.
  const filledAnswerKeys = new Set<string>();
  const normalizeAnswer = (s: string) =>
    s.trim().toLowerCase()
      .replace(/^(the|a|an)\s+/, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  let totalFilteredByHash = 0;
  let totalFilteredByAnswer = 0;
  let totalBankCandidates = 0;
  for (let i = 0; i < slotsToFill; i++) {
    const slotCategory = isRandom ? pickRandomConcreteCategory() : (category as string);
    // Endless sessions ramp difficulty with the slot index. Fixed sessions
    // always use the picked difficulty.
    const slotDifficulty = isEndless
      ? rampingStateAt(pickedDifficulty, i).difficulty
      : pickedDifficulty;
    // Endless depth > 0 means Gemini-only — the bank no sabi depth, so skip
    // bank pre-fill for those slots. queue-solo-questions will generate them.
    const slotDepth = isEndless ? rampingStateAt(pickedDifficulty, i).endlessDepth : 0;
    if (slotDepth > 0) continue;

    // Query a wide bank window so the hash filter has breathing room when the
    // player has seen many of the top-quality questions in this bracket. We
    // also fetch options + correct_index so we can dedup by answer text.
    let query = db
      .from('questions')
      .select('id, scripture_ref, content_hash_16, options, correct_index')
      .eq('category', slotCategory)
      .eq('difficulty', slotDifficulty)
      .is('deleted_at', null)
      .order('quality_score', { ascending: false })
      .limit(300);
    const excludeList = [...filledIdSet];
    if (excludeList.length > 0) query = query.not('id', 'in', `(${excludeList.map((id) => `"${id}"`).join(',')})`);
    const { data: bankRows } = await query;
    if (!bankRows || bankRows.length === 0) {
      if (isRandom || isEndless) continue;
      break;
    }
    totalBankCandidates += bankRows.length;
    const eligible = bankRows.filter((r) => {
      if (filledPassageKeys.has(passageKey(r.scripture_ref))) return false;
      if (r.content_hash_16 && recentSet.has(r.content_hash_16)) {
        totalFilteredByHash++;
        return false;
      }
      if (Array.isArray(r.options) && typeof r.correct_index === 'number') {
        const ans = normalizeAnswer(r.options[r.correct_index] ?? '');
        if (ans && filledAnswerKeys.has(ans)) {
          totalFilteredByAnswer++;
          return false;
        }
      }
      return true;
    });
    if (eligible.length === 0) {
      if (isRandom || isEndless) continue;
      break;
    }
    const windowSize = Math.min(eligible.length, 10);
    const fresh = eligible[Math.floor(Math.random() * windowSize)];
    filledIds.push(fresh.id);
    filledIdSet.add(fresh.id);
    filledPassageKeys.add(passageKey(fresh.scripture_ref));
    if (Array.isArray(fresh.options) && typeof fresh.correct_index === 'number') {
      const freshAns = normalizeAnswer(fresh.options[fresh.correct_index] ?? '');
      if (freshAns) filledAnswerKeys.add(freshAns);
    }
  }
  console.log(`[create-solo-session] mode=${session_mode} hashes_received=${cleanedHashes.length} bank_candidates=${totalBankCandidates} filtered_by_hash=${totalFilteredByHash} filtered_by_answer=${totalFilteredByAnswer} filled=${filledIds.length}/${slotsToFill}`);

  const insertPayload: Record<string, unknown> = {
    player_uuid,
    username: username.trim(),
    category,
    difficulty,
    pace,
    session_mode,
    queued_question_ids: filledIds,
  };
  if (isEndless) {
    insertPayload.lives_remaining = ENDLESS_STARTING_LIVES;
    insertPayload.question_count = null;
  } else {
    insertPayload.question_count = question_count;
  }

  const { data, error } = await db
    .from('solo_sessions')
    .insert(insertPayload)
    .select('id')
    .single();

  if (error) return errorResponse(500, 'Failed to create session', { detail: error.message });

  return jsonResponse({
    session_id: data.id,
    queued_from_bank: filledIds.length,
    needs_generation: slotsToFill - filledIds.length,
    session_mode,
    lives_remaining: isEndless ? ENDLESS_STARTING_LIVES : null,
    // Observability: confirms how many hashes the server received after
    // sanitization. If this is 0 while localStorage has history, the client
    // is not passing the hashes through.
    recent_hashes_received: cleanedHashes.length,
  });
});

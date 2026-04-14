// Typed wrappers around every Edge Function. All payload shapes live here so
// the rest of the app imports concrete types instead of stringly-typed blobs.
import { FUNCTIONS_BASE, SUPABASE_ANON_KEY } from './supabase';

// ----- Shared types ---------------------------------------------------------

export type Difficulty = 'beginner' | 'intermediate' | 'advanced';
export type Pace = 'speedy' | 'arcade' | 'meditative';
export type QuestionCount = 5 | 10 | 15;
export type SessionMode = 'fixed' | 'endless';
export type MpVariant = 'battle_royale' | 'co_op';

export const CATEGORIES = [
  'Old Testament',
  'New Testament',
  'Prophets',
  'Psalms & Wisdom',
  'Parables',
  "Paul's Letters",
  'Theology',
  'Church History',
  'Life & Today',
  'Random',
] as const;
export type Category = (typeof CATEGORIES)[number];

// ----- Transport ------------------------------------------------------------

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(
  name: string,
  body: Record<string, unknown>,
  init: { method?: 'POST' | 'GET' } = {},
): Promise<T> {
  const method = init.method ?? 'POST';
  const url = method === 'GET' && Object.keys(body).length > 0
    ? `${FUNCTIONS_BASE}/${name}?${new URLSearchParams(body as Record<string, string>).toString()}`
    : `${FUNCTIONS_BASE}/${name}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }

  if (!res.ok) {
    const message = typeof parsed === 'object' && parsed && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}

export { ApiError };

// ----- Solo -----------------------------------------------------------------

export interface SoloSessionHandle {
  session_id: string;
}

export function createSoloSession(args: {
  player_uuid: string;
  username: string;
  category: Category;
  difficulty: Difficulty;
  pace: Pace;
  question_count: QuestionCount | null;
  recent_hashes: string[];
  session_mode: SessionMode;
}): Promise<SoloSessionHandle & { session_mode: SessionMode; lives_remaining: number | null }> {
  return call('create-solo-session', args);
}

export interface SoloSessionState {
  session_id: string;
  category: Category;
  difficulty: Difficulty;
  pace: Pace;
  question_count: QuestionCount | null;
  session_mode: SessionMode;
  lives_remaining: number | null;
  correct_count: number;
  status: 'active' | 'finished' | 'abandoned';
  current_q_index: number;
  score: number;
  streak: number;
  total_time_ms: number;
}

export function getSoloState(args: {
  session_id: string;
  player_uuid: string;
}): Promise<SoloSessionState> {
  return call('get-solo-state', args);
}

export interface SoloQuestion {
  question_id: string;
  content_hash_16?: string;
  question_text: string;
  options: string[];
  scripture_ref: string;
  category?: Category;
  difficulty?: Difficulty;
  endless_depth?: number;
  lives_remaining?: number | null;
  question_index: number;
  opened_at: string;
  timer_seconds: number;
}

export function getSoloQuestion(args: {
  session_id: string;
  player_uuid: string;
  recent_hashes: string[];
}): Promise<SoloQuestion> {
  return call('get-question', args);
}

export interface SoloAnswerResult {
  is_correct: boolean;
  correct_index: number;
  points_awarded: number;
  base_points: number;
  speed_bonus: number;
  time_ms: number;
  new_score: number;
  new_streak: number;
  multiplier: number;
  insight: string;
  scripture_ref: string;
  session_status: 'active' | 'finished';
  next_question_index: number;
  total_time_ms: number;
  lives_remaining?: number | null;
  correct_count?: number;
}

export function submitSoloAnswer(args: {
  session_id: string;
  player_uuid: string;
  selected_index: number | null;
}): Promise<SoloAnswerResult> {
  return call('submit-answer', args);
}

export function prefetchNext(args: {
  session_id: string;
  player_uuid: string;
  recent_hashes: string[];
}): Promise<{ ok: boolean; skipped?: string }> {
  return call('prefetch-next', args);
}

export function queueSoloQuestions(args: {
  session_id: string;
  player_uuid: string;
  recent_hashes: string[];
}): Promise<{ ok: boolean; queued?: number; target?: number; already_full?: boolean; noop?: string }> {
  return call('queue-solo-questions', args);
}

// ----- Scores / leaderboard -------------------------------------------------

export interface PostScoreResult {
  score_id: string;
  rank: number;
}

export function postScore(args: {
  session_id: string;
  player_uuid: string;
  username: string;
  mode: 'solo' | 'multiplayer';
}): Promise<PostScoreResult> {
  return call('post-score', args);
}

export interface LeaderboardEntry {
  id: string;
  username: string;
  score: number;
  category: Category;
  difficulty: Difficulty;
  pace: Pace;
  question_count: QuestionCount | null;
  total_time_ms: number;
  mode: 'solo' | 'multiplayer';
  session_mode: SessionMode;
  mp_variant: MpVariant | null;
  created_at: string;
}

export async function getLeaderboard(limit = 100): Promise<LeaderboardEntry[]> {
  const res = await call<{ scores: LeaderboardEntry[] }>('get-leaderboard', { limit: String(limit) }, { method: 'GET' });
  return res.scores ?? [];
}

// ----- Multiplayer ----------------------------------------------------------

export interface CreateRoomResult {
  room_id: string;
  room_code: string;
}

export function createRoom(args: {
  host_player_uuid: string;
  host_username: string;
  difficulty: Difficulty;
  pace: Pace;
  question_count: QuestionCount | null;
  max_players?: number;
  session_mode: SessionMode;
  mp_variant?: MpVariant;
}): Promise<CreateRoomResult> {
  return call('create-room', args);
}

export interface JoinRoomResult {
  room_id: string;
  room_code: string;
  status: 'lobby' | 'category_select' | 'generating' | 'in_progress' | 'finished';
  display_username: string;
  is_host: boolean;
  difficulty: Difficulty;
  pace: Pace;
  question_count: QuestionCount | null;
  session_mode?: SessionMode;
  mp_variant?: MpVariant | null;
}

export function joinRoom(args: {
  room_code: string;
  player_uuid: string;
  username: string;
}): Promise<JoinRoomResult> {
  return call('join-room', args);
}

export function startGame(args: {
  room_id: string;
  player_uuid: string;
}): Promise<{ status: string; category_select_ends_at: string; category_select_seconds: number }> {
  return call('start-game', args);
}

export function submitCategoryPick(args: {
  room_id: string;
  player_uuid: string;
  category: Category;
}): Promise<{ ok: boolean; category: Category }> {
  return call('submit-category-pick', args);
}

export function tickRoom(args: { room_id: string }): Promise<{
  ok: boolean;
  transition?: string;
  noop?: string;
  category?: Category;
  closed_index?: number;
  answered_count?: number;
  player_count?: number;
}> {
  return call('tick-room', args);
}

export function startRoomQuestions(args: { room_id: string }): Promise<{
  ok: boolean;
  question_count?: number;
  current_q_opened_at?: string;
  current_q_ends_at?: string;
  already_started?: boolean;
  noop?: string;
}> {
  return call('start-room-questions', args);
}

export interface MultiplayerQuestion {
  question_id: string;
  question_index: number;
  question_text: string;
  options: string[];
  scripture_ref: string;
  difficulty?: Difficulty;
  category?: Category;
  opened_at: string;
  ends_at: string;
  question_count: QuestionCount | null;
  session_mode?: SessionMode;
  shared_lives?: number | null;
  mp_variant?: MpVariant | null;
}

export function getMpQuestion(args: { room_id: string }): Promise<MultiplayerQuestion> {
  return call('get-mp-question', args);
}

export interface MultiplayerAnswerResult {
  is_correct: boolean;
  points_awarded: number;
  base_points?: number;
  speed_bonus?: number;
  new_score: number;
  new_streak: number;
  multiplier: number;
  time_ms: number;
  lives_remaining?: number | null;
  correct_count?: number | null;
  eliminated?: boolean;
  shared_lives?: number | null;
}

export function queueRoomQuestions(args: { room_id: string }): Promise<{ ok: boolean; length?: number; target?: number }> {
  return call('queue-room-questions', args);
}

export function submitMpAnswer(args: {
  room_id: string;
  player_uuid: string;
  selected_index: number | null;
}): Promise<MultiplayerAnswerResult> {
  return call('submit-mp-answer', args);
}

// ----- Flagging (direct insert via PostgREST, not an Edge Function) ---------

export async function flagQuestion(args: {
  question_id: string;
  player_uuid: string;
  reason?: string;
}): Promise<void> {
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/question_flags`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, 'Failed to flag question', text);
  }
}

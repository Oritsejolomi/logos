// Device-local identity. No auth, no accounts.
// player_uuid: stable identifier that never leaves this device.
// username:    display name chosen by the player, editable.
// question_history: SHA-prefix hashes of questions this player has already seen.

const STORAGE_KEYS = {
  playerUuid: 'logos.player_uuid',
  username: 'logos.username',
  history: 'logos.question_history',
} as const;

const MAX_HISTORY = 500;
// Full history goes to the server on every request. 500 × 16 chars ≈ 8KB,
// cheap, and endless runs expose repeats when the send window is too narrow.
const SEND_WINDOW = 500;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function uuid(): string {
  // crypto.randomUUID() is available in all modern browsers and Node 19+.
  // Fall back to getRandomValues if for some reason randomUUID is missing.
  const c = (typeof crypto !== 'undefined' ? crypto : null) as Crypto | null;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last-resort insecure fallback — should never hit in practice.
  return `insecure-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getPlayerUuid(): string {
  if (!isBrowser()) return 'ssr';
  let id = window.localStorage.getItem(STORAGE_KEYS.playerUuid);
  if (!id) {
    id = uuid();
    window.localStorage.setItem(STORAGE_KEYS.playerUuid, id);
  }
  return id;
}

export function getUsername(): string | null {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(STORAGE_KEYS.username);
  return raw && raw.trim().length > 0 ? raw : null;
}

export function setUsername(name: string): void {
  if (!isBrowser()) return;
  const trimmed = name.trim().slice(0, 40);
  window.localStorage.setItem(STORAGE_KEYS.username, trimmed);
}

export function getQuestionHistory(): string[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.history);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

// Record a newly-seen question by its 16-hex content hash prefix. Oldest
// entries are pruned first once the cap is exceeded.
export function recordQuestionSeen(contentHashPrefix: string): void {
  if (!isBrowser() || !contentHashPrefix) return;
  const prefix = contentHashPrefix.slice(0, 16).toLowerCase();
  const history = getQuestionHistory();
  if (history.includes(prefix)) return;
  history.push(prefix);
  const trimmed = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;
  window.localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(trimmed));
}

// The slice the server sees on each get-question call — just the most recent
// SEND_WINDOW entries, keeping payloads small.
export function recentHashesForRequest(): string[] {
  const history = getQuestionHistory();
  return history.slice(-SEND_WINDOW);
}

export function clearQuestionHistory(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(STORAGE_KEYS.history);
}

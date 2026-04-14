export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input.trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeHashPrefix(hash: string): string {
  return hash.slice(0, 16).toLowerCase();
}

export function sanitizeRecentHashes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const h of input) {
    if (typeof h !== 'string') continue;
    const cleaned = h.trim().toLowerCase();
    if (/^[0-9a-f]{16,64}$/.test(cleaned)) out.push(normalizeHashPrefix(cleaned));
    if (out.length >= 500) break;
  }
  return out;
}

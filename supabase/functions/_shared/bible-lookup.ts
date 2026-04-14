import { adminClient } from './supabase-admin.ts';
import { parseScriptureRef, validateScriptureRef } from './bible-refs.ts';

// Public-domain translations we ship with the RAG gate.
// Ordered so the judge sees them in a consistent sequence.
const TRANSLATIONS = ['WEB', 'KJV', 'ASV'] as const;

export type TranslationMode = 'one' | 'all';

// Fetches the literal verse text for a scripture reference. By default returns
// only the WEB translation in a compact format — three translations cost ~3x
// the tokens for the judge call and rarely change the verdict. Callers that
// genuinely need translation comparison (questions about specific word choices)
// can pass mode='all' to opt in.
//
// Default ('one') returns:
//
//   Genesis 1:1 (WEB): In the beginning, God created the heavens and the earth.
//
// Mode 'all' returns the original three-block format with WEB+KJV+ASV.
export async function lookupVerseText(ref: string, mode: TranslationMode = 'one'): Promise<string | null> {
  const check = validateScriptureRef(ref);
  if (!check.ok || !check.parsed) return null;
  const { book, chapter, verseStart, verseEnd } = check.parsed;

  const db = adminClient();
  let query = db
    .from('bible_verses')
    .select('translation, verse, text')
    .eq('book', book)
    .eq('chapter', chapter)
    .gte('verse', verseStart)
    .lte('verse', verseEnd)
    .order('translation', { ascending: true })
    .order('verse', { ascending: true });
  if (mode === 'one') query = query.eq('translation', 'WEB');

  const { data, error } = await query;
  if (error || !data || data.length === 0) return null;

  // Group by translation, preserve our preferred ordering.
  const byTranslation = new Map<string, { verse: number; text: string }[]>();
  for (const row of data) {
    const t = row.translation as string;
    if (!byTranslation.has(t)) byTranslation.set(t, []);
    byTranslation.get(t)!.push({ verse: row.verse, text: row.text });
  }

  const refLabel = `${book} ${chapter}:${verseStart}${verseEnd !== verseStart ? `-${verseEnd}` : ''}`;

  if (mode === 'one') {
    const verses = byTranslation.get('WEB');
    if (!verses || verses.length === 0) return null;
    const body = verses.map((v) => v.text).join(' ');
    return `${refLabel} (WEB): ${body}`;
  }

  const blocks: string[] = [];
  for (const t of TRANSLATIONS) {
    const verses = byTranslation.get(t);
    if (!verses || verses.length === 0) continue;
    const body = verses.map((v) => v.text).join(' ');
    blocks.push(`${t} — ${refLabel}\n${body}`);
  }
  for (const [t, verses] of byTranslation) {
    if ((TRANSLATIONS as readonly string[]).includes(t)) continue;
    const body = verses.map((v) => v.text).join(' ');
    blocks.push(`${t} — ${refLabel}\n${body}`);
  }
  if (blocks.length === 0) return null;
  return blocks.join('\n\n');
}

// Convenience wrapper so functions can pass this directly as the VerseLookup
// parameter on generateQuestion(). Defaults to single-translation (WEB).
export const verseLookup = (ref: string) => lookupVerseText(ref, 'one');

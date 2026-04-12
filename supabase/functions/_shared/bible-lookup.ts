import { adminClient } from './supabase-admin.ts';
import { parseScriptureRef, validateScriptureRef } from './bible-refs.ts';

// Public-domain translations we ship with the RAG gate.
// Ordered so the judge sees them in a consistent sequence.
const TRANSLATIONS = ['WEB', 'KJV', 'ASV'] as const;

// Fetches the literal verse text for a scripture reference across every
// loaded translation. Returns a human-readable block like:
//
//   WEB — Genesis 1:1
//   In the beginning, God created the heavens and the earth.
//
//   KJV — Genesis 1:1
//   In the beginning God created the heaven and the earth.
//
//   ASV — Genesis 1:1
//   In the beginning God created the heavens and the earth.
//
// Returns null if the reference is invalid or no translation has the verses.
export async function lookupVerseText(ref: string): Promise<string | null> {
  const check = validateScriptureRef(ref);
  if (!check.ok || !check.parsed) return null;
  const { book, chapter, verseStart, verseEnd } = check.parsed;

  const db = adminClient();
  const { data, error } = await db
    .from('bible_verses')
    .select('translation, verse, text')
    .eq('book', book)
    .eq('chapter', chapter)
    .gte('verse', verseStart)
    .lte('verse', verseEnd)
    .order('translation', { ascending: true })
    .order('verse', { ascending: true });

  if (error || !data || data.length === 0) return null;

  // Group by translation, preserve our preferred ordering.
  const byTranslation = new Map<string, { verse: number; text: string }[]>();
  for (const row of data) {
    const t = row.translation as string;
    if (!byTranslation.has(t)) byTranslation.set(t, []);
    byTranslation.get(t)!.push({ verse: row.verse, text: row.text });
  }

  const blocks: string[] = [];
  for (const t of TRANSLATIONS) {
    const verses = byTranslation.get(t);
    if (!verses || verses.length === 0) continue;
    const header = `${t} — ${book} ${chapter}:${verseStart}${verseEnd !== verseStart ? `-${verseEnd}` : ''}`;
    const body = verses.map((v) => v.text).join(' ');
    blocks.push(`${header}\n${body}`);
  }
  // If the corpus has translations we haven't listed in TRANSLATIONS yet,
  // still include them so the judge sees everything available.
  for (const [t, verses] of byTranslation) {
    if ((TRANSLATIONS as readonly string[]).includes(t)) continue;
    const header = `${t} — ${book} ${chapter}:${verseStart}${verseEnd !== verseStart ? `-${verseEnd}` : ''}`;
    const body = verses.map((v) => v.text).join(' ');
    blocks.push(`${header}\n${body}`);
  }

  if (blocks.length === 0) return null;
  return blocks.join('\n\n');
}

// Convenience wrapper so functions can pass this directly as the VerseLookup
// parameter on generateQuestion().
export const verseLookup = (ref: string) => lookupVerseText(ref);

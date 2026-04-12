import { adminClient } from './supabase-admin.ts';
import { parseScriptureRef, validateScriptureRef } from './bible-refs.ts';

// Fetches the literal verse text for a scripture reference from bible_verses.
// Returns a human-readable concatenation like:
//   "Genesis 1:1 In the beginning, God created the heavens and the earth."
// Returns null if the reference is invalid or the verses are not in the corpus.
export async function lookupVerseText(ref: string): Promise<string | null> {
  const check = validateScriptureRef(ref);
  if (!check.ok || !check.parsed) return null;
  const { book, chapter, verseStart, verseEnd } = check.parsed;

  const db = adminClient();
  const { data, error } = await db
    .from('bible_verses')
    .select('verse, text')
    .eq('book', book)
    .eq('chapter', chapter)
    .gte('verse', verseStart)
    .lte('verse', verseEnd)
    .order('verse', { ascending: true });

  if (error || !data || data.length === 0) return null;

  return data
    .map((row) => `${book} ${chapter}:${row.verse} ${row.text}`)
    .join('\n');
}

// Convenience wrapper so functions can pass this directly as the VerseLookup
// parameter on generateQuestion().
export const verseLookup = (ref: string) => lookupVerseText(ref);

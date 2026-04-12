#!/usr/bin/env node
// Loads the World English Bible (public domain) into the bible_verses table.
// Run once after the 20260412144942_bible_verses migration has been applied.
//
// Usage:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/load-bible.mjs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// getbible.net → canonical book name used throughout the app.
const BOOK_NAME_MAP = {
  'Genesis': 'Genesis', 'Exodus': 'Exodus', 'Leviticus': 'Leviticus', 'Numbers': 'Numbers',
  'Deuteronomy': 'Deuteronomy', 'Joshua': 'Joshua', 'Judges': 'Judges', 'Ruth': 'Ruth',
  '1 Samuel': '1 Samuel', '2 Samuel': '2 Samuel', '1 Kings': '1 Kings', '2 Kings': '2 Kings',
  '1 Chronicles': '1 Chronicles', '2 Chronicles': '2 Chronicles',
  'Ezra': 'Ezra', 'Nehemiah': 'Nehemiah', 'Esther': 'Esther', 'Job': 'Job',
  'Psalms': 'Psalms', 'Psalm': 'Psalms',
  'Proverbs': 'Proverbs', 'Ecclesiastes': 'Ecclesiastes',
  'Song of Songs': 'Song of Solomon', 'Song of Solomon': 'Song of Solomon',
  'Isaiah': 'Isaiah', 'Jeremiah': 'Jeremiah', 'Lamentations': 'Lamentations',
  'Ezekiel': 'Ezekiel', 'Daniel': 'Daniel', 'Hosea': 'Hosea', 'Joel': 'Joel', 'Amos': 'Amos',
  'Obadiah': 'Obadiah', 'Jonah': 'Jonah', 'Micah': 'Micah', 'Nahum': 'Nahum',
  'Habakkuk': 'Habakkuk', 'Zephaniah': 'Zephaniah', 'Haggai': 'Haggai',
  'Zechariah': 'Zechariah', 'Malachi': 'Malachi',
  'Matthew': 'Matthew', 'Mark': 'Mark', 'Luke': 'Luke', 'John': 'John', 'Acts': 'Acts',
  'Romans': 'Romans', '1 Corinthians': '1 Corinthians', '2 Corinthians': '2 Corinthians',
  'Galatians': 'Galatians', 'Ephesians': 'Ephesians', 'Philippians': 'Philippians',
  'Colossians': 'Colossians', '1 Thessalonians': '1 Thessalonians', '2 Thessalonians': '2 Thessalonians',
  '1 Timothy': '1 Timothy', '2 Timothy': '2 Timothy', 'Titus': 'Titus', 'Philemon': 'Philemon',
  'Hebrews': 'Hebrews', 'James': 'James', '1 Peter': '1 Peter', '2 Peter': '2 Peter',
  '1 John': '1 John', '2 John': '2 John', '3 John': '3 John', 'Jude': 'Jude',
  'Revelation': 'Revelation', 'Revelation of Jesus Christ': 'Revelation',
};

function stripFootnotes(text) {
  // getbible WEB includes footnote markers like "God1:1 The Hebrew..." — strip them.
  // Pattern: digit+":"+digit+ then footnote content until next capital or punctuation.
  // Simpler: remove anything between ⟨ ⟩ or that matches inline footnote glyphs.
  return text
    .replace(/[¶§]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchBook(n) {
  const res = await fetch(`https://api.getbible.net/v2/web/${n}.json`);
  if (!res.ok) throw new Error(`book ${n}: HTTP ${res.status}`);
  return res.json();
}

async function insertBatch(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bible_verses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Prefer': 'resolution=ignore-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`insert batch HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
}

async function main() {
  console.log('Fetching all 66 books from getbible.net (WEB)...');
  const allRows = [];
  const unmapped = new Set();

  for (let n = 1; n <= 66; n++) {
    process.stdout.write(`  book ${n}/66...\r`);
    const data = await fetchBook(n);
    const bookName = BOOK_NAME_MAP[data.name];
    if (!bookName) {
      unmapped.add(data.name);
      continue;
    }
    for (const chapter of data.chapters ?? []) {
      for (const v of chapter.verses ?? []) {
        allRows.push({
          book: bookName,
          chapter: v.chapter,
          verse: v.verse,
          text: stripFootnotes(v.text),
        });
      }
    }
  }
  console.log(`\nFetched ${allRows.length} verses.`);
  if (unmapped.size > 0) {
    console.error('UNMAPPED book names from getbible:', [...unmapped]);
    process.exit(1);
  }

  console.log('Inserting in batches of 500...');
  const BATCH = 500;
  for (let i = 0; i < allRows.length; i += BATCH) {
    const batch = allRows.slice(i, i + BATCH);
    await insertBatch(batch);
    process.stdout.write(`  ${Math.min(i + BATCH, allRows.length)}/${allRows.length}\r`);
  }
  console.log(`\nDone. Inserted ${allRows.length} verses.`);
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});

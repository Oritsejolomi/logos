-- Bible corpus for Gate 3 RAG verse lookup in the LLM-as-judge.
-- Text is the World English Bible (WEB), public domain, Protestant 66-book canon.
-- Loaded separately via scripts/load-bible.mjs — migration only creates schema.

create table bible_verses (
  book    text not null,
  chapter int  not null,
  verse   int  not null,
  text    text not null,
  primary key (book, chapter, verse)
);

-- Allow anon reads so the RAG lookup can run via a lightweight client if needed.
alter table bible_verses enable row level security;
create policy read_bible_verses on bible_verses for select to anon, authenticated using (true);
grant select on bible_verses to anon, authenticated;

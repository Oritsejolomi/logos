-- Multi-translation support for the RAG gate. The existing bible_verses
-- table only held WEB; now we allow any public-domain translation (KJV,
-- ASV, etc.) and the primary key is expanded to cover translation.

alter table bible_verses
  add column translation text not null default 'WEB';

alter table bible_verses drop constraint bible_verses_pkey;
alter table bible_verses add primary key (translation, book, chapter, verse);

create index bible_verses_book_chapter_verse on bible_verses (book, chapter, verse);

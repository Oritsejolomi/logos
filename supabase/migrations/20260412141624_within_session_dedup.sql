-- Track which questions have been served within a single solo session so the
-- server can guarantee no within-session duplicates regardless of what the
-- client sends in recent_hashes. Multiplayer already tracks this via
-- rooms.question_ids; solo was missing the equivalent.

alter table solo_sessions
  add column served_question_ids uuid[] not null default '{}';

-- Pre-generate all N questions for a solo session in parallel so the user
-- only waits on Q1 and every subsequent Next click is instant. Mirrors the
-- multiplayer rooms.question_ids approach.

alter table solo_sessions
  add column queued_question_ids uuid[] not null default '{}';

alter table solo_sessions
  add column queue_started_at timestamptz;

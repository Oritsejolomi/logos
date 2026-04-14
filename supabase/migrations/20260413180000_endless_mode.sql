-- Endless mode: solo and multiplayer sessions wey run until lives dey exhausted
-- rather than through a fixed question count. Adds per-table mode flags, lives,
-- correct-answer counters, and a shared/per-player elimination model for MP.

-- ============================================================================
-- solo_sessions
-- ============================================================================

alter table solo_sessions drop constraint solo_sessions_question_count_check;
alter table solo_sessions alter column question_count drop not null;

alter table solo_sessions add column session_mode text not null default 'fixed'
  check (session_mode in ('fixed','endless'));
alter table solo_sessions add column lives_remaining int;
alter table solo_sessions add column correct_count int not null default 0;
alter table solo_sessions add column endless_depth int not null default 0;

-- ============================================================================
-- rooms
-- ============================================================================

alter table rooms drop constraint rooms_question_count_check;
alter table rooms alter column question_count drop not null;

alter table rooms add column session_mode text not null default 'fixed'
  check (session_mode in ('fixed','endless'));
alter table rooms add column mp_variant text
  check (mp_variant in ('battle_royale','co_op'));
alter table rooms add column shared_lives int;
alter table rooms add column endless_depth int not null default 0;

-- ============================================================================
-- room_players
-- ============================================================================

alter table room_players add column lives_remaining int;
alter table room_players add column correct_count int not null default 0;
alter table room_players add column eliminated_at timestamptz;

-- ============================================================================
-- scores (hall of fame)
-- ============================================================================

alter table scores drop constraint scores_question_count_check;
alter table scores alter column question_count drop not null;

alter table scores add column session_mode text not null default 'fixed'
  check (session_mode in ('fixed','endless'));
alter table scores add column mp_variant text
  check (mp_variant in ('battle_royale','co_op'));

-- Leaderboard queries now filter by mode + session_mode before sorting.
drop index if exists scores_leaderboard;
create index scores_leaderboard
  on scores (mode, session_mode, score desc, total_time_ms asc);

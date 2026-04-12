-- Logos — initial schema
-- Bible trivia web app. Supabase Postgres. See plan file for full context.

create extension if not exists pgcrypto;
create extension if not exists pg_cron;

-- ============================================================================
-- questions
-- ============================================================================

create table questions (
  id              uuid primary key default gen_random_uuid(),
  category        text not null,
  difficulty      text not null check (difficulty in ('beginner','intermediate','advanced')),
  question_text   text not null,
  options         jsonb not null,
  correct_index   int  not null check (correct_index between 0 and 3),
  scripture_ref   text not null,
  insight         text not null,
  content_hash    text unique not null,
  content_hash_16 text generated always as (substr(content_hash, 1, 16)) stored,
  flag_count      int  not null default 0,
  quality_score   int  not null default 50 check (quality_score between 0 and 100),
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index questions_bank_lookup
  on questions (category, difficulty, quality_score desc)
  where deleted_at is null;

create index questions_hash_prefix
  on questions (content_hash_16)
  where deleted_at is null;

-- ============================================================================
-- solo_sessions
-- ============================================================================

create table solo_sessions (
  id                     uuid primary key default gen_random_uuid(),
  player_uuid            text not null,
  username               text not null,
  category               text not null,
  difficulty             text not null check (difficulty in ('beginner','intermediate','advanced')),
  pace                   text not null default 'arcade'
                              check (pace in ('speedy','arcade','meditative')),
  question_count         int  not null check (question_count in (5,10,15)),
  status                 text not null default 'active'
                              check (status in ('active','finished','abandoned')),
  current_q_index        int  not null default 0,
  current_question_id    uuid references questions(id),
  current_q_opened_at    timestamptz,
  prefetched_question_id uuid references questions(id),
  score                  int  not null default 0,
  streak                 int  not null default 0,
  total_time_ms          int  not null default 0,
  started_at             timestamptz not null default now(),
  finished_at            timestamptz,
  expires_at             timestamptz not null default (now() + interval '1 hour')
);

create index solo_sessions_player_active
  on solo_sessions (player_uuid)
  where status = 'active';

create index solo_sessions_expiry
  on solo_sessions (expires_at)
  where status = 'active';

-- ============================================================================
-- rooms
-- ============================================================================

create table rooms (
  id                      uuid primary key default gen_random_uuid(),
  room_code               text unique not null,
  status                  text not null default 'lobby'
                               check (status in ('lobby','category_select','in_progress','finished','abandoned')),
  category                text,
  difficulty              text not null check (difficulty in ('beginner','intermediate','advanced')),
  pace                    text not null default 'arcade'
                               check (pace in ('speedy','arcade','meditative')),
  question_count          int  not null check (question_count in (5,10,15)),
  max_players             int  not null default 50 check (max_players between 2 and 50),
  host_player_uuid        text not null,
  question_ids            uuid[] not null default '{}',
  current_q_index         int  not null default 0,
  current_q_opened_at     timestamptz,
  current_q_ends_at       timestamptz,
  category_select_ends_at timestamptz,
  created_at              timestamptz not null default now(),
  expires_at              timestamptz not null default (now() + interval '24 hours')
);

create index rooms_code_active on rooms (room_code)
  where status <> 'abandoned' and status <> 'finished';

create index rooms_expiry on rooms (expires_at)
  where status not in ('finished','abandoned');

-- ============================================================================
-- room_players
-- ============================================================================

create table room_players (
  id               uuid primary key default gen_random_uuid(),
  room_id          uuid not null references rooms(id) on delete cascade,
  player_uuid      text not null,
  username         text not null,
  display_username text not null,
  score            int  not null default 0,
  streak           int  not null default 0,
  multiplier       numeric(3,1) not null default 1.0,
  category_pick    text,
  has_picked       boolean not null default false,
  is_host          boolean not null default false,
  last_seen_at     timestamptz not null default now(),
  joined_at        timestamptz not null default now(),
  unique (room_id, player_uuid)
);

create index room_players_by_room on room_players (room_id);

-- ============================================================================
-- room_answers
-- ============================================================================

create table room_answers (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references rooms(id) on delete cascade,
  question_id    uuid not null references questions(id),
  question_index int  not null,
  player_uuid    text not null,
  selected_index int,
  is_correct     boolean,
  time_ms        int,
  points_awarded int  not null default 0,
  answered_at    timestamptz not null default now(),
  unique (room_id, question_index, player_uuid)
);

create index room_answers_round on room_answers (room_id, question_index);

-- ============================================================================
-- scores (hall of fame)
-- ============================================================================

create table scores (
  id                uuid primary key default gen_random_uuid(),
  username          text not null,
  score             int  not null check (score >= 0),
  category          text not null,
  difficulty        text not null check (difficulty in ('beginner','intermediate','advanced')),
  pace              text not null default 'arcade'
                         check (pace in ('speedy','arcade','meditative')),
  question_count    int  not null check (question_count in (5,10,15)),
  total_time_ms     int  not null check (total_time_ms > 0),
  mode              text not null default 'solo' check (mode in ('solo','multiplayer')),
  source_session_id uuid,
  created_at        timestamptz not null default now(),
  unique (source_session_id, mode)
);

create index scores_leaderboard on scores (score desc, total_time_ms asc);

-- ============================================================================
-- question_flags (community moderation)
-- ============================================================================

create table question_flags (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  player_uuid text not null,
  reason      text,
  created_at  timestamptz not null default now(),
  unique (question_id, player_uuid)
);

create or replace function on_question_flagged() returns trigger
language plpgsql
as $$
begin
  update questions
     set flag_count = flag_count + 1,
         deleted_at = case when flag_count + 1 >= 3 then now() else deleted_at end
   where id = new.question_id;
  return new;
end;
$$;

create trigger question_flag_counter
  after insert on question_flags
  for each row execute function on_question_flagged();

-- ============================================================================
-- gemini_errors (observability)
-- ============================================================================

create table gemini_errors (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('parse_fail','safety_block','rate_limit','timeout','other')),
  prompt_hash  text,
  raw_response text,
  created_at   timestamptz not null default now()
);

-- ============================================================================
-- Row-level security
-- ============================================================================

alter table questions      enable row level security;
alter table solo_sessions  enable row level security;
alter table rooms          enable row level security;
alter table room_players   enable row level security;
alter table room_answers   enable row level security;
alter table scores         enable row level security;
alter table question_flags enable row level security;
alter table gemini_errors  enable row level security;

create policy read_questions on questions
  for select to anon, authenticated
  using (deleted_at is null);

create policy read_scores on scores
  for select to anon, authenticated
  using (true);

create policy read_rooms on rooms
  for select to anon, authenticated
  using (status <> 'abandoned');

create policy read_room_players on room_players
  for select to anon, authenticated
  using (true);

create policy read_room_answers on room_answers
  for select to anon, authenticated
  using (true);

create policy flag_insert on question_flags
  for insert to anon, authenticated
  with check (true);

-- No anon policies on solo_sessions, gemini_errors. Service role bypasses RLS.
-- All mutations on questions, solo_sessions, rooms, room_players, room_answers,
-- and scores must go through Edge Functions running with the service role key.

-- RLS policies require underlying table-level grants to work. Supabase auto-grants
-- these on hosted projects; declaring them here makes the migration portable.
grant select on questions, scores, rooms, room_players, room_answers to anon, authenticated;
grant insert on question_flags to anon, authenticated;

-- ============================================================================
-- Scheduled cleanup
-- ============================================================================

select cron.schedule(
  'logos-cleanup-daily',
  '0 3 * * *',
  $$
    update rooms
       set status='abandoned'
     where expires_at < now() and status not in ('finished','abandoned');

    update solo_sessions
       set status='abandoned'
     where expires_at < now() and status = 'active';

    delete from rooms
     where status in ('finished','abandoned')
       and created_at < now() - interval '7 days';

    delete from solo_sessions
     where status in ('finished','abandoned')
       and started_at < now() - interval '7 days';

    delete from gemini_errors
     where created_at < now() - interval '30 days';
  $$
);

select cron.schedule(
  'logos-cleanup-stuck-rooms',
  '*/5 * * * *',
  $$
    update rooms
       set status='abandoned'
     where status = 'in_progress'
       and current_q_ends_at < now() - interval '2 minutes';
  $$
);

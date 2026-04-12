-- Phase 4: multiplayer state extensions.
-- - Add 'generating' status (between category_select and in_progress, while we
--   generate all N questions for the session).
-- - Add generation_started_at as an idempotent lock on start-room-questions.
-- - Enable realtime publication so clients can subscribe via Supabase Realtime CDC.

-- Expand status check constraint to include 'generating'.
alter table rooms drop constraint rooms_status_check;
alter table rooms add constraint rooms_status_check
  check (status in ('lobby','category_select','generating','in_progress','finished','abandoned'));

-- Lock column. NULL means "nobody has started generation yet" or the last
-- attempt was released. Conditional UPDATE uses WHERE generation_started_at
-- IS NULL OR generation_started_at < now() - interval '60 seconds' for retry.
alter table rooms add column generation_started_at timestamptz;

-- Update the stuck-rooms cleanup cron to also handle stuck 'generating' state.
-- The previous cron only caught in_progress rooms.
select cron.unschedule('logos-cleanup-stuck-rooms');
select cron.schedule(
  'logos-cleanup-stuck-rooms',
  '*/5 * * * *',
  $$
    update rooms
       set status='abandoned'
     where status = 'in_progress'
       and current_q_ends_at < now() - interval '2 minutes';

    update rooms
       set status='abandoned'
     where status = 'generating'
       and generation_started_at < now() - interval '3 minutes';
  $$
);

-- Enable Supabase Realtime publication for the tables clients subscribe to.
-- Supabase creates the supabase_realtime publication automatically; we just
-- add our tables to it.
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table room_players;
alter publication supabase_realtime add table room_answers;

-- Atomic play_count increment so submit-answer can increment without read-then-write.
-- Separated from the early_skepticism migration because that one had already been
-- applied to the hosted DB before this RPC was realised as necessary.

create or replace function increment_play_count(q_id uuid) returns void
language sql
as $$
  update questions set play_count = play_count + 1 where id = q_id;
$$;

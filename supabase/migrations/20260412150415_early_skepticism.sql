-- Early skepticism: a brand-new question (played <= 3 times) that gets even
-- one flag is immediately soft-deleted. Established questions still need 3.
-- This assumes bad questions are caught early before they taint the bank.

alter table questions add column play_count int not null default 0;

-- Atomic play_count increment so submit-answer does not need read-then-write.
create or replace function increment_play_count(q_id uuid) returns void
language sql
as $$
  update questions set play_count = play_count + 1 where id = q_id;
$$;

create or replace function on_question_flagged() returns trigger
language plpgsql
as $$
declare
  current_plays int;
  current_flags int;
begin
  update questions
     set flag_count = flag_count + 1
   where id = new.question_id
   returning play_count, flag_count into current_plays, current_flags;

  -- Established questions: 3 flags → soft delete.
  -- New questions (played <= 3 times): 1 flag → immediate soft delete.
  if current_flags >= 3 or (current_flags >= 1 and current_plays <= 3) then
    update questions
       set deleted_at = now()
     where id = new.question_id
       and deleted_at is null;
  end if;

  return new;
end;
$$;

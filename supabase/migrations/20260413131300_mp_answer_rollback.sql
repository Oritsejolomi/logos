-- Track the player's streak before this answer was applied, so a re-submit
-- during the same round can cleanly roll back the prior contribution before
-- applying the new one. A simple delta cannot reconstruct the prior streak
-- because wrong answers reset streak to 0, losing information.
alter table room_answers add column streak_before int;

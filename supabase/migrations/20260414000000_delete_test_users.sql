-- Remove test/dev entries from the leaderboard.
DELETE FROM scores
WHERE username ILIKE 'jolom%'
   OR username ILIKE 'jolomi%'
   OR username ILIKE 'jdawg%';

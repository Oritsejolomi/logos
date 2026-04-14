import type { Difficulty } from './scoring.ts';

// Difficulty tiers in ascending order. The schema keeps three physical tiers
// (beginner/intermediate/advanced) — once a session ramps up to advanced,
// additional escalation happens through endlessDepth on the Gemini prompt
// rather than a new tier in the database.
const TIERS: Difficulty[] = ['beginner', 'intermediate', 'advanced'];

// How many questions per ramp step. Tight (5) so endless runs get hard fast —
// Bible-literate players were outlasting a 10-per-step ramp.
const RAMP_INTERVAL = 5;

// Every RAMP_INTERVAL questions bumps the tier. Beginner → Intermediate at Q5,
// Advanced at Q10. Advanced picks stay at Advanced from Q0 (depth handles the
// rest).
export function difficultyAt(pick: Difficulty, questionIndex: number): Difficulty {
  const startIdx = TIERS.indexOf(pick);
  if (startIdx < 0) return pick;
  const bump = Math.floor(questionIndex / RAMP_INTERVAL);
  const targetIdx = Math.min(TIERS.length - 1, startIdx + bump);
  return TIERS[targetIdx];
}

// Endless depth only kicks in once the session is already at Advanced. Depth 0
// means "standard advanced" (bank-eligible). Depth 1+ means "Gemini-only,
// progressively more obscure" — the bank no fit serve these because the column
// stores 'advanced' without depth. Every RAMP_INTERVAL questions past the
// Advanced threshold bumps depth by 1.
export function endlessDepthAt(pick: Difficulty, questionIndex: number): number {
  const startIdx = TIERS.indexOf(pick);
  if (startIdx < 0) return 0;
  const rampsToAdvanced = TIERS.length - 1 - startIdx;
  const advancedStartsAt = rampsToAdvanced * RAMP_INTERVAL;
  if (questionIndex < advancedStartsAt) return 0;
  // Depth 0 for the first RAMP_INTERVAL questions at Advanced, then +1 per step.
  return Math.floor((questionIndex - advancedStartsAt) / RAMP_INTERVAL);
}

// Combined helper: returns both the ramped difficulty tier and the endless
// depth at a given question index in an endless session.
export function rampingStateAt(pick: Difficulty, questionIndex: number): {
  difficulty: Difficulty;
  endlessDepth: number;
} {
  return {
    difficulty: difficultyAt(pick, questionIndex),
    endlessDepth: endlessDepthAt(pick, questionIndex),
  };
}

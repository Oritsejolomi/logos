export type Difficulty = 'beginner' | 'intermediate' | 'advanced';
export type Pace = 'speedy' | 'arcade' | 'meditative';
export type SessionMode = 'fixed' | 'endless';

export const BASE_POINTS: Record<Difficulty, number> = {
  beginner: 10,
  intermediate: 20,
  advanced: 30,
};

export const TIMER_SECONDS: Record<Pace, Record<Difficulty, number>> = {
  speedy:     { beginner: 25, intermediate: 15, advanced: 10 },
  arcade:     { beginner: 45, intermediate: 30, advanced: 20 },
  meditative: { beginner: 75, intermediate: 50, advanced: 35 },
};

// Uncapped streak curve. Preserves the celebratory 1.3 → 1.5 jump at streak 5
// that the old capped curve shipped with, then continues +0.1 per streak
// indefinitely. Endless mode can push the multiplier arbitrarily high with a
// long survival run; fixed mode inherits the same curve so the two leaderboards
// sit on a coherent scale.
export function streakMultiplier(streak: number): number {
  if (streak <= 1) return 1.0;
  if (streak === 2) return 1.1;
  if (streak === 3) return 1.2;
  if (streak === 4) return 1.3;
  // streak 5 is the celebratory jump from 1.3 to 1.5. Beyond that, +0.1 per
  // additional correct answer with no ceiling.
  return 1.5 + 0.1 * (streak - 5);
}

export function pointsForAnswer(args: {
  difficulty: Difficulty;
  pace: Pace;
  isCorrect: boolean;
  timeMs: number;
  currentStreak: number;
}): { points: number; newStreak: number; multiplier: number; basePoints: number; speedBonus: number } {
  const { difficulty, pace, isCorrect, timeMs, currentStreak } = args;

  if (!isCorrect) {
    return { points: 0, newStreak: 0, multiplier: 1.0, basePoints: 0, speedBonus: 0 };
  }

  const timerSeconds = TIMER_SECONDS[pace][difficulty];
  const remaining = Math.max(0, timerSeconds - Math.floor(timeMs / 1000));
  const speedBonus = Math.floor(remaining * 0.5);
  const basePoints = BASE_POINTS[difficulty];

  const newStreak = currentStreak + 1;
  const multiplier = streakMultiplier(newStreak);
  const points = Math.floor((basePoints + speedBonus) * multiplier);

  return { points, newStreak, multiplier, basePoints, speedBonus };
}

// Theoretical max for fixed-mode sanity validation. The difficulty here is the
// PICKED difficulty; the actual hardest question served is at that picked tier
// for fixed mode (ramping only applies to endless). Uses the uncapped curve,
// so the ceiling is much higher than the old capped-at-1.5 value.
export function theoreticalMax(args: {
  questionCount: number;
  difficulty: Difficulty;
  pace: Pace;
}): number {
  const { questionCount, difficulty, pace } = args;
  const base = BASE_POINTS[difficulty];
  const maxSpeed = Math.floor(TIMER_SECONDS[pace][difficulty] * 0.5);
  const perQ = base + maxSpeed;
  let total = 0;
  for (let i = 1; i <= questionCount; i++) {
    total += Math.floor(perQ * streakMultiplier(i));
  }
  return total;
}

// For endless mode the score is server-authoritative and effectively unbounded,
// so we skip the ceiling check. Fixed mode still validates against the
// uncapped theoretical max, which prevents client forgery.
export function validateScoreSubmission(args: {
  score: number;
  questionCount: number;
  difficulty: Difficulty;
  pace: Pace;
  totalTimeMs: number;
  sessionMode?: SessionMode;
}): { ok: true } | { ok: false; reason: string } {
  if (args.score < 0) return { ok: false, reason: 'negative score' };
  if (args.totalTimeMs < Math.max(1, args.questionCount) * 500) {
    return { ok: false, reason: 'total time too fast to be human' };
  }
  if (args.sessionMode === 'endless') return { ok: true };
  const ceiling = theoreticalMax(args);
  if (args.score > ceiling) return { ok: false, reason: `score ${args.score} exceeds ceiling ${ceiling}` };
  return { ok: true };
}

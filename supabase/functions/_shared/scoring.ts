export type Difficulty = 'beginner' | 'intermediate' | 'advanced';
export type Pace = 'speedy' | 'arcade' | 'meditative';

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

export function streakMultiplier(streak: number): number {
  if (streak <= 1) return 1.0;
  if (streak === 2) return 1.1;
  if (streak === 3) return 1.2;
  if (streak === 4) return 1.3;
  return 1.5;
}

export function pointsForAnswer(args: {
  difficulty: Difficulty;
  pace: Pace;
  isCorrect: boolean;
  timeMs: number;
  currentStreak: number;
}): { points: number; newStreak: number; multiplier: number } {
  const { difficulty, pace, isCorrect, timeMs, currentStreak } = args;

  if (!isCorrect) return { points: 0, newStreak: 0, multiplier: 1.0 };

  const timerSeconds = TIMER_SECONDS[pace][difficulty];
  const remaining = Math.max(0, timerSeconds - Math.floor(timeMs / 1000));
  const speedBonus = Math.floor(remaining * 0.5);
  const base = BASE_POINTS[difficulty];

  const newStreak = currentStreak + 1;
  const multiplier = streakMultiplier(newStreak);
  const points = Math.floor((base + speedBonus) * multiplier);

  return { points, newStreak, multiplier };
}

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

export function validateScoreSubmission(args: {
  score: number;
  questionCount: number;
  difficulty: Difficulty;
  pace: Pace;
  totalTimeMs: number;
}): { ok: true } | { ok: false; reason: string } {
  const ceiling = theoreticalMax(args);
  if (args.score < 0) return { ok: false, reason: 'negative score' };
  if (args.score > ceiling) return { ok: false, reason: `score ${args.score} exceeds ceiling ${ceiling}` };
  if (args.totalTimeMs < args.questionCount * 500) {
    return { ok: false, reason: 'total time too fast to be human' };
  }
  return { ok: true };
}

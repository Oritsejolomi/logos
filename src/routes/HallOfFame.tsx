import { useEffect, useState } from 'react';
import { getLeaderboard, type LeaderboardEntry } from '../lib/api';

function formatTime(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

const RANK_EMOJI: Record<number, string> = { 0: '🥇', 1: '🥈', 2: '🥉' };

export function HallOfFame() {
  const [scores, setScores] = useState<LeaderboardEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getLeaderboard(100)
      .then(setScores)
      .catch((e) => setErr(e?.message ?? 'Failed to load'));
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-10 space-y-5">
      <div className="space-y-1">
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">
          All-time best
        </div>
        <h1 className="font-display text-4xl sm:text-5xl font-black text-ink-900">Hall of fame</h1>
        <p className="text-ink-500 text-sm italic">
          Top 100 single-game scores. Equal scores ranked by total time.
        </p>
      </div>
      {err && <p className="text-no">{err}</p>}
      {!scores && !err && (
        <div className="h-96 rounded-xl border border-rule bg-card animate-pulse" />
      )}
      {scores && (
        <ol className="rounded-xl border border-rule overflow-hidden bg-card">
          {scores.map((s, i) => (
            <li
              key={s.id}
              className={`flex items-center gap-3 px-4 py-2.5 ${
                i === 0 ? 'bg-accent/5' : ''
              }`}
            >
              <span className="w-8 text-center">
                {RANK_EMOJI[i] ?? (
                  <span className="font-mono text-sm text-ink-400">{i + 1}</span>
                )}
              </span>
              <span className="flex-1 truncate font-medium text-ink-800">{s.username}</span>
              <span className="hidden sm:inline text-[10px] uppercase tracking-wider text-ink-400">
                {s.category} · {s.difficulty} · {s.pace} · {s.mode}
              </span>
              <span className="text-xs text-ink-400 hidden md:inline tabular-nums">
                {formatTime(s.total_time_ms)}
              </span>
              <span className="font-mono text-accent tabular-nums text-lg font-semibold">{s.score}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

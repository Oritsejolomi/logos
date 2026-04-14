import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CATEGORIES,
  getLeaderboard,
  type Category,
  type Difficulty,
  type LeaderboardEntry,
  type Pace,
  type SessionMode,
} from '../lib/api';

function formatTime(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

const RANK_EMOJI: Record<number, string> = { 0: '🥇', 1: '🥈', 2: '🥉' };

const DIFFICULTIES: Difficulty[] = ['beginner', 'intermediate', 'advanced'];
const PACES: Pace[] = ['speedy', 'arcade', 'meditative'];
const MODES = ['solo', 'multiplayer'] as const;
type Mode = (typeof MODES)[number];

// Endless is shown first because that's the only mode solo can run going
// forward. Fixed kept as a tab so legacy scores still have a home.
const BOARDS: Array<{ id: SessionMode; label: string }> = [
  { id: 'endless', label: 'Endless' },
  { id: 'fixed', label: 'Fixed' },
];

type CategoryFilter = Category | 'all';
type DifficultyFilter = Difficulty | 'all';
type PaceFilter = Pace | 'all';
type ModeFilter = Mode | 'all';

export function HallOfFame() {
  const [params, setParams] = useSearchParams();
  const [scores, setScores] = useState<LeaderboardEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const category = (params.get('category') ?? 'all') as CategoryFilter;
  const difficulty = (params.get('difficulty') ?? 'all') as DifficultyFilter;
  const pace = (params.get('pace') ?? 'all') as PaceFilter;
  const mode = (params.get('mode') ?? 'all') as ModeFilter;
  const board = (params.get('board') ?? 'endless') as SessionMode;

  useEffect(() => {
    getLeaderboard(100)
      .then(setScores)
      .catch((e) => setErr(e?.message ?? 'Failed to load'));
  }, []);

  const filtered = useMemo(() => {
    if (!scores) return null;
    return scores.filter((s) => {
      // Primary board filter — fixed vs endless. Applied to every row.
      // Rows from before the endless migration default to 'fixed'.
      if ((s.session_mode ?? 'fixed') !== board) return false;
      if (category !== 'all' && s.category !== category) return false;
      if (difficulty !== 'all' && s.difficulty !== difficulty) return false;
      if (pace !== 'all' && s.pace !== pace) return false;
      if (mode !== 'all' && s.mode !== mode) return false;
      return true;
    });
  }, [scores, category, difficulty, pace, mode, board]);

  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next);
  };

  const reset = () => setParams(new URLSearchParams());

  const hasFilter = category !== 'all' || difficulty !== 'all' || pace !== 'all' || mode !== 'all';

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      <div className="space-y-1">
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">
          All-time best
        </div>
        <h1 className="font-display text-4xl sm:text-5xl font-black text-ink-900">Hall of fame</h1>
        <p className="text-ink-500 text-sm italic">
          Top 100 single-game scores. Equal scores ranked by total time.
        </p>
      </div>

      {/* Board tabs: Fixed / Endless live on separate leaderboards. */}
      <div className="flex gap-2 border-b border-rule">
        {BOARDS.map((b) => {
          const active = board === b.id;
          return (
            <button
              key={b.id}
              onClick={() => updateFilter('board', b.id)}
              className={`px-4 py-2 text-sm font-semibold transition ${
                active
                  ? 'text-accent border-b-2 border-accent -mb-px'
                  : 'text-ink-400 hover:text-ink-700'
              }`}
            >
              {b.label}
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <FilterSelect
          label="Category"
          value={category}
          onChange={(v) => updateFilter('category', v)}
          options={[['all', 'All categories'], ...CATEGORIES.map((c) => [c, c] as [string, string])]}
        />
        <FilterSelect
          label="Difficulty"
          value={difficulty}
          onChange={(v) => updateFilter('difficulty', v)}
          options={[['all', 'All'], ...DIFFICULTIES.map((d) => [d, capitalize(d)] as [string, string])]}
        />
        <FilterSelect
          label="Pace"
          value={pace}
          onChange={(v) => updateFilter('pace', v)}
          options={[['all', 'All'], ...PACES.map((p) => [p, capitalize(p)] as [string, string])]}
        />
        <FilterSelect
          label="Mode"
          value={mode}
          onChange={(v) => updateFilter('mode', v)}
          options={[['all', 'All'], ...MODES.map((m) => [m, capitalize(m)] as [string, string])]}
        />
        {hasFilter && (
          <button
            onClick={reset}
            className="text-[11px] text-accent hover:underline uppercase tracking-[0.15em] font-semibold pb-2"
          >
            Clear
          </button>
        )}
      </div>

      {err && <p className="text-no">{err}</p>}
      {!scores && !err && (
        <div className="h-96 rounded-xl border border-rule bg-card animate-pulse" />
      )}
      {scores && filtered && (
        <>
          <div className="text-[11px] uppercase tracking-wider text-ink-400">
            Showing {filtered.length} of {scores.length} scores
            {hasFilter && ' (filtered)'}
          </div>
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-rule bg-card p-8 text-center text-ink-400 italic">
              No scores match this filter yet. Play a game in this bracket to claim the top spot.
            </div>
          ) : (
            <ol className="rounded-xl border border-rule overflow-hidden bg-card">
              {filtered.map((s, i) => (
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
                    {s.mp_variant && ` · ${s.mp_variant === 'battle_royale' ? 'BR' : 'co-op'}`}
                  </span>
                  <span className="text-xs text-ink-400 hidden md:inline tabular-nums">
                    {board === 'endless' ? `${s.question_count ?? 0}Q · ` : ''}{formatTime(s.total_time_ms)}
                  </span>
                  <span className="font-mono text-accent tabular-nums text-lg font-semibold">{s.score}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function FilterSelect({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex flex-col gap-1 min-w-[9rem]">
      <span className="text-[10px] uppercase tracking-[0.2em] text-ink-400">{label}</span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="appearance-none w-full rounded-md bg-card border border-rule px-3 py-2 pr-8 text-sm text-ink-800 focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition cursor-pointer"
        >
          {options.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <svg
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-400"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 8 10 12 14 8" />
        </svg>
      </div>
    </label>
  );
}

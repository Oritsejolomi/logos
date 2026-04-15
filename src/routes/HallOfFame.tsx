import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CATEGORIES,
  getLeaderboard,
  getUserScores,
  type Category,
  type Difficulty,
  type LeaderboardEntry,
  type Pace,
} from '../lib/api';

function formatTime(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const RANK_EMOJI: Record<number, string> = { 0: '🥇', 1: '🥈', 2: '🥉' };

const DIFFICULTIES: Difficulty[] = ['beginner', 'intermediate', 'advanced'];
const PACES: Pace[] = ['speedy', 'arcade', 'meditative'];
const MODES = ['solo', 'multiplayer'] as const;
type Mode = (typeof MODES)[number];

type CategoryFilter = Category | 'all';
type DifficultyFilter = Difficulty | 'all';
type PaceFilter = Pace | 'all';
type ModeFilter = Mode | 'all';

function UserHistoryModal({ username, onClose }: { username: string; onClose: () => void }) {
  const [scores, setScores] = useState<LeaderboardEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getUserScores(username)
      .then(setScores)
      .catch((e) => setErr(e?.message ?? 'Failed to load'));
  }, [username]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-rule bg-page shadow-2xl overflow-hidden max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-rule">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-accent font-semibold">Game history</div>
            <h2 className="font-display text-2xl font-black text-ink-900">{username}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-800 transition text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {err && <p className="p-5 text-no">{err}</p>}
          {!scores && !err && (
            <div className="p-5">
              <div className="h-40 rounded-xl bg-rule/30 animate-pulse" />
            </div>
          )}
          {scores && scores.length === 0 && (
            <p className="p-5 text-ink-400 italic text-sm">No scores on record for this user.</p>
          )}
          {scores && scores.length > 0 && (
            <ol className="divide-y divide-rule">
              {scores.map((s, i) => (
                <li key={s.id} className={`flex items-center gap-3 px-5 py-3 ${i === 0 ? 'bg-accent/5' : ''}`}>
                  <span className="w-6 text-center font-mono text-xs text-ink-400">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-ink-400 truncate">
                      {s.category} · {s.difficulty} · {s.pace} · {s.mode}
                      {s.mp_variant && ` · ${s.mp_variant === 'battle_royale' ? 'BR' : 'co-op'}`}
                      {s.session_mode === 'endless' && ' · endless'}
                    </div>
                    <div className="text-[10px] text-ink-400 font-mono mt-0.5">
                      {s.session_mode === 'endless' ? `${s.question_count ?? 0}Q · ` : ''}{formatTime(s.total_time_ms)} · {formatDate(s.created_at)}
                    </div>
                  </div>
                  <span className="font-mono text-accent tabular-nums font-semibold">{s.score}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

export function HallOfFame() {
  const [params, setParams] = useSearchParams();
  const [scores, setScores] = useState<LeaderboardEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [historyUser, setHistoryUser] = useState<string | null>(null);

  const category = (params.get('category') ?? 'all') as CategoryFilter;
  const difficulty = (params.get('difficulty') ?? 'all') as DifficultyFilter;
  const pace = (params.get('pace') ?? 'all') as PaceFilter;
  const mode = (params.get('mode') ?? 'all') as ModeFilter;

  useEffect(() => {
    getLeaderboard(100)
      .then(setScores)
      .catch((e) => setErr(e?.message ?? 'Failed to load'));
  }, []);

  const filtered = useMemo(() => {
    if (!scores) return null;
    return scores.filter((s) => {
      if (category !== 'all' && s.category !== category) return false;
      if (difficulty !== 'all' && s.difficulty !== difficulty) return false;
      if (pace !== 'all' && s.pace !== pace) return false;
      if (mode !== 'all' && s.mode !== mode) return false;
      return true;
    });
  }, [scores, category, difficulty, pace, mode]);

  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete(key);
    else next.set(key, value);
    setParams(next);
  };

  const reset = () => setParams(new URLSearchParams());

  const hasFilter = category !== 'all' || difficulty !== 'all' || pace !== 'all' || mode !== 'all';

  return (
    <>
      {historyUser && (
        <UserHistoryModal username={historyUser} onClose={() => setHistoryUser(null)} />
      )}
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        <div className="space-y-1">
          <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">
            All-time best
          </div>
          <h1 className="font-display text-4xl sm:text-5xl font-black text-ink-900">Hall of fame</h1>
          <p className="text-ink-500 text-sm italic">
            Each player's best score. Click any name to see their full history.
          </p>
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
              Showing {filtered.length} of {scores.length} players
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
                    className={`flex items-center gap-3 px-4 py-2.5 ${i === 0 ? 'bg-accent/5' : ''}`}
                  >
                    <span className="w-8 text-center">
                      {RANK_EMOJI[i] ?? (
                        <span className="font-mono text-sm text-ink-400">{i + 1}</span>
                      )}
                    </span>
                    <button
                      onClick={() => setHistoryUser(s.username)}
                      className="flex-1 min-w-0 font-medium text-ink-800 text-left hover:text-accent transition flex items-center gap-1.5 group/name underline decoration-dotted underline-offset-2 decoration-ink-300 hover:decoration-accent"
                      title="View all scores"
                    >
                      <span className="truncate">{s.username}</span>
                      <svg
                        className="h-3 w-3 text-ink-300 group-hover/name:text-accent transition flex-shrink-0"
                        viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5"
                        strokeLinecap="round" strokeLinejoin="round"
                      >
                        <polyline points="7 4 13 10 7 16" />
                      </svg>
                    </button>
                    <span className="hidden sm:inline text-[10px] uppercase tracking-wider text-ink-400">
                      {s.category} · {s.difficulty} · {s.pace} · {s.mode}
                      {s.session_mode === 'endless' && ' · endless'}
                      {s.mp_variant && ` · ${s.mp_variant === 'battle_royale' ? 'BR' : 'co-op'}`}
                    </span>
                    <span className="text-xs text-ink-400 hidden md:inline tabular-nums">
                      {s.session_mode === 'endless' ? `${s.question_count ?? 0}Q · ` : ''}{formatTime(s.total_time_ms)}
                    </span>
                    <span className="font-mono text-accent tabular-nums text-lg font-semibold">{s.score}</span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </>
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

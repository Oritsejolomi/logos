import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getLeaderboard, type LeaderboardEntry } from '../lib/api';
import { getPlayerUuid, getUsername, setUsername } from '../lib/identity';

function formatTime(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

const RANK_EMOJI: Record<number, string> = { 0: '🥇', 1: '🥈', 2: '🥉' };

export function Home() {
  const [name, setName] = useState(() => getUsername() ?? '');
  const [saved, setSaved] = useState<string | null>(() => getUsername());
  const [scores, setScores] = useState<LeaderboardEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { getPlayerUuid(); }, []);

  useEffect(() => {
    getLeaderboard(10)
      .then(setScores)
      .catch((e) => setErr(e?.message ?? 'Failed to load leaderboard'));
  }, []);

  const onSaveName = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setUsername(trimmed);
    setSaved(trimmed);
  };

  const canPlay = !!saved;

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12 space-y-10">
      {/* Hero */}
      <section className="space-y-4">
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">
          Bible · theology · trivia
        </div>
        <h1 className="font-display text-4xl sm:text-6xl font-black leading-[1.05] tracking-tight text-ink-900">
          Every question is fresh.<br />
          <span className="italic text-accent">Every answer teaches.</span>
        </h1>
        <div className="max-w-2xl space-y-3 text-ink-500 text-base sm:text-lg leading-relaxed">
          <p>
            A Bible trivia game whose questions are written by AI — which
            should worry you, and worried us enough to wrap every question in
            four fact-checks, one of which reads the actual verse from a real,
            public-domain Bible.
          </p>
          <p className="text-ink-400 italic">
            Worth understanding before you play.{' '}
            <Link
              to="/about"
              className="text-accent font-medium not-italic underline underline-offset-4 decoration-accent/60 hover:decoration-accent"
            >
              Read how it works
            </Link>
            .
          </p>
        </div>
      </section>

      {/* Name setter */}
      <section className="rounded-xl border border-rule bg-card p-5 space-y-3 shadow-[0_1px_0_rgba(0,0,0,0.03)]">
        <label className="block text-[11px] uppercase tracking-[0.2em] text-ink-400">
          Your name for the board
        </label>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md bg-page px-3 py-2.5 text-ink-800 border border-rule focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. David"
            maxLength={40}
            autoFocus={!saved}
            onKeyDown={(e) => { if (e.key === 'Enter') onSaveName(); }}
          />
          <button
            onClick={onSaveName}
            className="rounded-md bg-accent px-5 py-2.5 text-card font-semibold hover:bg-accent-soft transition"
          >
            Save
          </button>
        </div>
        {saved ? (
          <div className="text-[11px] text-ink-400">
            Saved. You&apos;ll be shown as <span className="text-accent font-medium">{saved}</span>.
          </div>
        ) : (
          <div className="text-[11px] text-ink-400 italic">
            Set a name to unlock play.
          </div>
        )}
      </section>

      {/* Play cards */}
      <section className="grid gap-3 sm:grid-cols-3">
        <PlayCard
          to={canPlay ? '/solo' : '#'}
          title="Play solo"
          subtitle="Learn through focused play"
          emphasis
          disabled={!canPlay}
        />
        <PlayCard
          to={canPlay ? '/room/new' : '#'}
          title="Start a room"
          subtitle="Host up to 50 players"
          disabled={!canPlay}
        />
        <PlayCard
          to={canPlay ? '/room/join' : '#'}
          title="Join a room"
          subtitle="Enter a code to play"
          disabled={!canPlay}
        />
      </section>

      {/* Hall of fame */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-display text-xl font-bold text-ink-700">
            Hall of fame
          </h2>
          <Link to="/hall-of-fame" className="text-xs text-accent hover:underline font-medium">
            Top 100 →
          </Link>
        </div>
        {err && <p className="text-sm text-no">{err}</p>}
        {!scores && !err && (
          <div className="h-40 rounded-xl border border-rule bg-card animate-pulse" />
        )}
        {scores && scores.length === 0 && (
          <div className="rounded-xl border border-rule bg-card p-5 text-sm text-ink-400 italic">
            No scores yet. Play a game and stake your claim on the board.
          </div>
        )}
        {scores && scores.length > 0 && (
          <ol className="rounded-xl border border-rule overflow-hidden bg-card">
            {scores.map((s, i) => (
              <li
                key={s.id}
                className={`flex items-center gap-3 px-4 py-2.5 ${
                  i === 0 ? 'bg-accent/5' : ''
                }`}
              >
                <span className="w-6 text-center text-lg">
                  {RANK_EMOJI[i] ?? <span className="font-mono text-sm text-ink-400">{i + 1}</span>}
                </span>
                <span className="flex-1 truncate font-medium text-ink-800">{s.username}</span>
                <div className="hidden sm:flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-400">
                  <Tag>{s.category}</Tag>
                  <Tag>{s.difficulty}</Tag>
                  <Tag>{s.pace}</Tag>
                </div>
                <span className="text-xs text-ink-400 hidden md:inline tabular-nums">
                  {formatTime(s.total_time_ms)}
                </span>
                <span className="font-mono text-accent tabular-nums text-lg font-semibold">{s.score}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function PlayCard({ to, title, subtitle, emphasis, disabled }: {
  to: string;
  title: string;
  subtitle: string;
  emphasis?: boolean;
  disabled?: boolean;
}) {
  const base = 'rounded-xl border p-5 transition relative overflow-hidden';
  const active = emphasis
    ? 'border-accent/40 bg-accent/5 hover:bg-accent/10 hover:border-accent/60'
    : 'border-rule bg-card hover:bg-page';
  const dim = 'opacity-50 cursor-not-allowed pointer-events-none';

  if (disabled) {
    return (
      <div className={`${base} ${active} ${dim}`}>
        <div className="font-display text-xl font-bold text-ink-800">{title}</div>
        <div className="text-xs text-ink-400 mt-1">{subtitle}</div>
      </div>
    );
  }
  return (
    <Link to={to} className={`${base} ${active}`}>
      <div className="font-display text-xl font-bold text-ink-800">{title}</div>
      <div className="text-xs text-ink-500 mt-1">{subtitle}</div>
    </Link>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-rule/70 bg-page px-1.5 py-0.5">
      {children}
    </span>
  );
}

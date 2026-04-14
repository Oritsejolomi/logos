import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CATEGORIES,
  createSoloSession,
  type Category,
  type Difficulty,
  type Pace,
  type QuestionCount,
  type SessionMode,
} from '../lib/api';
import { getPlayerUuid, getUsername, recentHashesForRequest } from '../lib/identity';

const MODES: { id: SessionMode; label: string; blurb: string }[] = [
  { id: 'fixed', label: 'Fixed', blurb: 'Pick a question count. Play till the end, post your score.' },
  { id: 'endless', label: 'Endless', blurb: '3 lives. Questions ramp up as you survive. +1 life every 7 correct in a row.' },
];
const DIFFICULTIES: Difficulty[] = ['beginner', 'intermediate', 'advanced'];
const PACES: Pace[] = ['speedy', 'arcade', 'meditative'];
const COUNTS: QuestionCount[] = [5, 10, 15];

export function SoloSetup() {
  const navigate = useNavigate();
  const [sessionMode, setSessionMode] = useState<SessionMode>('fixed');
  const [category, setCategory] = useState<Category>('Old Testament');
  const [difficulty, setDifficulty] = useState<Difficulty>('beginner');
  const [pace, setPace] = useState<Pace>('arcade');
  const [count, setCount] = useState<QuestionCount>(5);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const username = getUsername();
  const isEndless = sessionMode === 'endless';

  const start = async () => {
    setErr(null);
    if (!username) {
      setErr('Set your name on the home screen first.');
      return;
    }
    setBusy(true);
    try {
      const { session_id } = await createSoloSession({
        player_uuid: getPlayerUuid(),
        username,
        category,
        difficulty,
        pace,
        question_count: isEndless ? null : count,
        recent_hashes: recentHashesForRequest(),
        session_mode: sessionMode,
      });
      const qp = new URLSearchParams({
        session: session_id,
        category,
        difficulty,
        pace,
        count: isEndless ? '0' : String(count),
        mode: sessionMode,
      });
      navigate(`/solo/play?${qp.toString()}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-8 sm:py-10 space-y-7">
      <button
        onClick={() => navigate('/')}
        className="text-[11px] font-mono uppercase tracking-[0.2em] text-ink-400 hover:text-accent transition"
      >
        ← Back
      </button>
      <div className="space-y-1">
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">Solo</div>
        <h1 className="font-display text-3xl sm:text-4xl font-black text-ink-900">Set up your run</h1>
      </div>

      <Group label="Mode">
        <div className="grid grid-cols-2 gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setSessionMode(m.id)}
              className={`rounded-md border px-4 py-3 text-left transition ${
                sessionMode === m.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-rule bg-card text-ink-700 hover:bg-page hover:border-accent/40'
              }`}
            >
              <div className="text-sm font-semibold capitalize">{m.label}</div>
              <div className="text-[11px] mt-1 leading-snug text-ink-500">{m.blurb}</div>
            </button>
          ))}
        </div>
      </Group>

      <Group label="Category">
        <div className="grid grid-cols-2 gap-2">
          {CATEGORIES.map((c) => (
            <Pick key={c} active={category === c} onClick={() => setCategory(c)}>{c}</Pick>
          ))}
        </div>
      </Group>

      <Group label={isEndless ? 'Starting difficulty' : 'Difficulty'}>
        <div className="grid grid-cols-3 gap-2">
          {DIFFICULTIES.map((d) => (
            <Pick key={d} active={difficulty === d} onClick={() => setDifficulty(d)}>{d}</Pick>
          ))}
        </div>
        {isEndless && (
          <div className="text-[11px] text-ink-400 italic mt-2">
            Questions ramp up every 10 correct. Past Advanced, they keep getting harder.
          </div>
        )}
      </Group>

      <Group label="Pace">
        <div className="grid grid-cols-3 gap-2">
          {PACES.map((p) => (
            <Pick key={p} active={pace === p} onClick={() => setPace(p)}>{p}</Pick>
          ))}
        </div>
      </Group>

      {!isEndless && (
        <Group label="Question count">
          <div className="grid grid-cols-3 gap-2">
            {COUNTS.map((n) => (
              <Pick key={n} active={count === n} onClick={() => setCount(n)}>{n}</Pick>
            ))}
          </div>
        </Group>
      )}

      {err && <p className="text-sm text-no">{err}</p>}
      <button
        onClick={start}
        disabled={busy}
        className="w-full rounded-md bg-accent px-4 py-3 text-card font-semibold hover:bg-accent-soft disabled:opacity-50 transition"
      >
        {busy ? 'Starting…' : 'Begin'}
      </button>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.2em] text-ink-400 mb-2">{label}</div>
      {children}
    </div>
  );
}

function Pick({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-3 py-2.5 text-sm transition capitalize ${
        active
          ? 'border-accent bg-accent/10 text-accent font-semibold'
          : 'border-rule bg-card text-ink-600 hover:bg-page hover:border-accent/40'
      }`}
    >
      {children}
    </button>
  );
}

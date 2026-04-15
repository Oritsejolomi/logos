import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CATEGORIES,
  createSoloSession,
  type Category,
  type Difficulty,
  type Pace,
} from '../lib/api';
import { getPlayerUuid, getUsername, recentHashesForRequest } from '../lib/identity';

const DIFFICULTIES: Difficulty[] = ['beginner', 'intermediate', 'advanced'];
const PACES: Pace[] = ['speedy', 'arcade', 'meditative'];

export function SoloSetup() {
  const navigate = useNavigate();
  const [category, setCategory] = useState<Category>('Old Testament');
  const [difficulty, setDifficulty] = useState<Difficulty>('beginner');
  const [pace, setPace] = useState<Pace>('arcade');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const username = getUsername();

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
        question_count: null,
        recent_hashes: recentHashesForRequest(),
        session_mode: 'endless',
      });
      const qp = new URLSearchParams({
        session: session_id,
        category,
        difficulty,
        pace,
        count: '0',
        mode: 'endless',
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
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">Solo · Endless</div>
        <h1 className="font-display text-3xl sm:text-4xl font-black text-ink-900">Set up your run</h1>
        <p className="text-ink-500 text-sm italic">
          3 lives. Questions ramp up as you survive. +1 life every 7 correct in a row. Play until you run out.
        </p>
      </div>

      <Group label="Category">
        <div className="grid grid-cols-2 gap-2">
          {CATEGORIES.map((c) => (
            <Pick key={c} active={category === c} onClick={() => setCategory(c)}>{c}</Pick>
          ))}
        </div>
      </Group>

      <Group label="Starting difficulty">
        <div className="grid grid-cols-3 gap-2">
          {DIFFICULTIES.map((d) => (
            <Pick key={d} active={difficulty === d} onClick={() => setDifficulty(d)}>{d}</Pick>
          ))}
        </div>
        <div className="text-[11px] text-ink-400 italic mt-2">
          Questions ramp up every 10 correct. Past Advanced, they keep getting harder.
        </div>
      </Group>

      <Group label="Pace">
        <div className="grid grid-cols-3 gap-2">
          {PACES.map((p) => (
            <Pick key={p} active={pace === p} onClick={() => setPace(p)}>{p}</Pick>
          ))}
        </div>
      </Group>

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

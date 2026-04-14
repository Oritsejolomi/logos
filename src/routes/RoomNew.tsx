import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom, type Difficulty, type MpVariant, type Pace, type QuestionCount, type SessionMode } from '../lib/api';
import { getPlayerUuid, getUsername } from '../lib/identity';

const MODES: { id: SessionMode; label: string; blurb: string }[] = [
  { id: 'fixed', label: 'Fixed', blurb: 'Set a question count. Everyone plays to the end.' },
  { id: 'endless', label: 'Endless', blurb: 'Run until lives are gone. Questions ramp up as you survive. +1 life every 7 correct in a row.' },
];

const VARIANTS: { id: MpVariant; label: string; blurb: string }[] = [
  { id: 'battle_royale', label: 'Battle royale', blurb: 'Each player starts with 3 lives. Last one standing wins.' },
  { id: 'co_op', label: 'Co-op', blurb: 'Shared pool of 3 lives. Everyone ends together.' },
];

const DIFFICULTIES: Difficulty[] = ['beginner', 'intermediate', 'advanced'];
const PACES: Pace[] = ['speedy', 'arcade', 'meditative'];
const COUNTS: QuestionCount[] = [5, 10, 15];

export function RoomNew() {
  const navigate = useNavigate();
  const [sessionMode, setSessionMode] = useState<SessionMode>('fixed');
  const [mpVariant, setMpVariant] = useState<MpVariant>('battle_royale');
  const [difficulty, setDifficulty] = useState<Difficulty>('beginner');
  const [pace, setPace] = useState<Pace>('arcade');
  const [count, setCount] = useState<QuestionCount>(5);
  const [maxPlayers, setMaxPlayers] = useState(10);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const username = getUsername();
  const isEndless = sessionMode === 'endless';

  const start = async () => {
    setErr(null);
    if (!username) { setErr('Set your name on the home screen first.'); return; }
    setBusy(true);
    try {
      const room = await createRoom({
        host_player_uuid: getPlayerUuid(),
        host_username: username,
        difficulty,
        pace,
        question_count: isEndless ? null : count,
        max_players: maxPlayers,
        session_mode: sessionMode,
        mp_variant: isEndless ? mpVariant : undefined,
      });
      navigate(`/room/${room.room_code}/lobby?id=${room.room_id}`);
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
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">Multiplayer</div>
        <h1 className="font-display text-3xl sm:text-4xl font-black text-ink-900">Host a room</h1>
        <p className="text-ink-500 text-sm italic">
          You set the mode and difficulty. Category is picked by the room after everyone joins.
        </p>
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

      {isEndless && (
        <Group label="Endless variant">
          <div className="grid grid-cols-2 gap-2">
            {VARIANTS.map((v) => (
              <button
                key={v.id}
                onClick={() => setMpVariant(v.id)}
                className={`rounded-md border px-4 py-3 text-left transition ${
                  mpVariant === v.id
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-rule bg-card text-ink-700 hover:bg-page hover:border-accent/40'
                }`}
              >
                <div className="text-sm font-semibold">{v.label}</div>
                <div className="text-[11px] mt-1 leading-snug text-ink-500">{v.blurb}</div>
              </button>
            ))}
          </div>
        </Group>
      )}

      <Group label={isEndless ? 'Starting difficulty' : 'Difficulty'}>
        <div className="grid grid-cols-3 gap-2">
          {DIFFICULTIES.map((d) => (
            <Pick key={d} active={difficulty === d} onClick={() => setDifficulty(d)}>{d}</Pick>
          ))}
        </div>
        {isEndless && (
          <div className="text-[11px] text-ink-400 italic mt-2">
            Questions ramp every 10 rounds. Past Advanced, they keep getting harder.
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

      <Group label={`Max players · ${maxPlayers}`}>
        <input
          type="range"
          min={2}
          max={50}
          value={maxPlayers}
          onChange={(e) => setMaxPlayers(Number(e.target.value))}
          className="w-full accent-accent"
        />
        <div className="flex justify-between text-[10px] text-ink-400 mt-1 tracking-wider uppercase">
          <span>2</span><span>25</span><span>50</span>
        </div>
      </Group>

      {err && <p className="text-sm text-no">{err}</p>}
      <button
        onClick={start}
        disabled={busy}
        className="w-full rounded-md bg-accent px-4 py-3 text-card font-semibold hover:bg-accent-soft disabled:opacity-50 transition"
      >
        {busy ? 'Creating…' : 'Create room'}
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

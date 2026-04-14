import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, joinRoom } from '../lib/api';
import { getPlayerUuid, getUsername } from '../lib/identity';

function friendlyJoinError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "We couldn't find that room. Double-check the code.";
    if (e.status === 409) {
      const msg = e.message.toLowerCase();
      if (msg.includes('in_progress')) return 'This game has already started. Ask the host to spin up a new room.';
      if (msg.includes('generating')) return 'This game is about to start. Ask the host to spin up a new room.';
      if (msg.includes('finished')) return 'This game is already over. Ask the host to spin up a new room.';
      if (msg.includes('abandoned')) return 'This room was abandoned. Ask the host to spin up a new one.';
      if (msg.includes('full')) return e.message;
    }
  }
  return (e as Error).message;
}

export function RoomJoin() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const username = getUsername();

  const join = async () => {
    setErr(null);
    if (!username) { setErr('Set your name on the home screen first.'); return; }
    const cleaned = code.trim().toUpperCase();
    if (cleaned.length < 4) { setErr('Enter a valid room code.'); return; }
    setBusy(true);
    try {
      const room = await joinRoom({
        room_code: cleaned,
        player_uuid: getPlayerUuid(),
        username,
      });
      navigate(`/room/${room.room_code}/lobby?id=${room.room_id}`);
    } catch (e) {
      setErr(friendlyJoinError(e));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg px-4 sm:px-6 py-10 sm:py-14 space-y-6">
      <button
        onClick={() => navigate('/')}
        className="text-[11px] font-mono uppercase tracking-[0.2em] text-ink-400 hover:text-accent transition"
      >
        ← Back
      </button>
      <div className="space-y-1">
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">Multiplayer</div>
        <h1 className="font-display text-3xl sm:text-4xl font-black text-ink-900">Join a room</h1>
        <p className="text-ink-500 text-sm italic">
          Enter the six-character code your host shared with you.
        </p>
      </div>

      <div className="space-y-3">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6))}
          placeholder="ABCDEF"
          spellCheck={false}
          autoCapitalize="characters"
          className="w-full rounded-md bg-card px-4 py-5 text-3xl font-mono text-ink-900 tracking-[0.3em] text-center border border-rule focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition"
          onKeyDown={(e) => { if (e.key === 'Enter') join(); }}
        />
        {err && <p className="text-sm text-no">{err}</p>}
        <button
          onClick={join}
          disabled={busy || code.trim().length < 4}
          className="w-full rounded-md bg-accent px-4 py-3 text-card font-semibold hover:bg-accent-soft disabled:opacity-50 transition"
        >
          {busy ? 'Joining…' : 'Join'}
        </button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { startGame } from '../lib/api';
import { getPlayerUuid, getUsername } from '../lib/identity';
import { subscribeToRoom } from '../lib/realtime';
import { supabase } from '../lib/supabase';

interface PlayerRow {
  player_uuid: string;
  display_username: string;
  is_host: boolean;
  joined_at: string;
}

interface RoomRow {
  id: string;
  room_code: string;
  status: string;
  difficulty: string;
  pace: string;
  question_count: number;
  max_players: number;
  host_player_uuid: string;
}

export function RoomLobby() {
  const { code = '' } = useParams();
  const [params] = useSearchParams();
  const roomId = params.get('id') ?? '';
  const navigate = useNavigate();

  const [room, setRoom] = useState<RoomRow | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);

  const playerUuid = getPlayerUuid();
  const username = getUsername();

  const refreshPlayers = useCallback(async () => {
    if (!roomId) return;
    const { data } = await supabase
      .from('room_players')
      .select('player_uuid, display_username, is_host, joined_at')
      .eq('room_id', roomId)
      .order('joined_at', { ascending: true });
    if (data) setPlayers(data as PlayerRow[]);
  }, [roomId]);

  // Initial load.
  useEffect(() => {
    if (!roomId) { setErr('Missing room id'); return; }
    let cancelled = false;

    const load = async () => {
      const { data: roomData, error: roomErr } = await supabase
        .from('rooms')
        .select('id, room_code, status, difficulty, pace, question_count, max_players, host_player_uuid')
        .eq('id', roomId)
        .single();
      if (cancelled) return;
      if (roomErr || !roomData) { setErr(roomErr?.message ?? 'Room not found'); return; }
      setRoom(roomData as RoomRow);
      await refreshPlayers();
    };
    void load();
    return () => { cancelled = true; };
  }, [roomId, refreshPlayers]);

  // Live subscription: rooms row updates + any change to room_players.
  useEffect(() => {
    if (!roomId || !code) return;
    const unsub = subscribeToRoom(roomId, code, {
      onRoomUpdate: (row) => {
        setRoom((prev) => (prev ? { ...prev, ...(row as Partial<RoomRow>) } : prev));
      },
      onPlayerChange: () => {
        void refreshPlayers();
      },
    });
    return () => { unsub(); };
  }, [roomId, code, refreshPlayers]);

  // When the room transitions out of lobby, navigate into the play screen.
  useEffect(() => {
    if (!room) return;
    if (room.status === 'category_select' || room.status === 'generating' || room.status === 'in_progress') {
      navigate(`/room/${code}/play?id=${roomId}`, { replace: true });
    }
    if (room.status === 'abandoned' || room.status === 'finished') {
      setErr(`Room is ${room.status}`);
    }
  }, [room, navigate, code, roomId]);

  const isHost = !!room && room.host_player_uuid === playerUuid;

  const onStart = async () => {
    if (!room) return;
    setStarting(true);
    try {
      await startGame({ room_id: room.id, player_uuid: playerUuid });
      // The realtime subscription will pick up the status change and navigate.
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  };

  if (err) {
    return (
      <div className="mx-auto max-w-xl px-4 sm:px-6 py-10 space-y-4">
        <p className="text-no">{err}</p>
        <button onClick={() => navigate('/')} className="rounded-md border border-rule px-3 py-2 text-ink-600 hover:bg-card">
          Back to home
        </button>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="mx-auto max-w-xl px-4 sm:px-6 py-10">
        <p className="text-ink-400 italic">Loading room…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-8 sm:py-10 space-y-7">
      <div className="space-y-1">
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">Lobby</div>
        <h1 className="font-display text-3xl sm:text-4xl font-black text-ink-900">
          {isHost ? 'Your room' : 'Joined room'}
        </h1>
        <p className="text-ink-500 text-sm italic">
          {room.question_count} questions · {room.difficulty} · {room.pace} · up to {room.max_players} players
        </p>
      </div>

      {/* Room code */}
      <button
        onClick={copyCode}
        className="w-full rounded-xl border border-accent/30 bg-accent/5 p-6 text-left group hover:bg-accent/10 transition"
      >
        <div className="text-[11px] uppercase tracking-[0.2em] text-ink-400 mb-2">
          Share this code
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <div className="font-mono text-4xl sm:text-5xl font-bold tracking-[0.25em] text-accent">
            {code}
          </div>
          <span className="text-[11px] uppercase tracking-wider text-ink-400 group-hover:text-accent">
            {copied ? 'Copied' : 'Tap to copy'}
          </span>
        </div>
      </button>

      {/* Player list */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <div className="text-[11px] uppercase tracking-[0.2em] text-ink-400">
            Players
          </div>
          <div className="text-[11px] text-ink-400 tabular-nums font-mono">
            {players.length} / {room.max_players}
          </div>
        </div>
        <ul className="rounded-xl border border-rule overflow-hidden bg-card">
          {players.map((p) => {
            const you = p.player_uuid === playerUuid;
            return (
              <li key={p.player_uuid} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={p.display_username} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-ink-800 truncate">
                    {p.display_username}
                    {you && <span className="ml-2 text-[10px] uppercase tracking-wider text-accent">You</span>}
                  </div>
                </div>
                {p.is_host && (
                  <span className="text-[10px] uppercase tracking-wider text-ink-400">Host</span>
                )}
              </li>
            );
          })}
          {players.length < room.max_players && (
            <li className="px-4 py-3 text-sm text-ink-400 italic">Waiting for more players…</li>
          )}
        </ul>
      </div>

      {/* Start button */}
      {isHost ? (
        <button
          onClick={onStart}
          disabled={starting || players.length < 1}
          className="w-full rounded-md bg-accent px-4 py-3 text-card font-semibold hover:bg-accent-soft disabled:opacity-50 transition"
        >
          {starting ? 'Starting…' : players.length < 2 ? 'Start anyway (solo in room)' : 'Start game'}
        </button>
      ) : (
        <div className="rounded-md border border-rule bg-card p-4 text-center text-sm text-ink-500 italic">
          Waiting for the host to start the game…
        </div>
      )}

      {!username && (
        <p className="text-xs text-no text-center">
          You haven&apos;t set a name yet. Go back to the home screen first.
        </p>
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className="flex h-9 w-9 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-xs font-semibold text-accent">
      {initials || '?'}
    </span>
  );
}

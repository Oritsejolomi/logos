import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CATEGORIES,
  getMpQuestion,
  postScore,
  startRoomQuestions,
  submitCategoryPick,
  submitMpAnswer,
  tickRoom,
  type Category,
  type MultiplayerQuestion,
} from '../lib/api';
import { getPlayerUuid, getUsername } from '../lib/identity';
import { subscribeToRoom, type RoundClosedPayload } from '../lib/realtime';
import { supabase } from '../lib/supabase';

interface RoomRow {
  id: string;
  room_code: string;
  status: 'lobby' | 'category_select' | 'generating' | 'in_progress' | 'finished' | 'abandoned';
  category: Category | null;
  difficulty: string;
  pace: string;
  question_count: number;
  max_players: number;
  host_player_uuid: string;
  current_q_index: number;
  current_q_opened_at: string | null;
  current_q_ends_at: string | null;
  category_select_ends_at: string | null;
}

interface PlayerRow {
  player_uuid: string;
  display_username: string;
  is_host: boolean;
  score: number;
  streak: number;
  multiplier: number;
  has_picked: boolean;
  category_pick: string | null;
}

export function RoomPlay() {
  const { code = '' } = useParams();
  const [params] = useSearchParams();
  const roomId = params.get('id') ?? '';
  const navigate = useNavigate();

  const [room, setRoom] = useState<RoomRow | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [question, setQuestion] = useState<MultiplayerQuestion | null>(null);
  const [myPick, setMyPick] = useState<number | null>(null);
  const [picked, setPicked] = useState(false);
  const [myCategoryPick, setMyCategoryPick] = useState<Category | null>(null);
  const [reveal, setReveal] = useState<RoundClosedPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [postingScore, setPostingScore] = useState(false);
  const [postedRank, setPostedRank] = useState<number | null>(null);

  const playerUuid = getPlayerUuid();
  const lastFetchedIndex = useRef<number | null>(null);
  const generationTriggered = useRef(false);

  // ---- Data loading helpers ----

  const refreshRoom = useCallback(async () => {
    if (!roomId) return;
    const { data } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId)
      .single();
    if (data) setRoom(data as RoomRow);
  }, [roomId]);

  const refreshPlayers = useCallback(async () => {
    if (!roomId) return;
    const { data } = await supabase
      .from('room_players')
      .select('player_uuid, display_username, is_host, score, streak, multiplier, has_picked, category_pick')
      .eq('room_id', roomId)
      .order('score', { ascending: false });
    if (data) setPlayers(data as PlayerRow[]);
  }, [roomId]);

  // Initial load.
  useEffect(() => {
    if (!roomId) { setErr('Missing room id'); return; }
    void refreshRoom();
    void refreshPlayers();
  }, [roomId, refreshRoom, refreshPlayers]);

  // Realtime subscription.
  useEffect(() => {
    if (!roomId || !code) return;
    const unsub = subscribeToRoom(roomId, code, {
      onRoomUpdate: (row) => setRoom((prev) => (prev ? { ...prev, ...(row as Partial<RoomRow>) } : prev)),
      onPlayerChange: () => { void refreshPlayers(); },
      onAnswerInserted: () => { void refreshPlayers(); },
      onRoundClosed: (payload) => {
        setReveal(payload);
        setQuestion(null);
        setMyPick(null);
        // Refresh players so the standings reflect the new scores from the reveal.
        void refreshPlayers();
      },
    });
    return () => { unsub(); };
  }, [roomId, code, refreshPlayers]);

  // Clock — wall time updates at 10Hz for countdown bars.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  // Tick-room driver — every 500ms while active.
  useEffect(() => {
    if (!room) return;
    if (!['category_select', 'generating', 'in_progress'].includes(room.status)) return;
    const id = setInterval(() => {
      void tickRoom({ room_id: room.id }).catch(() => undefined);
    }, 500);
    return () => clearInterval(id);
  }, [room?.status, room?.id]);

  // Auto-trigger start-room-questions once we enter 'generating'.
  useEffect(() => {
    if (!room || room.status !== 'generating') return;
    if (generationTriggered.current) return;
    generationTriggered.current = true;
    void startRoomQuestions({ room_id: room.id }).catch(() => undefined);
  }, [room?.status, room?.id]);

  // Fetch the current question when we enter in_progress and current_q_index advances.
  useEffect(() => {
    if (!room || room.status !== 'in_progress') return;
    if (!room.current_q_opened_at) return;
    const opened = new Date(room.current_q_opened_at).getTime();
    if (Date.now() < opened) return; // insight window
    if (lastFetchedIndex.current === room.current_q_index) return;
    lastFetchedIndex.current = room.current_q_index;
    void getMpQuestion({ room_id: room.id })
      .then((q) => { setQuestion(q); setReveal(null); setMyPick(null); setPicked(false); })
      .catch((e) => setErr((e as Error).message));
  }, [room?.status, room?.current_q_index, room?.current_q_opened_at, room?.id, now]);

  // Navigate back home on abandonment.
  useEffect(() => {
    if (room?.status === 'abandoned') {
      setErr('Room was abandoned');
    }
  }, [room?.status]);

  // ---- Handlers ----

  const onCategoryPick = async (cat: Category) => {
    if (!room || picked) return;
    setMyCategoryPick(cat);
    setPicked(true);
    try {
      await submitCategoryPick({ room_id: room.id, player_uuid: playerUuid, category: cat });
    } catch (e) {
      setErr((e as Error).message);
      setPicked(false);
    }
  };

  const onAnswer = async (idx: number) => {
    if (!room || !question || myPick !== null) return;
    setMyPick(idx);
    try {
      await submitMpAnswer({ room_id: room.id, player_uuid: playerUuid, selected_index: idx });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const submitToHallOfFame = async () => {
    const username = getUsername();
    if (!room || !username) { setErr('Set your name first'); return; }
    setPostingScore(true);
    try {
      const res = await postScore({
        session_id: room.id,
        player_uuid: playerUuid,
        username,
        mode: 'multiplayer',
      });
      setPostedRank(res.rank);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPostingScore(false);
    }
  };

  // ---- Render ----

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
    return <div className="mx-auto max-w-xl px-4 sm:px-6 py-10 text-ink-400 italic">Loading room…</div>;
  }

  // Category pick phase
  if (room.status === 'category_select') {
    const endsAt = room.category_select_ends_at ? new Date(room.category_select_ends_at).getTime() : 0;
    const remaining = Math.max(0, endsAt - now);
    const pickedCount = players.filter((p) => p.has_picked).length;
    return (
      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
        <div className="space-y-1">
          <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">
            Pick a category
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-ink-900">
            {pickedCount} of {players.length} have picked
          </h1>
        </div>
        <CountdownBar ms={remaining} totalMs={10_000} label={`${(remaining / 1000).toFixed(1)}s`} />
        <div className="grid grid-cols-2 gap-2">
          {CATEGORIES.map((c) => {
            const isMine = myCategoryPick === c;
            return (
              <button
                key={c}
                onClick={() => onCategoryPick(c)}
                disabled={picked}
                className={`rounded-md border px-4 py-4 text-left text-sm transition ${
                  isMine
                    ? 'border-accent bg-accent/10 text-accent font-semibold'
                    : 'border-rule bg-card text-ink-800 hover:border-accent/50 hover:bg-page disabled:opacity-50'
                }`}
              >
                {c}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-ink-400 italic text-center">
          If no one picks, a random category is chosen.
        </p>
      </div>
    );
  }

  // Generating phase
  if (room.status === 'generating') {
    return (
      <div className="mx-auto max-w-lg px-4 sm:px-6 py-14 space-y-5 text-center">
        <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">
          Preparing arena
        </div>
        <h1 className="font-display text-3xl sm:text-4xl font-black text-ink-900">
          Writing {room.question_count} questions…
        </h1>
        <p className="text-ink-500 text-sm italic">
          Questions are generated fresh and fact-checked against Scripture.
        </p>
        <div className="mx-auto max-w-sm">
          <PulseBar />
        </div>
      </div>
    );
  }

  // Finished phase
  if (room.status === 'finished') {
    const me = players.find((p) => p.player_uuid === playerUuid);
    const winner = players[0];
    const isWinner = me?.player_uuid === winner?.player_uuid;
    return (
      <div className="mx-auto max-w-xl px-4 sm:px-6 py-10 space-y-6">
        <div className="space-y-1">
          <div className="text-[11px] font-mono uppercase tracking-[0.28em] text-accent">Game over</div>
          <h1 className="font-display text-4xl sm:text-5xl font-black text-ink-900">
            {isWinner ? 'You won!' : winner ? `${winner.display_username} wins` : 'Game over'}
          </h1>
        </div>
        <ul className="rounded-xl border border-rule overflow-hidden bg-card">
          {players.map((p, i) => {
            const you = p.player_uuid === playerUuid;
            return (
              <li
                key={p.player_uuid}
                className={`flex items-center gap-3 px-4 py-3 ${i === 0 ? 'bg-accent/5' : ''}`}
              >
                <span className="w-6 text-center">
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (
                    <span className="font-mono text-sm text-ink-400">{i + 1}</span>
                  )}
                </span>
                <span className="flex-1 truncate font-medium text-ink-800">
                  {p.display_username}
                  {you && <span className="ml-2 text-[10px] uppercase tracking-wider text-accent">You</span>}
                </span>
                <span className="font-mono text-accent tabular-nums text-lg font-semibold">{p.score}</span>
              </li>
            );
          })}
        </ul>
        {postedRank === null ? (
          <button
            onClick={submitToHallOfFame}
            disabled={postingScore}
            className="w-full rounded-md bg-accent px-4 py-3 text-card font-semibold hover:bg-accent-soft disabled:opacity-50 transition"
          >
            {postingScore ? 'Posting…' : 'Post my score to the hall of fame'}
          </button>
        ) : (
          <div className="rounded-md border border-yes/40 bg-yes/5 p-4 text-sm text-yes">
            Posted. You landed at rank <span className="font-mono text-accent">#{postedRank}</span>.
          </div>
        )}
        <button
          onClick={() => navigate('/')}
          className="w-full rounded-md border border-rule px-4 py-3 text-ink-600 hover:bg-card"
        >
          Back to home
        </button>
      </div>
    );
  }

  // in_progress — either the question is live or we're in an insight window.
  const opened = room.current_q_opened_at ? new Date(room.current_q_opened_at).getTime() : 0;
  const ends = room.current_q_ends_at ? new Date(room.current_q_ends_at).getTime() : 0;
  const inInsightWindow = now < opened && reveal !== null;

  if (inInsightWindow && reveal) {
    return <InsightView reveal={reveal} room={room} playerUuid={playerUuid} now={now} />;
  }

  if (!question) {
    return (
      <div className="mx-auto max-w-xl px-4 sm:px-6 py-10">
        <PulseBar />
        <p className="text-ink-400 text-sm mt-4 italic">Loading next question…</p>
      </div>
    );
  }

  const totalMs = ends - opened;
  const remaining = Math.max(0, ends - now);
  const me = players.find((p) => p.player_uuid === playerUuid);

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6 sm:py-8 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-ink-400">
          Q {question.question_index + 1} / {room.question_count} · {room.category}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-ink-400 text-xs uppercase tracking-wider">Score</span>
          <span className="font-mono text-lg text-accent font-bold tabular-nums">
            {me?.score ?? 0}
          </span>
        </div>
      </div>

      <CountdownBar ms={remaining} totalMs={totalMs} label={`${(remaining / 1000).toFixed(1)}s`} />

      <h2 className="font-display text-2xl sm:text-3xl font-bold leading-snug text-ink-900">
        {question.question_text}
      </h2>

      <div className="space-y-2">
        {question.options.map((opt, i) => {
          const isMine = myPick === i;
          const locked = myPick !== null;
          return (
            <button
              key={i}
              onClick={() => onAnswer(i)}
              disabled={locked}
              className={`group w-full rounded-md border px-4 py-3 text-left transition ${
                isMine
                  ? 'border-accent bg-accent/10 text-accent'
                  : locked
                    ? 'border-rule bg-card text-ink-400 cursor-default'
                    : 'border-rule bg-card text-ink-800 hover:bg-page hover:border-accent/60'
              }`}
            >
              <span className="mr-3 font-mono text-xs text-ink-400">
                {String.fromCharCode(65 + i)}
              </span>
              {opt}
            </button>
          );
        })}
      </div>

      <AnswerPips players={players} playerUuid={playerUuid} />

      {/* Live standings strip */}
      <div className="rounded-xl border border-rule bg-card p-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-400 mb-2">Standings</div>
        <div className="grid gap-1.5">
          {players.map((p, i) => {
            const you = p.player_uuid === playerUuid;
            return (
              <div
                key={p.player_uuid}
                className="flex items-center gap-2 text-sm"
              >
                <span className="w-4 text-center font-mono text-xs text-ink-400">{i + 1}</span>
                <span className="flex-1 truncate">
                  <span className="text-ink-800">{p.display_username}</span>
                  {you && <span className="ml-1 text-[10px] uppercase tracking-wider text-accent">You</span>}
                </span>
                {p.streak >= 2 && (
                  <span className="text-[10px] font-mono text-accent">×{p.multiplier}</span>
                )}
                <span className="font-mono text-accent tabular-nums font-semibold">{p.score}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- Sub-components ----

function InsightView({
  reveal,
  room,
  playerUuid,
  now,
}: {
  reveal: RoundClosedPayload;
  room: RoomRow;
  playerUuid: string;
  now: number;
}) {
  const me = reveal.player_results.find((p) => p.player_uuid === playerUuid);
  const nextOpensAt = room.current_q_opened_at ? new Date(room.current_q_opened_at).getTime() : 0;
  const remaining = Math.max(0, nextOpensAt - now);

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6 sm:py-8 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-ink-400">
          Round {reveal.closed_index + 1} · revealed
        </div>
        {!reveal.is_final && (
          <div className="text-[11px] font-mono text-ink-400 tabular-nums">
            Next in {(remaining / 1000).toFixed(1)}s
          </div>
        )}
      </div>

      <div className={`rounded-xl border ${me?.is_correct ? 'border-yes/40 bg-yes/5' : 'border-no/40 bg-no/5'} p-5`}>
        <div className={`text-[11px] uppercase tracking-[0.2em] mb-2 ${me?.is_correct ? 'text-yes' : 'text-no'}`}>
          {me?.is_correct ? `Correct · +${me.points_awarded}` : me ? 'Not quite' : 'No answer'}
        </div>
        <div className="text-[10px] uppercase tracking-[0.22em] text-accent font-semibold mb-1">Insight</div>
        <p className="font-display text-base text-ink-800 leading-relaxed">{reveal.insight}</p>
        <div className="text-xs text-ink-500 font-mono mt-2">{reveal.scripture_ref}</div>
      </div>

      {/* Who picked what */}
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-400">
          Who picked what
        </div>
        <div className="grid gap-1.5">
          {reveal.player_results.map((r) => (
            <div key={r.player_uuid} className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate text-ink-800">{r.display_username}</span>
              <span className={`text-xs ${r.is_correct ? 'text-yes' : r.selected_index === null ? 'text-ink-400 italic' : 'text-no'}`}>
                {r.selected_index === null ? 'No answer' : `Option ${String.fromCharCode(65 + r.selected_index)}`}
              </span>
              <span className="font-mono text-accent tabular-nums font-semibold">+{r.points_awarded}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CountdownBar({ ms, totalMs, label }: { ms: number; totalMs: number; label: string }) {
  const pct = totalMs > 0 ? Math.max(0, (ms / totalMs) * 100) : 0;
  const low = pct < 30;
  const critical = pct < 10;
  const color = critical ? 'bg-no' : low ? 'bg-accent-soft' : 'bg-accent';
  return (
    <div className="space-y-1">
      <div className="h-1.5 rounded-full bg-rule/60 overflow-hidden">
        <div
          className={`h-full ${color} ${critical ? 'animate-pulse' : ''} transition-[width] duration-100 ease-linear`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className={`text-right text-xs font-mono tabular-nums ${critical ? 'text-no' : 'text-ink-400'}`}>
        {label}
      </div>
    </div>
  );
}

function AnswerPips({ players, playerUuid }: { players: PlayerRow[]; playerUuid: string }) {
  // At 15+ players we'd collapse to a counter, but for the common case just
  // show a pip per player. The pip fills if the server has recorded their
  // answer. We derive that via realtime updates to room_players (eventually
  // consistent — may lag by a few hundred ms). For visual feedback this is fine.
  if (players.length > 15) {
    return (
      <div className="text-[11px] uppercase tracking-wider text-ink-400 text-center">
        {/* Compact counter mode — TODO wire to actual answer count */}
        Live standings update in real time
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 justify-center flex-wrap">
      {players.map((p) => {
        const you = p.player_uuid === playerUuid;
        return (
          <span
            key={p.player_uuid}
            title={p.display_username}
            className={`h-2 w-6 rounded-full ${
              you ? 'bg-accent' : 'bg-rule'
            }`}
          />
        );
      })}
    </div>
  );
}

function PulseBar() {
  return (
    <div className="h-2 rounded-full bg-rule/60 overflow-hidden">
      <div className="h-full w-1/3 bg-accent/60 animate-pulse" />
    </div>
  );
}

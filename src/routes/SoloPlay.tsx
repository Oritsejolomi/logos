import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  flagQuestion,
  getSoloQuestion,
  getSoloState,
  postScore,
  queueSoloQuestions,
  submitSoloAnswer,
  type SoloAnswerResult,
  type SoloQuestion,
} from '../lib/api';
import {
  getPlayerUuid,
  getUsername,
  recentHashesForRequest,
  recordQuestionSeen,
} from '../lib/identity';

type Phase = 'loading' | 'question' | 'reveal' | 'finished';

export function SoloPlay() {
  const [params] = useSearchParams();
  const sessionId = params.get('session') ?? '';
  const category = params.get('category') ?? '';
  const difficulty = params.get('difficulty') ?? '';
  const pace = params.get('pace') ?? '';
  const questionCount = Number(params.get('count') ?? '5');
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('loading');
  const [question, setQuestion] = useState<SoloQuestion | null>(null);
  const [result, setResult] = useState<SoloAnswerResult | null>(null);
  const [lastPick, setLastPick] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [streakPulse, setStreakPulse] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [postingScore, setPostingScore] = useState(false);
  const [postedRank, setPostedRank] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [flagged, setFlagged] = useState(false);
  const [flagging, setFlagging] = useState(false);

  const playerUuid = getPlayerUuid();

  const loadQuestion = async () => {
    setErr(null);
    setPhase('loading');
    setQuestion(null);
    setResult(null);
    setLastPick(null);
    try {
      const q = await getSoloQuestion({
        session_id: sessionId,
        player_uuid: playerUuid,
        recent_hashes: recentHashesForRequest(),
      });
      setQuestion(q);
      setFlagged(false);
      setPhase('question');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    if (!sessionId) { setErr('No session id in URL'); return; }

    // Check session status first. If the session is already finished (e.g.
    // the user navigated here via a direct URL after posting their score),
    // jump straight to the finished phase instead of trying to load Q1 —
    // which would hit a 409 from get-question and render a raw error page.
    (async () => {
      try {
        const state = await getSoloState({ session_id: sessionId, player_uuid: playerUuid });
        if (state.status === 'finished') {
          setScore(state.score);
          setStreak(state.streak);
          setPhase('finished');
          return;
        }
        if (state.status === 'abandoned') {
          setErr('This session was abandoned. Start a new one from the home screen.');
          return;
        }
        // Active session — load Q1 and kick off the queue filler.
        void loadQuestion();
        void queueSoloQuestions({ session_id: sessionId, player_uuid: playerUuid }).catch(() => undefined);
      } catch (e) {
        setErr((e as Error).message);
      }
    })();

  }, [sessionId]);

  useEffect(() => {
    if (phase !== 'question' || !question) return;
    const openedMs = new Date(question.opened_at).getTime();
    const deadline = openedMs + question.timer_seconds * 1000;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      setTimeLeft(remaining);
      if (remaining === 0) void onAnswer(null);
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);

  }, [phase, question]);

  useEffect(() => {
    if (streak >= 2) {
      setStreakPulse(true);
      const t = setTimeout(() => setStreakPulse(false), 420);
      return () => clearTimeout(t);
    }
  }, [streak]);

  const onAnswer = async (idx: number | null) => {
    if (phase !== 'question' || !question) return;
    setLastPick(idx);
    setPhase('loading');
    try {
      const r = await submitSoloAnswer({
        session_id: sessionId,
        player_uuid: playerUuid,
        selected_index: idx,
      });
      // Record the content hash (not the question_id UUID) so cross-session
      // dedup actually works. Fixed bug: was previously slicing question_id.
      if (question.content_hash_16) {
        recordQuestionSeen(question.content_hash_16);
      }
      setResult(r);
      setScore(r.new_score);
      setStreak(r.new_streak);
      setPhase(r.session_status === 'finished' ? 'finished' : 'reveal');
    } catch (e) {
      setErr((e as Error).message);
      setPhase('question');
    }
  };

  const nextQuestion = () => {
    void loadQuestion();
  };

  const submitToHallOfFame = async () => {
    const username = getUsername();
    if (!username) { setErr('Set your name on the home screen first'); return; }
    setPostingScore(true);
    try {
      const res = await postScore({
        session_id: sessionId,
        player_uuid: playerUuid,
        username,
        mode: 'solo',
      });
      setPostedRank(res.rank);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPostingScore(false);
    }
  };

  const onFlag = async () => {
    if (!question || flagged || flagging) return;
    setFlagging(true);
    try {
      await flagQuestion({ question_id: question.question_id, player_uuid: playerUuid, reason: 'user reported from reveal' });
      setFlagged(true);
    } catch { /* swallow */ } finally { setFlagging(false); }
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

  if (phase === 'loading' && !question) {
    return (
      <div className="mx-auto max-w-xl px-4 sm:px-6 py-10">
        <PulseBar />
        <p className="text-ink-400 text-sm mt-4 italic">Preparing your question…</p>
      </div>
    );
  }

  if (phase === 'finished') {
    return (
      <div className="mx-auto max-w-xl px-4 sm:px-6 py-10 space-y-5">
        <ContextChips category={category} difficulty={difficulty} pace={pace} />
        <h1 className="font-display text-4xl sm:text-5xl font-black text-ink-900">Game over</h1>
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-6">
          <div className="text-[11px] uppercase tracking-[0.2em] text-ink-400">Final score</div>
          <div className="font-mono text-6xl text-accent tabular-nums mt-1 font-bold">{score}</div>
          <div className="text-xs text-ink-400 mt-2">Max streak · ×{streak > 1 ? streak : 1}</div>
        </div>
        {postedRank === null ? (
          <button
            onClick={submitToHallOfFame}
            disabled={postingScore}
            className="w-full rounded-md bg-accent px-4 py-3 text-card font-semibold hover:bg-accent-soft disabled:opacity-50 transition"
          >
            {postingScore ? 'Posting…' : 'Post to hall of fame'}
          </button>
        ) : (
          <div className="rounded-md border border-yes/40 bg-yes/5 p-4 text-sm text-yes">
            Posted. You landed at rank <span className="font-mono text-accent">#{postedRank}</span>.
          </div>
        )}
        <button
          onClick={() => navigate('/')}
          className="w-full rounded-md border border-rule px-4 py-3 text-ink-600 hover:bg-card transition"
        >
          Back to home
        </button>
      </div>
    );
  }

  if (phase === 'reveal' && result && question) {
    return (
      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6 sm:py-8 space-y-5">
        <TopBar
          category={category}
          difficulty={difficulty}
          pace={pace}
          index={question.question_index}
          total={questionCount}
          score={score}
          streak={streak}
          streakPulse={streakPulse}
        />
        <h2 className="font-display text-2xl sm:text-3xl font-bold leading-snug text-ink-900">
          {question.question_text}
        </h2>
        <div className="space-y-2">
          {question.options.map((opt, i) => {
            const isCorrect = i === result.correct_index;
            const isWrongPick = lastPick === i && !result.is_correct;
            const base = 'rounded-md border px-4 py-3 text-sm transition';
            const className = isCorrect
              ? `${base} border-yes bg-yes/10 text-yes font-medium`
              : isWrongPick
                ? `${base} border-no bg-no/10 text-no line-through`
                : `${base} border-rule text-ink-400`;
            return (
              <div key={i} className={className}>
                <span className="mr-3 font-mono text-xs opacity-70">{String.fromCharCode(65 + i)}</span>
                {opt}
              </div>
            );
          })}
        </div>
        <InsightCard
          insight={result.insight}
          scriptureRef={result.scripture_ref}
          correctBanner={
            result.is_correct
              ? `Correct · +${result.points_awarded} points${result.multiplier > 1 ? ` (×${result.multiplier})` : ''}`
              : lastPick === null ? 'Timed out' : 'Not quite'
          }
          isCorrect={result.is_correct}
          flagged={flagged}
          flagging={flagging}
          onFlag={onFlag}
        />
        <button
          onClick={nextQuestion}
          className="w-full rounded-md bg-accent px-4 py-3 text-card font-semibold hover:bg-accent-soft transition"
        >
          Next question
        </button>
      </div>
    );
  }

  if (question) {
    const totalMs = question.timer_seconds * 1000;
    const pct = timeLeft === null ? 100 : Math.max(0, (timeLeft / totalMs) * 100);
    return (
      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6 sm:py-8 space-y-5">
        <TopBar
          category={category}
          difficulty={difficulty}
          pace={pace}
          index={question.question_index}
          total={questionCount}
          score={score}
          streak={streak}
          streakPulse={streakPulse}
        />
        <TimerBar pct={pct} timeLeftMs={timeLeft ?? totalMs} />
        <h2 className="font-display text-2xl sm:text-3xl font-bold leading-snug text-ink-900">
          {question.question_text}
        </h2>
        <div className="space-y-2">
          {question.options.map((opt, i) => (
            <button
              key={i}
              onClick={() => onAnswer(i)}
              className="group w-full rounded-md border border-rule bg-card px-4 py-3 text-left hover:bg-page hover:border-accent/60 transition"
            >
              <span className="mr-3 font-mono text-xs text-ink-400 group-hover:text-accent">
                {String.fromCharCode(65 + i)}
              </span>
              <span className="text-ink-800">{opt}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

function TopBar(props: {
  category: string;
  difficulty: string;
  pace: string;
  index: number;
  total: number;
  score: number;
  streak: number;
  streakPulse: boolean;
}) {
  return (
    <div className="space-y-3">
      <ContextChips category={props.category} difficulty={props.difficulty} pace={props.pace} />
      <div className="flex items-center justify-between gap-3">
        <ProgressDots index={props.index} total={props.total} />
        <div className="flex items-center gap-3 text-sm">
          <span className="text-ink-400 text-xs uppercase tracking-wider">Score</span>
          <span className="font-mono text-lg text-accent font-bold tabular-nums">{props.score}</span>
          {props.streak >= 2 && <StreakBadge streak={props.streak} pulse={props.streakPulse} />}
        </div>
      </div>
    </div>
  );
}

function ContextChips({ category, difficulty, pace }: { category: string; difficulty: string; pace: string }) {
  const chips = [category, difficulty, pace].filter(Boolean);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.15em] text-ink-400">
      {chips.map((c, i) => (
        <span key={i} className="rounded border border-rule/70 bg-card px-2 py-0.5">
          {c}
        </span>
      ))}
    </div>
  );
}

function ProgressDots({ index, total }: { index: number; total: number }) {
  const dots = Array.from({ length: total }, (_, i) => i);
  return (
    <div className="flex items-center gap-1">
      {dots.map((i) => {
        const state = i < index ? 'done' : i === index ? 'active' : 'pending';
        const cls =
          state === 'done' ? 'bg-yes'
          : state === 'active' ? 'bg-accent ring-2 ring-accent/20'
          : 'bg-rule';
        return <span key={i} className={`h-2 w-2 rounded-full ${cls}`} />;
      })}
    </div>
  );
}

function StreakBadge({ streak, pulse }: { streak: number; pulse: boolean }) {
  const mult = streak >= 5 ? '1.5' : streak === 4 ? '1.3' : streak === 3 ? '1.2' : streak === 2 ? '1.1' : '1.0';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs font-mono text-accent font-medium transition-transform duration-300 ${
        pulse ? 'scale-125' : 'scale-100'
      }`}
      title={`${streak} in a row · ×${mult} multiplier`}
    >
      🔥 {streak} · ×{mult}
    </span>
  );
}

function TimerBar({ pct, timeLeftMs }: { pct: number; timeLeftMs: number }) {
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
        {(timeLeftMs / 1000).toFixed(1)}s
      </div>
    </div>
  );
}

function InsightCard(props: {
  insight: string;
  scriptureRef: string;
  correctBanner: string;
  isCorrect: boolean;
  flagged: boolean;
  flagging: boolean;
  onFlag: () => void;
}) {
  return (
    <div className="rounded-xl border border-rule bg-card overflow-hidden shadow-[0_1px_0_rgba(0,0,0,0.03)]">
      <div
        className={`flex items-center justify-between px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] ${
          props.isCorrect ? 'bg-yes/10 text-yes' : 'bg-no/10 text-no'
        }`}
      >
        <span>{props.correctBanner}</span>
        <button
          onClick={props.onFlag}
          disabled={props.flagged || props.flagging}
          className="text-[10px] font-medium tracking-[0.15em] text-ink-400 hover:text-no disabled:text-ink-300 disabled:cursor-default transition normal-case"
        >
          {props.flagged ? '✓ Flagged' : props.flagging ? 'Flagging…' : 'Flag this question'}
        </button>
      </div>
      <div className="p-5 space-y-3">
        <div className="text-[10px] uppercase tracking-[0.22em] text-accent font-semibold">Insight</div>
        <p className="font-display text-base text-ink-800 leading-relaxed whitespace-pre-wrap">
          {props.insight}
        </p>
        <div className="text-xs text-ink-500 font-mono">{props.scriptureRef}</div>
      </div>
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

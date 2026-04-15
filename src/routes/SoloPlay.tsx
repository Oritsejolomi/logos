import { useEffect, useRef, useState } from 'react';
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

const ENDLESS_MAX_LIVES = 3;

export function SoloPlay() {
  const [params] = useSearchParams();
  const sessionId = params.get('session') ?? '';
  const category = params.get('category') ?? '';
  const difficulty = params.get('difficulty') ?? '';
  const pace = params.get('pace') ?? '';
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('loading');
  const [question, setQuestion] = useState<SoloQuestion | null>(null);
  const [result, setResult] = useState<SoloAnswerResult | null>(null);
  const [lastPick, setLastPick] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [streakPulse, setStreakPulse] = useState(false);
  const [lives, setLives] = useState<number>(ENDLESS_MAX_LIVES);
  const [correctCount, setCorrectCount] = useState(0);
  const [questionsSurvived, setQuestionsSurvived] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [postingScore, setPostingScore] = useState(false);
  const [postedRank, setPostedRank] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [flagged, setFlagged] = useState(false);
  const [flagging, setFlagging] = useState(false);
  // pendingPick: display-slot index of selected option
  const [pendingPick, _setPendingPick] = useState<number | null>(null);
  const pendingPickRef = useRef<number | null>(null);
  const setPendingPick = (v: number | null) => {
    pendingPickRef.current = v;
    _setPendingPick(v);
  };
  // shuffleOrder[displaySlot] = originalOptionIndex — randomised per question
  const [shuffleOrder, _setShuffleOrder] = useState<number[]>([0, 1, 2, 3]);
  const shuffleOrderRef = useRef<number[]>([0, 1, 2, 3]);
  const setShuffleOrder = (v: number[]) => {
    shuffleOrderRef.current = v;
    _setShuffleOrder(v);
  };

  const playerUuid = getPlayerUuid();

  const loadQuestion = async () => {
    setErr(null);
    setPhase('loading');
    setQuestion(null);
    setResult(null);
    setLastPick(null);
    setPendingPick(null);
    try {
      const q = await getSoloQuestion({
        session_id: sessionId,
        player_uuid: playerUuid,
        recent_hashes: recentHashesForRequest(),
      });
      setShuffleOrder([0, 1, 2, 3].sort(() => Math.random() - 0.5));
      setQuestion(q);
      setFlagged(false);
      setPhase('question');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    if (!sessionId) { setErr('No session id in URL'); return; }

    (async () => {
      try {
        const state = await getSoloState({ session_id: sessionId, player_uuid: playerUuid });
        if (state.status === 'finished') {
          setScore(state.score);
          setStreak(state.streak);
          setQuestionsSurvived(state.current_q_index);
          setPhase('finished');
          return;
        }
        if (state.status === 'abandoned') {
          setErr('This session was abandoned. Start a new one from the home screen.');
          return;
        }
        if (typeof state.lives_remaining === 'number') {
          setLives(state.lives_remaining);
        }
        void loadQuestion();
        void queueSoloQuestions({ session_id: sessionId, player_uuid: playerUuid, recent_hashes: recentHashesForRequest() }).catch(() => undefined);
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
      if (remaining === 0) {
        const pick = pendingPickRef.current;
        void onAnswer(pick !== null ? shuffleOrderRef.current[pick] : null);
      }
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
      if (question.content_hash_16) {
        recordQuestionSeen(question.content_hash_16);
      }
      setResult(r);
      setScore(r.new_score);
      setStreak(r.new_streak);
      if (typeof r.lives_remaining === 'number') setLives(r.lives_remaining);
      if (typeof r.correct_count === 'number') setCorrectCount(r.correct_count);
      setQuestionsSurvived(r.next_question_index);
      setPhase('reveal');
      // Keep the rolling buffer topped up.
      if (r.session_status === 'active') {
        void queueSoloQuestions({
          session_id: sessionId,
          player_uuid: playerUuid,
          recent_hashes: recentHashesForRequest(),
        }).catch(() => undefined);
      }
    } catch (e) {
      setErr((e as Error).message);
      setPhase('question');
    }
  };

  const nextQuestion = () => {
    if (result?.session_status === 'finished') {
      setPhase('finished');
      return;
    }
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
        <h1 className="font-display text-4xl sm:text-5xl font-black text-ink-900">
          You ran out of lives
        </h1>
        <div className="rounded-xl border border-rule bg-card p-5">
          <div className="text-[11px] uppercase tracking-[0.2em] text-ink-400">Questions survived</div>
          <div className="font-mono text-4xl text-ink-900 tabular-nums mt-1 font-bold">{questionsSurvived}</div>
        </div>
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
    const isLast = result.session_status === 'finished';
    const displayCategory = question.category ?? category;
    const displayDifficulty = question.difficulty ?? difficulty;
    const breakdown = result.is_correct
      ? `${result.base_points} base + ${result.speed_bonus} speed × ×${result.multiplier} streak = ${result.points_awarded}`
      : null;
    return (
      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6 sm:py-8 space-y-5">
        <TopBar
          category={displayCategory}
          difficulty={displayDifficulty}
          pace={pace}
          index={question.question_index}
          score={score}
          streak={streak}
          streakPulse={streakPulse}
          lives={lives}
          correctCount={correctCount}
        />
        <h2 className="font-display text-2xl sm:text-3xl font-bold leading-snug text-ink-900">
          {question.question_text}
        </h2>
        <div className="space-y-2">
          {shuffleOrder.map((origIdx, displayIdx) => {
            const isCorrect = origIdx === result.correct_index;
            const isWrongPick = origIdx === lastPick && !result.is_correct;
            const base = 'rounded-md border px-4 py-3 text-sm transition';
            const className = isCorrect
              ? `${base} border-yes bg-yes/10 text-yes font-medium`
              : isWrongPick
                ? `${base} border-no bg-no/10 text-no line-through`
                : `${base} border-rule text-ink-400`;
            return (
              <div key={origIdx} className={className}>
                <span className="mr-3 font-mono text-xs opacity-70">{String.fromCharCode(65 + displayIdx)}</span>
                {question.options[origIdx]}
              </div>
            );
          })}
        </div>
        <InsightCard
          insight={result.insight}
          scriptureRef={result.scripture_ref}
          correctBanner={
            result.is_correct
              ? `Correct · +${result.points_awarded} points`
              : lastPick === null ? 'Timed out' : 'Not quite'
          }
          breakdown={breakdown}
          isCorrect={result.is_correct}
          flagged={flagged}
          flagging={flagging}
          onFlag={onFlag}
        />
        <button
          onClick={nextQuestion}
          className="w-full rounded-md bg-accent px-4 py-3 text-card font-semibold hover:bg-accent-soft transition"
        >
          {isLast ? 'See final score' : 'Next question'}
        </button>
      </div>
    );
  }

  if (question) {
    const totalMs = question.timer_seconds * 1000;
    const pct = timeLeft === null ? 100 : Math.max(0, (timeLeft / totalMs) * 100);
    const displayCategory = question.category ?? category;
    const displayDifficulty = question.difficulty ?? difficulty;
    return (
      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6 sm:py-8 space-y-5">
        <TopBar
          category={displayCategory}
          difficulty={displayDifficulty}
          pace={pace}
          index={question.question_index}
          score={score}
          streak={streak}
          streakPulse={streakPulse}
          lives={lives}
          correctCount={correctCount}
        />
        <TimerBar pct={pct} timeLeftMs={timeLeft ?? totalMs} />
        <h2 className="font-display text-2xl sm:text-3xl font-bold leading-snug text-ink-900">
          {question.question_text}
        </h2>
        <div className="space-y-2">
          {shuffleOrder.map((origIdx, displayIdx) => {
            const isSelected = pendingPick === displayIdx;
            return (
              <button
                key={origIdx}
                onClick={() => setPendingPick(displayIdx)}
                className={`group w-full rounded-md border px-4 py-3 text-left transition ${
                  isSelected
                    ? 'border-accent bg-accent/10 ring-2 ring-accent/20'
                    : 'border-rule bg-card hover:bg-page hover:border-accent/60'
                }`}
              >
                <span className={`mr-3 font-mono text-xs ${isSelected ? 'text-accent font-bold' : 'text-ink-400 group-hover:text-accent'}`}>
                  {String.fromCharCode(65 + displayIdx)}
                </span>
                <span className={isSelected ? 'text-accent font-medium' : 'text-ink-800'}>{question.options[origIdx]}</span>
              </button>
            );
          })}
        </div>
        <button
          onClick={() => pendingPick !== null && void onAnswer(shuffleOrder[pendingPick])}
          disabled={pendingPick === null}
          className="w-full rounded-md bg-accent px-4 py-3 text-card font-semibold hover:bg-accent-soft disabled:opacity-30 disabled:cursor-not-allowed transition"
        >
          Lock in answer
        </button>
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
  score: number;
  streak: number;
  streakPulse: boolean;
  lives: number;
  correctCount: number;
}) {
  return (
    <div className="space-y-3">
      <ContextChips category={props.category} difficulty={props.difficulty} pace={props.pace} />
      <div className="flex items-center justify-between gap-3">
        <LivesIndicator lives={props.lives} questionIndex={props.index} streak={props.streak} />
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

function LivesIndicator({ lives, questionIndex, streak }: { lives: number; questionIndex: number; streak: number }) {
  const hearts = Array.from({ length: 3 }, (_, i) => i < lives);
  // Regen progress: next life when streak hits the next multiple of 7.
  // Streak resets on any wrong answer, so this counter resets too.
  const sinceRegen = streak % 7;
  const toNextRegen = 7 - sinceRegen;
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-0.5 text-base" title={`${lives} lives remaining`}>
        {hearts.map((on, i) => (
          <span key={i} className={on ? 'text-accent' : 'text-rule'}>
            {on ? '♥' : '♡'}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5 text-[10px] font-mono text-ink-400 uppercase tracking-wider whitespace-nowrap">
        <span>Q{questionIndex + 1}</span>
        {lives < 3 && (
          <span className="text-accent/70" title="Answer 7 correct in a row to earn a life back.">
            +1♥ in {toNextRegen}
          </span>
        )}
      </div>
    </div>
  );
}

function StreakBadge({ streak, pulse }: { streak: number; pulse: boolean }) {
  const mult = streakMultiplierDisplay(streak);
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

function streakMultiplierDisplay(streak: number): string {
  if (streak <= 1) return '1.0';
  if (streak === 2) return '1.1';
  if (streak === 3) return '1.2';
  if (streak === 4) return '1.3';
  const m = 1.5 + 0.1 * (streak - 5);
  return m.toFixed(1);
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
  breakdown: string | null;
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
      {props.breakdown && (
        <div className="px-4 pt-3 text-[11px] font-mono text-ink-500 tabular-nums">
          {props.breakdown}
        </div>
      )}
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
    <div className="h-1.5 rounded-full bg-rule/60 overflow-hidden">
      <div
        className="h-full bg-accent/70 rounded-full"
        style={{ animation: 'fill-bar 1.8s ease-in-out forwards' }}
      />
    </div>
  );
}

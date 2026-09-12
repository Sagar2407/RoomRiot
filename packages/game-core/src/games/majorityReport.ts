/**
 * Majority Report — the onboarding game (blueprint §5).
 *
 * Five rounds. Each round every player secretly (a) picks a personal answer and
 * (b) forecasts the room's most popular answer. Both lock together; no live vote
 * counts. Reveal the distribution, then the correct forecasters.
 *
 * Raw score: 100 for forecasting any option tied for the most votes, else 0.
 * Personal preference earns nothing. Void a round if fewer than three submit.
 * Maximum 500 (reduced consistently by any voided round).
 */
import type { GamePublicView, GamePrivateView } from '@roomriot/contracts';
import type {
  BaseGameState,
  ContentItem,
  GameAction,
  GameModule,
  InitContext,
  PhaseSpec,
  ReduceAction,
  ReduceContext,
  Validation,
} from '../types.js';
import { isAdvance } from '../types.js';
import type { RNG } from '../rng.js';

const CHOOSE_MS = 20_000;
const REVEAL_MS = 8_000;
const TOTAL_ROUNDS = 5;

interface Option {
  id: string;
  label: string;
}
interface MRContent {
  question: string;
  options: Option[];
}
interface RoundState {
  question: string;
  options: Option[];
  submissions: Record<string, { answer: string; forecast: string }>;
  settled: boolean;
  voided: boolean;
  counts: Record<string, number>;
  modal: string[];
  correct: string[];
}
export interface MajorityReportState extends BaseGameState {
  gameType: 'majority_report';
  rounds: RoundState[];
}

function phaseFor(round: number, kind: 'choosing' | 'reveal'): PhaseSpec {
  return {
    id: `majority_report-r${round}-${kind}`,
    kind,
    round,
    durationMs: kind === 'choosing' ? CHOOSE_MS : REVEAL_MS,
    collectsInput: kind === 'choosing',
  };
}

function settleRound(r: RoundState): void {
  const memberIds = Object.keys(r.submissions);
  r.settled = true;
  if (memberIds.length < 3) {
    r.voided = true;
    return;
  }
  const counts: Record<string, number> = {};
  for (const opt of r.options) counts[opt.id] = 0;
  for (const mid of memberIds) {
    const a = r.submissions[mid]!.answer;
    counts[a] = (counts[a] ?? 0) + 1;
  }
  const maxCount = Math.max(...Object.values(counts));
  const modal = r.options.filter((o) => counts[o.id] === maxCount).map((o) => o.id);
  const correct = memberIds.filter((mid) => modal.includes(r.submissions[mid]!.forecast));
  r.counts = counts;
  r.modal = modal;
  r.correct = correct;
}

export const majorityReport: GameModule<MajorityReportState> = {
  type: 'majority_report',
  manifest: {
    type: 'majority_report',
    title: 'Majority Report',
    family: 'Predictions',
    minPlayers: 4,
    maxPlayers: 10,
    maxRaw: 500,
    summary:
      'Secretly answer a ridiculous preference question and forecast the room’s most popular choice.',
    example:
      'Which useless power would improve your life most: talk to houseplants, always find matching socks, or summon perfect toast? Pick yours, then predict the room’s favourite.',
  },

  selectContent(all: ContentItem[], rng: RNG): ContentItem[] {
    const pool = [...all];
    rng.shuffle(pool);
    return pool.slice(0, TOTAL_ROUNDS);
  },

  initialState(ctx: InitContext): MajorityReportState {
    const rounds: RoundState[] = ctx.content.slice(0, TOTAL_ROUNDS).map((c) => {
      const data = c.data as MRContent;
      return {
        question: data.question,
        options: data.options,
        submissions: {},
        settled: false,
        voided: false,
        counts: {},
        modal: [],
        correct: [],
      };
    });
    return {
      gameType: 'majority_report',
      status: 'active',
      round: 1,
      totalRounds: rounds.length,
      phase: phaseFor(1, 'choosing'),
      rounds,
    };
  },

  validateAction(state, memberId, action: GameAction): Validation {
    if (action.type !== 'submit_round')
      return { ok: false, code: 'not_permitted', message: 'Unknown action.' };
    if (state.phase.kind !== 'choosing')
      return { ok: false, code: 'wrong_phase', message: 'Not accepting choices now.' };
    const round = state.rounds[state.round - 1]!;
    if (round.submissions[memberId])
      return { ok: false, code: 'duplicate', message: 'You already locked in.' };
    const p = action.payload as { answer?: unknown; forecast?: unknown } | undefined;
    const valid = (v: unknown) => typeof v === 'string' && round.options.some((o) => o.id === v);
    if (!p || !valid(p.answer) || !valid(p.forecast))
      return { ok: false, code: 'invalid_payload', message: 'Pick an answer and a forecast.' };
    return { ok: true };
  },

  reduce(state, action: ReduceAction, _ctx: ReduceContext): MajorityReportState {
    const next: MajorityReportState = structuredClone(state);
    const round = next.rounds[next.round - 1]!;

    if (!isAdvance(action)) {
      if (action.type === 'submit_round' && next.phase.kind === 'choosing') {
        const p = action.payload as { answer: string; forecast: string };
        round.submissions[action.memberId] = { answer: p.answer, forecast: p.forecast };
      }
      return next;
    }

    // __advance
    if (next.phase.kind === 'choosing') {
      settleRound(round);
      next.phase = phaseFor(next.round, 'reveal');
    } else {
      if (next.round < next.totalRounds) {
        next.round += 1;
        next.phase = phaseFor(next.round, 'choosing');
      } else {
        next.status = 'complete';
      }
    }
    return next;
  },

  allInputsIn(state, activeMemberIds): boolean {
    if (state.phase.kind !== 'choosing') return false;
    const round = state.rounds[state.round - 1]!;
    return activeMemberIds.length > 0 && activeMemberIds.every((m) => !!round.submissions[m]);
  },

  projectPublic(state): GamePublicView {
    const round = state.rounds[state.round - 1]!;
    const base: GamePublicView = {
      gameType: 'majority_report',
      round: state.round,
      totalRounds: state.totalRounds,
      phaseKind: state.phase.kind,
      prompt: { question: round.question },
      options: round.options,
    };
    if (state.phase.kind === 'reveal') {
      base.reveal = {
        voided: round.voided,
        counts: round.counts,
        modal: round.modal,
        correctMemberIds: round.correct,
        submittedCount: Object.keys(round.submissions).length,
      };
    }
    return base;
  },

  projectPrivate(state, memberId): GamePrivateView {
    const round = state.rounds[state.round - 1]!;
    const mine = round.submissions[memberId];
    return {
      awaitingInput: state.phase.kind === 'choosing' && !mine,
      secret: mine ? { answer: mine.answer, forecast: mine.forecast } : undefined,
    };
  },

  score(state) {
    let counted = 0;
    const raw: Record<string, number> = {};
    const correctTally: Record<string, number> = {};
    for (const r of state.rounds) {
      if (!r.settled || r.voided) continue;
      counted += 1;
      for (const mid of Object.keys(r.submissions)) raw[mid] ??= 0;
      for (const mid of r.correct) {
        raw[mid] = (raw[mid] ?? 0) + 100;
        correctTally[mid] = (correctTally[mid] ?? 0) + 1;
      }
    }
    const entries = Object.keys(raw).map((memberId) => ({ memberId, raw: raw[memberId]! }));
    const max = counted > 0 ? 100 * counted : 100;

    let best: string | null = null;
    let bestN = 0;
    for (const [mid, n] of Object.entries(correctTally)) {
      if (n > bestN) {
        bestN = n;
        best = mid;
      }
    }
    const awards =
      best && bestN > 0
        ? [
            {
              key: 'sharpest_forecast',
              title: 'Sharpest Forecast',
              memberId: best,
              detail: `Read the room ${bestN}/${counted} times`,
            },
          ]
        : [];
    return { max, entries, awards };
  },
};

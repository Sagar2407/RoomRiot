/**
 * Close Call — the quick finale (blueprint §5).
 *
 * Five rounds. Estimate a positive quantity in an original puzzle. Each item has a
 * known positive answer and an unambiguous counting rule.
 *
 * Raw: 100 exact; 70 for absolute relative error ≤ 10%; 40 for ≤ 25%; else 0.
 * Evaluate the exact band first. Reject non-finite, negative, and out-of-range
 * values. No response-speed bonus. Max 500.
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

const ESTIMATE_MS = 15_000;
const REVEAL_MS = 8_000;
const TOTAL_ROUNDS = 5;

interface CloseContent {
  prompt: string;
  answer: number;
  rangeMax: number;
  countingRule: string;
}
interface CloseRound {
  prompt: string;
  answer: number;
  rangeMax: number;
  countingRule: string;
  estimates: Record<string, number>;
  settled: boolean;
}
export interface CloseCallState extends BaseGameState {
  gameType: 'close_call';
  rounds: CloseRound[];
}

/** Pure scoring band used by both settlement and tests. */
export function bandScore(answer: number, estimate: number): number {
  if (estimate === answer) return 100;
  const rel = Math.abs(estimate - answer) / answer;
  if (rel <= 0.1) return 70;
  if (rel <= 0.25) return 40;
  return 0;
}

function phaseFor(round: number, kind: 'estimate' | 'reveal'): PhaseSpec {
  return {
    id: `close_call-r${round}-${kind}`,
    kind,
    round,
    durationMs: kind === 'estimate' ? ESTIMATE_MS : REVEAL_MS,
    collectsInput: kind === 'estimate',
  };
}

export const closeCall: GameModule<CloseCallState> = {
  type: 'close_call',
  manifest: {
    type: 'close_call',
    title: 'Close Call',
    family: 'Predictions',
    minPlayers: 4,
    maxPlayers: 10,
    maxRaw: 500,
    summary: 'Estimate a quantity in an original puzzle — exact scores best, close still counts.',
    example: 'How many colored objects are shown? Enter your best estimate; exact answers score 100, close ones 70 or 40.',
  },

  selectContent(all, rng) {
    const pool = [...all];
    rng.shuffle(pool);
    return pool.slice(0, TOTAL_ROUNDS);
  },

  initialState(ctx: InitContext): CloseCallState {
    const rounds: CloseRound[] = ctx.content.slice(0, TOTAL_ROUNDS).map((c) => {
      const d = c.data as CloseContent;
      return {
        prompt: d.prompt,
        answer: d.answer,
        rangeMax: d.rangeMax,
        countingRule: d.countingRule,
        estimates: {},
        settled: false,
      };
    });
    return {
      gameType: 'close_call',
      status: 'active',
      round: 1,
      totalRounds: rounds.length,
      phase: phaseFor(1, 'estimate'),
      rounds,
    };
  },

  validateAction(state, memberId, action: GameAction): Validation {
    if (action.type !== 'submit_estimate')
      return { ok: false, code: 'not_permitted', message: 'Unknown action.' };
    if (state.phase.kind !== 'estimate')
      return { ok: false, code: 'wrong_phase', message: 'Not estimating now.' };
    const round = state.rounds[state.round - 1]!;
    if (round.estimates[memberId] !== undefined)
      return { ok: false, code: 'duplicate', message: 'Estimate already locked.' };
    const p = action.payload as { value?: unknown } | undefined;
    const v = p?.value;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > round.rangeMax)
      return { ok: false, code: 'invalid_payload', message: `Enter a number from 0 to ${round.rangeMax}.` };
    return { ok: true };
  },

  reduce(state, action: ReduceAction, _ctx: ReduceContext): CloseCallState {
    const next: CloseCallState = structuredClone(state);
    const round = next.rounds[next.round - 1]!;
    if (!isAdvance(action)) {
      if (action.type === 'submit_estimate' && next.phase.kind === 'estimate') {
        round.estimates[action.memberId] = (action.payload as { value: number }).value;
      }
      return next;
    }
    if (next.phase.kind === 'estimate') {
      round.settled = true;
      next.phase = phaseFor(next.round, 'reveal');
    } else if (next.round < next.totalRounds) {
      next.round += 1;
      next.phase = phaseFor(next.round, 'estimate');
    } else {
      next.status = 'complete';
    }
    return next;
  },

  allInputsIn(state, activeMemberIds): boolean {
    if (state.phase.kind !== 'estimate') return false;
    const round = state.rounds[state.round - 1]!;
    return activeMemberIds.length > 0 && activeMemberIds.every((m) => round.estimates[m] !== undefined);
  },

  projectPublic(state): GamePublicView {
    const round = state.rounds[state.round - 1]!;
    const base: GamePublicView = {
      gameType: 'close_call',
      round: state.round,
      totalRounds: state.totalRounds,
      phaseKind: state.phase.kind,
      prompt: { text: round.prompt, rangeMax: round.rangeMax, countingRule: round.countingRule },
    };
    if (state.phase.kind === 'reveal') {
      base.reveal = {
        answer: round.answer,
        estimates: round.estimates,
        scores: Object.fromEntries(
          Object.entries(round.estimates).map(([m, v]) => [m, bandScore(round.answer, v)]),
        ),
      };
    }
    return base;
  },

  projectPrivate(state, memberId): GamePrivateView {
    const round = state.rounds[state.round - 1]!;
    const mine = round.estimates[memberId];
    return {
      awaitingInput: state.phase.kind === 'estimate' && mine === undefined,
      secret: mine !== undefined ? { value: mine } : undefined,
    };
  },

  score(state) {
    let counted = 0;
    const raw: Record<string, number> = {};
    const hitTally: Record<string, number> = {};
    for (const round of state.rounds) {
      if (!round.settled) continue;
      counted += 1;
      for (const [mid, v] of Object.entries(round.estimates)) {
        raw[mid] ??= 0;
        const s = bandScore(round.answer, v);
        raw[mid] += s;
        if (s > 0) hitTally[mid] = (hitTally[mid] ?? 0) + 1;
      }
    }
    const entries = Object.keys(raw).map((memberId) => ({ memberId, raw: raw[memberId]! }));
    const max = counted > 0 ? 100 * counted : 100;
    let best: string | null = null;
    let bestN = 0;
    for (const [mid, n] of Object.entries(hitTally)) {
      if (n > bestN) {
        bestN = n;
        best = mid;
      }
    }
    const awards =
      best && bestN > 0
        ? [{ key: 'eagle_eye', title: 'Eagle Eye', memberId: best, detail: `${bestN}/${counted} on target` }]
        : [];
    return { max, entries, awards };
  },
};

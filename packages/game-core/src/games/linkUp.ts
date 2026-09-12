/**
 * Link Up — the low-pressure connection game (blueprint §5).
 *
 * Three rounds, rotating groups to minimise repeat partners. Players receive the
 * same four-option question and silently choose the answer they think their
 * assigned partner will pick.
 *
 * Raw: 100 for a matching pair, 0 otherwise. Odd rosters form one trio scoring
 * 100 × matching pairs ÷ 3 (unanimous 100, one matching pair 33.33, all different
 * 0); each member receives the group's score. Decimals kept internally.
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

const CHOOSE_MS = 25_000;
const REVEAL_MS = 8_000;
const TOTAL_ROUNDS = 3;

interface Option {
  id: string;
  label: string;
}
interface LUContent {
  question: string;
  options: Option[];
}
interface LURound {
  question: string;
  options: Option[];
  groups: string[][];
  choices: Record<string, string>;
  settled: boolean;
}
export interface LinkUpState extends BaseGameState {
  gameType: 'link_up';
  seatOrder: string[];
  rounds: LURound[];
}

/** Round-robin (circle method); returns pairs, with any odd player merged into a trio. */
export function makeGroups(ids: string[], round: number): string[][] {
  const base = [...ids];
  const odd = base.length % 2 === 1;
  const GHOST = '__ghost__';
  if (odd) base.push(GHOST);

  const n = base.length;
  const fixed = base[0]!;
  const rest = base.slice(1);
  const k = rest.length === 0 ? 0 : round % rest.length;
  const rotated = rest.slice(rest.length - k).concat(rest.slice(0, rest.length - k));
  const circle = [fixed, ...rotated];

  const pairs: string[][] = [];
  for (let i = 0; i < n / 2; i++) pairs.push([circle[i]!, circle[n - 1 - i]!]);

  if (!odd) return pairs;

  // Remove the ghost; merge the real partner into another pair as a trio.
  const ghostPairIdx = pairs.findIndex((p) => p.includes(GHOST));
  const ghostPair = pairs[ghostPairIdx]!;
  const orphan = ghostPair.find((m) => m !== GHOST)!;
  pairs.splice(ghostPairIdx, 1);
  (pairs[0] ??= []).push(orphan);
  return pairs;
}

function groupScore(members: string[], choices: Record<string, string>): number {
  const picks = members.map((m) => choices[m]);
  if (members.length <= 2) {
    const [a, b] = picks;
    return a !== undefined && a === b ? 100 : 0;
  }
  let matching = 0;
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++)
      if (picks[i] !== undefined && picks[i] === picks[j]) matching++;
  return (100 * matching) / 3;
}

function phaseFor(round: number, kind: 'choosing' | 'reveal'): PhaseSpec {
  return {
    id: `link_up-r${round}-${kind}`,
    kind,
    round,
    durationMs: kind === 'choosing' ? CHOOSE_MS : REVEAL_MS,
    collectsInput: kind === 'choosing',
  };
}

export const linkUp: GameModule<LinkUpState> = {
  type: 'link_up',
  manifest: {
    type: 'link_up',
    title: 'Link Up',
    family: 'Teamwork',
    minPlayers: 4,
    maxPlayers: 10,
    maxRaw: 300,
    summary: 'Choose the same answer as a randomly assigned partner — without discussing it.',
    example:
      'Question: “Our disastrous food truck should sell…”. Silently pick what you think your assigned partner will choose. Match to score.',
  },

  selectContent(all, rng) {
    const pool = [...all];
    rng.shuffle(pool);
    return pool.slice(0, TOTAL_ROUNDS);
  },

  initialState(ctx: InitContext): LinkUpState {
    const seatOrder = [...ctx.members].sort((a, b) => a.seat - b.seat).map((m) => m.memberId);
    const rounds: LURound[] = ctx.content.slice(0, TOTAL_ROUNDS).map((c, i) => {
      const d = c.data as LUContent;
      return {
        question: d.question,
        options: d.options,
        groups: makeGroups(seatOrder, i),
        choices: {},
        settled: false,
      };
    });
    return {
      gameType: 'link_up',
      status: 'active',
      round: 1,
      totalRounds: rounds.length,
      phase: phaseFor(1, 'choosing'),
      seatOrder,
      rounds,
    };
  },

  validateAction(state, memberId, action: GameAction): Validation {
    if (action.type !== 'submit_choice')
      return { ok: false, code: 'not_permitted', message: 'Unknown action.' };
    if (state.phase.kind !== 'choosing')
      return { ok: false, code: 'wrong_phase', message: 'Not choosing now.' };
    const round = state.rounds[state.round - 1]!;
    if (round.choices[memberId] !== undefined)
      return { ok: false, code: 'duplicate', message: 'Choice already locked.' };
    const p = action.payload as { optionId?: unknown } | undefined;
    if (!p || !round.options.some((o) => o.id === p.optionId))
      return { ok: false, code: 'invalid_payload', message: 'Pick one option.' };
    return { ok: true };
  },

  reduce(state, action: ReduceAction, _ctx: ReduceContext): LinkUpState {
    const next: LinkUpState = structuredClone(state);
    const round = next.rounds[next.round - 1]!;
    if (!isAdvance(action)) {
      if (action.type === 'submit_choice' && next.phase.kind === 'choosing') {
        round.choices[action.memberId] = (action.payload as { optionId: string }).optionId;
      }
      return next;
    }
    if (next.phase.kind === 'choosing') {
      round.settled = true;
      next.phase = phaseFor(next.round, 'reveal');
    } else if (next.round < next.totalRounds) {
      next.round += 1;
      next.phase = phaseFor(next.round, 'choosing');
    } else {
      next.status = 'complete';
    }
    return next;
  },

  allInputsIn(state, activeMemberIds): boolean {
    if (state.phase.kind !== 'choosing') return false;
    const round = state.rounds[state.round - 1]!;
    return activeMemberIds.length > 0 && activeMemberIds.every((m) => round.choices[m] !== undefined);
  },

  projectPublic(state): GamePublicView {
    const round = state.rounds[state.round - 1]!;
    const base: GamePublicView = {
      gameType: 'link_up',
      round: state.round,
      totalRounds: state.totalRounds,
      phaseKind: state.phase.kind,
      prompt: { question: round.question },
      options: round.options,
    };
    if (state.phase.kind === 'reveal') {
      base.reveal = {
        groups: round.groups.map((members) => ({
          members: members.map((m) => ({ memberId: m, choice: round.choices[m] ?? null })),
          score: Math.round(groupScore(members, round.choices) * 100) / 100,
        })),
      };
    }
    return base;
  },

  projectPrivate(state, memberId): GamePrivateView {
    const round = state.rounds[state.round - 1]!;
    const group = round.groups.find((g) => g.includes(memberId));
    const partners = (group ?? []).filter((m) => m !== memberId);
    return {
      awaitingInput: state.phase.kind === 'choosing' && round.choices[memberId] === undefined,
      secret: { partnerMemberIds: partners },
    };
  },

  score(state) {
    let counted = 0;
    const raw: Record<string, number> = {};
    for (const m of state.seatOrder) raw[m] = 0;
    for (const round of state.rounds) {
      if (!round.settled) continue;
      counted += 1;
      for (const group of round.groups) {
        const s = groupScore(group, round.choices);
        for (const m of group) raw[m] = (raw[m] ?? 0) + s;
      }
    }
    const entries = Object.keys(raw).map((memberId) => ({ memberId, raw: raw[memberId]! }));
    const max = counted > 0 ? 100 * counted : 100;
    return { max, entries };
  },
};

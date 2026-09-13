/**
 * Snakes & Ladders — the sequential-engine proving ground (plan §8).
 *
 * One token per seat on an original Room Riot board. On their turn the active
 * seat rolls one fair d6 (server-authoritative crypto RNG via `ctx.rollDie`);
 * the token advances, a snake or ladder on the landing square (only) resolves,
 * and the turn passes clockwise. Quick reaches-or-exceeds 50; Classic needs an
 * exact 100 and an overshoot leaves the token in place.
 *
 * This is a placement game: the winner is whoever finishes first, and remaining
 * seats are ranked by board position (ties share a rank), converted to Night
 * Points by the placement adapter — never through the performance path (plan §9).
 *
 * All state is public (no hidden information); the only per-seat signal is whose
 * turn it is. A disconnected active seat never stalls the table: its deadline
 * fires and the server rolls the documented fallback for it.
 */
import type { GamePublicView, GamePrivateView } from '@roomriot/contracts';
import type {
  BaseGameState,
  GameAction,
  GameModule,
  GameScoreResult,
  InitContext,
  PhaseSpec,
  PlacementResult,
  ReduceAction,
  ReduceContext,
  Validation,
} from '../types.js';
import { isAdvance } from '../types.js';
import { boardForPreset, type SnakesPreset } from '../boards/snakesBoards.js';

const ROLL_MS = 20_000;
/** Quick ends after this many complete seat circuits if nobody finishes (plan §8.1). */
const QUICK_CIRCUIT_CAP = 20;
/** Classic has no design cap; this is a safety bound so a match always terminates. */
const CLASSIC_SAFETY_CIRCUITS = 150;

export interface SnakesRoll {
  memberId: string;
  die: number;
  from: number;
  to: number;
  jumpedFrom: number | null;
  jumpedTo: number | null;
  /** True when the server rolled this on a timed-out seat's behalf. */
  auto: boolean;
}

export interface SnakesState extends BaseGameState {
  gameType: 'snakes_and_ladders';
  preset: SnakesPreset;
  size: number;
  reachOrExceed: boolean;
  jumps: Record<number, number>;
  seatOrder: string[];
  activeIndex: number;
  positions: Record<string, number>;
  finishedOrder: string[];
  turnResolved: boolean;
  turnCount: number;
  circuitCapTurns: number;
  lastRoll: SnakesRoll | null;
  biggestClimb: Record<string, number>;
  biggestTumble: Record<string, number>;
}

function phaseFor(turnCount: number, round: number): PhaseSpec {
  return {
    id: `snakes-turn-${turnCount}`,
    kind: 'rolling',
    round,
    durationMs: ROLL_MS,
    collectsInput: true,
  };
}

/** Build a starting state for a given preset — used by the module and by tests. */
export function createSnakesState(memberIds: string[], preset: SnakesPreset = 'quick'): SnakesState {
  const board = boardForPreset(preset);
  const seatOrder = [...memberIds];
  const positions: Record<string, number> = {};
  for (const id of seatOrder) positions[id] = 0;
  const circuits = preset === 'classic' ? CLASSIC_SAFETY_CIRCUITS : QUICK_CIRCUIT_CAP;
  return {
    gameType: 'snakes_and_ladders',
    status: 'active',
    round: 1,
    totalRounds: circuits,
    phase: phaseFor(0, 1),
    preset,
    size: board.size,
    reachOrExceed: board.reachOrExceed,
    jumps: { ...board.jumps },
    seatOrder,
    activeIndex: 0,
    positions,
    finishedOrder: [],
    turnResolved: false,
    turnCount: 0,
    circuitCapTurns: circuits * Math.max(1, seatOrder.length),
    lastRoll: null,
    biggestClimb: {},
    biggestTumble: {},
  };
}

/** Apply one die roll for a seat: advance, resolve a single jump, detect a finish. */
function applyMove(s: SnakesState, memberId: string, die: number, auto: boolean): void {
  const from = s.positions[memberId] ?? 0;
  let to = from + die;
  let jumpedFrom: number | null = null;
  let jumpedTo: number | null = null;

  if (s.reachOrExceed) {
    if (to >= s.size) {
      to = s.size;
    } else if (s.jumps[to] !== undefined) {
      jumpedFrom = to;
      to = s.jumps[to]!;
      jumpedTo = to;
    }
  } else {
    if (to > s.size) {
      to = from; // exact-finish preset: an overshoot leaves the token in place
    } else if (to < s.size && s.jumps[to] !== undefined) {
      jumpedFrom = to;
      to = s.jumps[to]!;
      jumpedTo = to;
    }
    // to === size → exact finish, no jump on the final square
  }

  s.positions[memberId] = to;
  if (to === s.size && !s.finishedOrder.includes(memberId)) s.finishedOrder.push(memberId);

  if (jumpedFrom !== null && jumpedTo !== null) {
    const delta = jumpedTo - jumpedFrom;
    if (delta > 0) s.biggestClimb[memberId] = Math.max(s.biggestClimb[memberId] ?? 0, delta);
    else s.biggestTumble[memberId] = Math.max(s.biggestTumble[memberId] ?? 0, -delta);
  }
  s.lastRoll = { memberId, die, from, to, jumpedFrom, jumpedTo, auto };
}

export const snakesAndLadders: GameModule<SnakesState> = {
  type: 'snakes_and_ladders',
  interactionMode: 'sequential',
  resultKind: 'placement',
  manifest: {
    type: 'snakes_and_ladders',
    title: 'Snakes & Ladders',
    family: 'Board',
    minPlayers: 2,
    maxPlayers: 10,
    maxRaw: 100,
    summary: 'Roll, climb the ladders, dodge the snakes. First token home wins; the rest are ranked by how far they got.',
    example: 'Land on 3 to ride a ladder to 14; land on 23 and a snake drags you back to 7.',
  },

  selectContent() {
    return []; // a board game needs no prompt content
  },

  initialState(ctx: InitContext): SnakesState {
    const memberIds = [...ctx.members].sort((a, b) => a.seat - b.seat).map((m) => m.memberId);
    return createSnakesState(memberIds, 'quick');
  },

  validateAction(state, memberId, action: GameAction): Validation {
    if (state.status !== 'active') return { ok: false, code: 'wrong_phase', message: 'The game is over' };
    if (action.type !== 'roll') return { ok: false, code: 'invalid_payload', message: `Unknown action ${action.type}` };
    if (state.seatOrder[state.activeIndex] !== memberId)
      return { ok: false, code: 'not_permitted', message: 'It is not your turn' };
    if (state.turnResolved) return { ok: false, code: 'duplicate', message: 'You have already rolled this turn' };
    return { ok: true };
  },

  reduce(state, action: ReduceAction, ctx: ReduceContext): SnakesState {
    const s = structuredClone(state) as SnakesState;

    if (isAdvance(action)) {
      if (s.status === 'complete') return s;
      // A timed-out active seat that never rolled: the server rolls for it.
      if (!s.turnResolved) {
        const active = s.seatOrder[s.activeIndex]!;
        applyMove(s, active, ctx.rollDie ? ctx.rollDie() : 1, true);
        s.turnResolved = true;
      }
      // First finisher ends the game (natural win); rank the rest by position.
      if (s.finishedOrder.length >= 1) {
        s.status = 'complete';
        return s;
      }
      // Otherwise the turn-cap ends it once every seat has had equal turns.
      if (s.turnCount + 1 >= s.circuitCapTurns) {
        s.status = 'complete';
        return s;
      }
      s.activeIndex = (s.activeIndex + 1) % s.seatOrder.length;
      s.turnCount += 1;
      s.turnResolved = false;
      s.round = Math.floor(s.turnCount / s.seatOrder.length) + 1;
      s.phase = phaseFor(s.turnCount, s.round);
      return s;
    }

    // A player's own roll.
    const active = s.seatOrder[s.activeIndex]!;
    applyMove(s, active, ctx.rollDie ? ctx.rollDie() : 1, false);
    s.turnResolved = true;
    return s;
  },

  allInputsIn(state): boolean {
    // The single active seat drives the turn; once it has rolled, advance.
    return state.turnResolved;
  },

  projectPublic(state): GamePublicView {
    return {
      gameType: 'snakes_and_ladders',
      round: state.round,
      totalRounds: state.totalRounds,
      phaseKind: state.status === 'complete' ? 'complete' : 'rolling',
      prompt: {
        preset: state.preset,
        size: state.size,
        jumps: state.jumps,
        reachOrExceed: state.reachOrExceed,
        seatOrder: state.seatOrder,
        activeMemberId: state.status === 'complete' ? null : state.seatOrder[state.activeIndex],
        positions: state.positions,
        finishedOrder: state.finishedOrder,
        lastRoll: state.lastRoll,
        turnResolved: state.turnResolved,
      },
      reveal:
        state.status === 'complete'
          ? { finishedOrder: state.finishedOrder, positions: state.positions }
          : undefined,
    };
  },

  projectPrivate(state, memberId): GamePrivateView {
    return {
      awaitingInput:
        state.status === 'active' && state.seatOrder[state.activeIndex] === memberId && !state.turnResolved,
    };
  },

  score(): GameScoreResult {
    // Placement game — settlement uses `placement()`, not this performance path.
    return { max: 0, entries: [] };
  },

  placement(state): PlacementResult {
    const finishedRank = new Map(state.finishedOrder.map((id, i) => [id, i]));
    const sorted = [...state.seatOrder].sort((a, b) => {
      const fa = finishedRank.has(a);
      const fb = finishedRank.has(b);
      if (fa && fb) return finishedRank.get(a)! - finishedRank.get(b)!;
      if (fa) return -1;
      if (fb) return 1;
      return (state.positions[b] ?? 0) - (state.positions[a] ?? 0);
    });

    const tied = (a: string, b: string) =>
      !finishedRank.has(a) && !finishedRank.has(b) && (state.positions[a] ?? 0) === (state.positions[b] ?? 0);

    // Standard competition ranking (1,2,2,4): a seat tied with the one ahead of
    // it shares that rank; otherwise its rank is its 1-based position.
    const ranked: Array<{ memberId: string; rank: number; metric: number }> = [];
    sorted.forEach((id, i) => {
      const rank = i > 0 && tied(sorted[i - 1]!, id) ? ranked[i - 1]!.rank : i + 1;
      ranked.push({ memberId: id, rank, metric: state.positions[id] ?? 0 });
    });

    const awards: PlacementResult['awards'] = [];
    const topClimb = pickMax(state.biggestClimb);
    if (topClimb) awards.push({ key: 'longest_climb', title: 'Longest climb', memberId: topClimb.id, detail: `Climbed ${topClimb.value} squares` });
    const topTumble = pickMax(state.biggestTumble);
    if (topTumble) awards.push({ key: 'biggest_tumble', title: 'Biggest tumble', memberId: topTumble.id, detail: `Slid ${topTumble.value} squares` });

    return { standings: ranked, awards };
  },
};

function pickMax(m: Record<string, number>): { id: string; value: number } | null {
  let best: { id: string; value: number } | null = null;
  for (const [id, value] of Object.entries(m)) {
    if (value > 0 && (!best || value > best.value)) best = { id, value };
  }
  return best;
}

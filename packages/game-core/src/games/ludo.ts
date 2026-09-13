/**
 * Ludo (plan §7). Quick preset: 2 tokens per color, one starting on the board and
 * one in the yard; Classic: 4 tokens, all in the yard. Roll a 6 to enter from the
 * yard and to earn a bonus roll; three consecutive sixes voids the third and ends
 * the turn. Landing on an opponent on an unsafe cell sends it back to the yard;
 * home needs an exact roll. First color home (both tokens Quick / all four Classic)
 * wins; otherwise a turn cap settles by a published progress ranking.
 *
 * All state is public (positions, dice) — the only per-seat signal is whose turn it
 * is. Roll and move are distinct decisions, each with its own phase, so two roll
 * requests can't produce two outcomes in one turn. A timed-out seat is rolled and
 * moved by the server using a fixed, public priority.
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
import { LUDO_HOME, LUDO_SAFE_CELLS, ludoColorsForSeats, ludoTrackCell } from '../boards/ludoBoard.js';

const ROLL_MS = 15_000;
const MOVE_MS = 15_000;
const QUICK_TOKENS = 2;
const CLASSIC_TOKENS = 4;
const QUICK_CIRCUITS = 24;
const CLASSIC_SAFETY_CIRCUITS = 200;

type LudoPreset = 'quick' | 'classic';

export interface LudoState extends BaseGameState {
  gameType: 'ludo';
  preset: LudoPreset;
  seatOrder: string[];
  seatColor: Record<string, number>;
  tokensPerColor: number;
  activeIndex: number;
  stage: 'roll' | 'move' | 'done';
  die: number | null;
  legalTokens: number[];
  consecutiveSixes: number;
  positions: Record<string, number[]>; // -1 yard, 0..55 track/home-lane, 56 home
  finishedOrder: string[];
  primaryTurns: number;
  circuitCap: number;
  phaseSeq: number;
  lastEvent: { memberId: string; die: number; tokenIndex: number | null; captured: string[]; auto: boolean } | null;
  turnResolved: boolean;
}

function activeSeat(s: LudoState): string {
  return s.seatOrder[s.activeIndex]!;
}
function finishedCount(s: LudoState, id: string): number {
  return (s.positions[id] ?? []).filter((p) => p === LUDO_HOME).length;
}

/** Tokens the seat may legally move with the current die. */
function legalTokensFor(s: LudoState, id: string, die: number): number[] {
  const pos = s.positions[id] ?? [];
  const out: number[] = [];
  pos.forEach((p, i) => {
    if (p === -1) {
      if (die === 6) out.push(i); // enter from the yard on a 6
    } else if (p < LUDO_HOME && p + die <= LUDO_HOME) {
      out.push(i); // exact home required (p + die <= 56)
    }
  });
  return out;
}

/** Apply a token move: advance, capture opponents on an unsafe landing cell, record. */
function applyMove(s: LudoState, id: string, tokenIndex: number, auto: boolean): void {
  const color = s.seatColor[id]!;
  const from = s.positions[id]![tokenIndex]!;
  const to = from === -1 ? 0 : from + s.die!;
  s.positions[id]![tokenIndex] = to;

  const captured: string[] = [];
  const landingCell = ludoTrackCell(color, to);
  if (landingCell !== null && !LUDO_SAFE_CELLS.has(landingCell)) {
    for (const other of s.seatOrder) {
      if (other === id) continue;
      const oc = s.seatColor[other]!;
      s.positions[other]!.forEach((op, oi) => {
        if (op >= 0 && op <= 50 && ludoTrackCell(oc, op) === landingCell) {
          s.positions[other]![oi] = -1; // sent back to the yard
          captured.push(`${other}:${oi}`);
        }
      });
    }
  }
  s.lastEvent = { memberId: id, die: s.die!, tokenIndex, captured, auto };
}

/** Timeout priority: finish > capture > land safe > furthest progress > lowest index. */
function priorityToken(s: LudoState, id: string, legal: number[]): number {
  const color = s.seatColor[id]!;
  const score = (t: number): number[] => {
    const from = s.positions[id]![t]!;
    const to = from === -1 ? 0 : from + s.die!;
    const finishes = to === LUDO_HOME ? 1 : 0;
    const cell = ludoTrackCell(color, to);
    let captures = 0;
    if (cell !== null && !LUDO_SAFE_CELLS.has(cell)) {
      for (const other of s.seatOrder)
        if (other !== id)
          for (const op of s.positions[other]!) if (op >= 0 && op <= 50 && ludoTrackCell(s.seatColor[other]!, op) === cell) captures = 1;
    }
    const safe = cell !== null && LUDO_SAFE_CELLS.has(cell) ? 1 : 0;
    return [finishes, captures, safe, to, -t];
  };
  return [...legal].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i]! - sa[i]!;
    return 0;
  })[0]!;
}

function rollPhase(s: LudoState): PhaseSpec {
  s.phaseSeq += 1;
  return { id: `ludo-p${s.phaseSeq}`, kind: 'roll', round: Math.floor(s.primaryTurns / s.seatOrder.length) + 1, durationMs: ROLL_MS, collectsInput: true };
}
function movePhase(s: LudoState): PhaseSpec {
  s.phaseSeq += 1;
  return { id: `ludo-p${s.phaseSeq}`, kind: 'move', round: Math.floor(s.primaryTurns / s.seatOrder.length) + 1, durationMs: MOVE_MS, collectsInput: true };
}

function passToNext(s: LudoState): void {
  s.consecutiveSixes = 0;
  s.die = null;
  s.legalTokens = [];
  s.activeIndex = (s.activeIndex + 1) % s.seatOrder.length;
  s.primaryTurns += 1;
  if (s.primaryTurns >= s.circuitCap) {
    s.status = 'complete';
    s.stage = 'done';
    return;
  }
  s.stage = 'roll';
  s.turnResolved = false;
  s.phase = rollPhase(s);
}

export function createLudoState(memberIds: string[], preset: LudoPreset = 'quick'): LudoState {
  const seatOrder = [...memberIds];
  const n = seatOrder.length;
  const colors = ludoColorsForSeats(n);
  const seatColor: Record<string, number> = {};
  seatOrder.forEach((id, i) => (seatColor[id] = colors[i]!));
  const tokensPerColor = preset === 'classic' ? CLASSIC_TOKENS : QUICK_TOKENS;
  const positions: Record<string, number[]> = {};
  for (const id of seatOrder) {
    // Quick starts one token on the board (progress 0) and the rest in the yard.
    positions[id] = Array.from({ length: tokensPerColor }, (_, i) => (preset === 'quick' && i === 0 ? 0 : -1));
  }
  const circuits = preset === 'classic' ? CLASSIC_SAFETY_CIRCUITS : QUICK_CIRCUITS;
  const s: LudoState = {
    gameType: 'ludo',
    status: 'active',
    round: 1,
    totalRounds: circuits,
    phase: { id: 'ludo-p0', kind: 'roll', round: 1, durationMs: ROLL_MS, collectsInput: true },
    preset,
    seatOrder,
    seatColor,
    tokensPerColor,
    activeIndex: 0,
    stage: 'roll',
    die: null,
    legalTokens: [],
    consecutiveSixes: 0,
    positions,
    finishedOrder: [],
    primaryTurns: 0,
    circuitCap: circuits * Math.max(1, n),
    phaseSeq: 0,
    lastEvent: null,
    turnResolved: false,
  };
  s.phase = rollPhase(s);
  return s;
}

export const ludo: GameModule<LudoState> = {
  type: 'ludo',
  interactionMode: 'sequential',
  resultKind: 'placement',
  manifest: {
    type: 'ludo',
    title: 'Ludo',
    family: 'Board',
    minPlayers: 2,
    maxPlayers: 4,
    maxRaw: 100,
    summary: 'Race your tokens home. Roll a 6 to leave the yard, capture opponents on the way, and land home exactly.',
    example: 'Roll a 6 to bring a token out; land on an opponent on an open cell and it goes back to its yard.',
  },

  selectContent() {
    return [];
  },

  initialState(ctx: InitContext): LudoState {
    const memberIds = [...ctx.members].sort((a, b) => a.seat - b.seat).map((m) => m.memberId);
    return createLudoState(memberIds, 'quick');
  },

  validateAction(state, memberId, action: GameAction): Validation {
    if (state.stage === 'done') return { ok: false, code: 'wrong_phase', message: 'The game is over' };
    if (activeSeat(state) !== memberId) return { ok: false, code: 'not_permitted', message: 'Not your turn' };
    if (state.turnResolved) return { ok: false, code: 'duplicate', message: 'You have already acted' };
    if (state.stage === 'roll') {
      if (action.type !== 'roll') return { ok: false, code: 'wrong_phase', message: 'Roll first' };
      return { ok: true };
    }
    if (action.type !== 'move') return { ok: false, code: 'wrong_phase', message: 'Pick a token to move' };
    const t = (action.payload as { tokenIndex?: number } | undefined)?.tokenIndex;
    if (typeof t !== 'number' || !state.legalTokens.includes(t)) return { ok: false, code: 'invalid_payload', message: 'That token cannot move' };
    return { ok: true };
  },

  reduce(state, action: ReduceAction, ctx: ReduceContext): LudoState {
    const s = structuredClone(state) as LudoState;

    if (isAdvance(action)) {
      if (s.stage === 'done') return s;
      const active = activeSeat(s);

      if (s.stage === 'roll') {
        if (!s.turnResolved) {
          // timeout → server rolls
          const die = ctx.rollDie ? ctx.rollDie() : 1;
          s.die = die;
          s.consecutiveSixes = die === 6 ? s.consecutiveSixes + 1 : 0;
          s.turnResolved = true;
        }
        // roll transition
        if (s.die === 6 && s.consecutiveSixes === 3) {
          passToNext(s); // third six is void
          return s;
        }
        const legal = legalTokensFor(s, active, s.die!);
        if (legal.length > 0) {
          s.legalTokens = legal;
          s.stage = 'move';
          s.turnResolved = false;
          s.phase = movePhase(s);
          return s;
        }
        if (s.die === 6) {
          // bonus roll even with no legal move
          s.die = null;
          s.stage = 'roll';
          s.turnResolved = false;
          s.phase = rollPhase(s);
          return s;
        }
        passToNext(s);
        return s;
      }

      // move stage
      if (!s.turnResolved) {
        applyMove(s, active, priorityToken(s, active, s.legalTokens), true);
        s.turnResolved = true;
      }
      if (finishedCount(s, active) === s.tokensPerColor) {
        s.finishedOrder.push(active);
        s.status = 'complete';
        s.stage = 'done';
        return s;
      }
      if (s.die === 6) {
        s.die = null;
        s.stage = 'roll';
        s.turnResolved = false;
        s.phase = rollPhase(s);
        return s;
      }
      passToNext(s);
      return s;
    }

    // player actions
    const actor = action.memberId;
    if (action.type === 'roll') {
      const die = ctx.rollDie ? ctx.rollDie() : 1;
      s.die = die;
      s.consecutiveSixes = die === 6 ? s.consecutiveSixes + 1 : 0;
      s.lastEvent = { memberId: actor, die, tokenIndex: null, captured: [], auto: false };
      s.turnResolved = true;
    } else if (action.type === 'move') {
      applyMove(s, actor, (action.payload as { tokenIndex: number }).tokenIndex, false);
      s.turnResolved = true;
    }
    return s;
  },

  allInputsIn(state): boolean {
    return state.turnResolved;
  },

  projectPublic(state): GamePublicView {
    return {
      gameType: 'ludo',
      round: state.round,
      totalRounds: state.totalRounds,
      phaseKind: state.stage === 'done' ? 'complete' : state.stage,
      prompt: {
        preset: state.preset,
        seatOrder: state.seatOrder,
        seatColor: state.seatColor,
        tokensPerColor: state.tokensPerColor,
        activeMemberId: state.stage === 'done' ? null : activeSeat(state),
        stage: state.stage,
        die: state.die,
        legalTokens: state.stage === 'move' ? state.legalTokens : [],
        positions: state.positions,
        consecutiveSixes: state.consecutiveSixes,
        finishedOrder: state.finishedOrder,
        lastEvent: state.lastEvent,
        safeCells: [...LUDO_SAFE_CELLS],
      },
      reveal: state.stage === 'done' ? { finishedOrder: state.finishedOrder, positions: state.positions } : undefined,
    };
  },

  projectPrivate(state, memberId): GamePrivateView {
    return { awaitingInput: state.stage !== 'done' && activeSeat(state) === memberId && !state.turnResolved };
  },

  score(): GameScoreResult {
    return { max: 0, entries: [] };
  },

  placement(state): PlacementResult {
    const progressSum = (id: string) =>
      (state.positions[id] ?? []).reduce((sum, p) => sum + (p < 0 ? 0 : p === LUDO_HOME ? 57 : p + 1), 0);
    const key = (id: string): [number, number] => [finishedCount(state, id), progressSum(id)];

    const sorted = [...state.seatOrder].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return kb[0] - ka[0] || kb[1] - ka[1];
    });
    const same = (a: string, b: string) => {
      const ka = key(a);
      const kb = key(b);
      return ka[0] === kb[0] && ka[1] === kb[1];
    };
    const ranked: Array<{ memberId: string; rank: number; metric: number }> = [];
    sorted.forEach((id, i) => {
      const rank = i > 0 && same(sorted[i - 1]!, id) ? ranked[i - 1]!.rank : i + 1;
      ranked.push({ memberId: id, rank, metric: progressSum(id) });
    });

    const awards: PlacementResult['awards'] = [];
    if (state.finishedOrder.length > 0)
      awards.push({ key: 'ludo_winner', title: 'First home', memberId: state.finishedOrder[0]!, detail: 'All tokens home' });
    return { standings: ranked, awards };
  },
};

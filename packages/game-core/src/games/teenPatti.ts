/**
 * Teen Patti: Capped Party (plan §5).
 *
 * Six hands of three cards. Each hand: a 1-chip boot from every seat, then blind
 * (pay the base) / seen (pay double) betting, one raise doubling the base up to a
 * cap of 16, at most three circuits, then a head-to-head show (2 left) or a forced
 * showdown. Tied hands split the pot; the winner of a hand where everyone else
 * folded is never revealed. Session winner is the highest cumulative net chips.
 *
 * Chips are free and non-redeemable, reset every hand; nothing here is a wager of
 * value (plan §16). Privacy: a blind seat's cards are absent from every projection
 * — including its own — until it chooses to see; folded and un-contested hands
 * stay secret; a showdown reveals only the surviving hands.
 *
 * A timed-out seat PACKS (folds) — the server never wagers on a player's behalf.
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
import { FULL_DECK, sortHand } from '../cards/cards.js';
import { compare3 } from '../cards/teenPattiRank.js';

const TOTAL_HANDS = 6;
const BOOT = 1;
const BASE_START = 1;
const BASE_CAP = 16;
const MAX_CIRCUITS = 3;
const TURN_MS = 20_000;
const REVEAL_MS = 8_000;

type ShowKind = 'fold' | 'show' | 'showdown';

export interface TeenPattiState extends BaseGameState {
  gameType: 'teen_patti';
  seatOrder: string[];
  initialDealerIndex: number;
  handIndex: number;
  totalHands: number;
  dealerIndex: number;
  hands: Record<string, string[]>;
  seen: Record<string, boolean>;
  folded: Record<string, boolean>;
  contributed: Record<string, number>;
  pot: number;
  base: number;
  bettingOrder: string[];
  turnPtr: number;
  turnSeq: number;
  circuits: number;
  stage: 'betting' | 'hand_over' | 'done';
  lastAction: { memberId: string; type: string; amount?: number } | null;
  reveal: { kind: ShowKind; hands: Record<string, string[]>; winners: string[]; pot: number } | null;
  sessionNet: Record<string, number>;
  handResults: Array<{ pot: number; winners: string[]; net: Record<string, number> }>;
  turnResolved: boolean;
  pendingShow: boolean;
}

function bettingPhase(s: TeenPattiState): PhaseSpec {
  return { id: `teen_patti-h${s.handIndex}-t${s.turnSeq}`, kind: 'betting', round: s.handIndex + 1, durationMs: TURN_MS, collectsInput: true };
}
function revealPhase(s: TeenPattiState): PhaseSpec {
  return { id: `teen_patti-h${s.handIndex}-reveal`, kind: 'reveal', round: s.handIndex + 1, durationMs: REVEAL_MS, collectsInput: false };
}

function activeIds(s: TeenPattiState): string[] {
  return s.seatOrder.filter((id) => !s.folded[id]);
}
function currentActor(s: TeenPattiState): string {
  return s.bettingOrder[s.turnPtr]!;
}
function callCost(s: TeenPattiState, id: string): number {
  return s.seen[id] ? 2 * s.base : s.base;
}
function canRaise(s: TeenPattiState): boolean {
  return Math.min(2 * s.base, BASE_CAP) > s.base;
}
function raiseCost(s: TeenPattiState, id: string): number {
  const nb = Math.min(2 * s.base, BASE_CAP);
  return s.seen[id] ? 2 * nb : nb;
}
function otherActive(s: TeenPattiState, id: string): string | null {
  const rest = activeIds(s).filter((x) => x !== id);
  return rest.length === 1 ? rest[0]! : null;
}
function showAllowed(s: TeenPattiState, requester: string): boolean {
  if (activeIds(s).length !== 2) return false;
  const opp = otherActive(s, requester);
  if (!opp) return false;
  // A blind requester may always ask; a seen requester may only ask a seen opponent.
  return !s.seen[requester] || !!s.seen[opp];
}
function showCost(s: TeenPattiState, requester: string): number {
  return s.seen[requester] ? 2 * s.base : s.base;
}

function startHand(s: TeenPattiState, handIndex: number, shuffle?: <T>(a: readonly T[]) => T[]): void {
  const n = s.seatOrder.length;
  s.handIndex = handIndex;
  s.dealerIndex = (s.initialDealerIndex + handIndex) % n;
  const deck = shuffle ? shuffle(FULL_DECK) : [...FULL_DECK];
  s.hands = {};
  s.seatOrder.forEach((seat, i) => {
    s.hands[seat] = sortHand(deck.slice(i * 3, i * 3 + 3));
  });
  s.seen = Object.fromEntries(s.seatOrder.map((id) => [id, false]));
  s.folded = Object.fromEntries(s.seatOrder.map((id) => [id, false]));
  s.contributed = Object.fromEntries(s.seatOrder.map((id) => [id, BOOT]));
  s.pot = n * BOOT;
  s.base = BASE_START;
  s.bettingOrder = [];
  for (let k = 1; k <= n; k++) s.bettingOrder.push(s.seatOrder[(s.dealerIndex + k) % n]!); // dealer's left first
  s.turnPtr = 0;
  s.turnSeq += 1;
  s.circuits = 0;
  s.stage = 'betting';
  s.lastAction = null;
  s.reveal = null;
  s.turnResolved = false;
  s.pendingShow = false;
  s.round = handIndex + 1;
  s.phase = bettingPhase(s);
}

/** Move to the next non-folded seat, counting a circuit each full wrap. */
function advanceTurn(s: TeenPattiState): void {
  const L = s.bettingOrder.length;
  let idx = s.turnPtr;
  for (let step = 0; step < L + 1; step++) {
    idx = (idx + 1) % L;
    if (idx === 0) s.circuits += 1;
    if (!s.folded[s.bettingOrder[idx]!]) break;
  }
  s.turnPtr = idx;
}

function settleHand(s: TeenPattiState, kind: ShowKind, contenders: string[]): void {
  const n = s.seatOrder.length;
  let winners: string[];
  if (kind === 'fold') {
    winners = [...contenders]; // lone survivor
  } else {
    let best = contenders[0]!;
    winners = [best];
    for (let i = 1; i < contenders.length; i++) {
      const c = compare3(s.hands[contenders[i]!]!, s.hands[best]!);
      if (c > 0) {
        best = contenders[i]!;
        winners = [best];
      } else if (c === 0) {
        winners.push(contenders[i]!);
      }
    }
  }

  const pot = s.pot;
  const share = Math.floor(pot / winners.length);
  let remainder = pot - share * winners.length;
  const payout: Record<string, number> = {};
  for (const w of winners) payout[w] = share;
  // Indivisible remainder goes clockwise from the dealer's left.
  for (let k = 1; k <= n && remainder > 0; k++) {
    const id = s.seatOrder[(s.dealerIndex + k) % n]!;
    if (winners.includes(id)) {
      payout[id] = (payout[id] ?? 0) + 1;
      remainder -= 1;
    }
  }

  const net: Record<string, number> = {};
  for (const id of s.seatOrder) {
    net[id] = (payout[id] ?? 0) - (s.contributed[id] ?? 0);
    s.sessionNet[id] = (s.sessionNet[id] ?? 0) + net[id];
  }

  const revealHands: Record<string, string[]> = {};
  if (kind !== 'fold') for (const id of contenders) revealHands[id] = s.hands[id]!;

  s.reveal = { kind, hands: revealHands, winners, pot };
  s.handResults.push({ pot, winners, net });
  s.stage = 'hand_over';
  s.turnResolved = false;
  s.phase = revealPhase(s);
}

export const teenPatti: GameModule<TeenPattiState> = {
  type: 'teen_patti',
  interactionMode: 'sequential',
  resultKind: 'placement',
  manifest: {
    type: 'teen_patti',
    title: 'Teen Patti',
    family: 'Cards',
    minPlayers: 3,
    maxPlayers: 6,
    maxRaw: 100,
    summary: 'Three-card bluffing with free chips. Play blind or peek and pay double; six hands, biggest net stack wins.',
    example: 'Blind at base 1 you pay 1; see your cards and you pay 2. Raise doubles the base up to 16.',
  },

  selectContent() {
    return [];
  },

  initialState(ctx: InitContext): TeenPattiState {
    const seatOrder = [...ctx.members].sort((a, b) => a.seat - b.seat).map((m) => m.memberId);
    const s: TeenPattiState = {
      gameType: 'teen_patti',
      status: 'active',
      round: 1,
      totalRounds: TOTAL_HANDS,
      phase: { id: 'teen_patti-init', kind: 'betting', round: 1, durationMs: TURN_MS, collectsInput: true },
      seatOrder,
      initialDealerIndex: 0,
      handIndex: 0,
      totalHands: TOTAL_HANDS,
      dealerIndex: 0,
      hands: {},
      seen: {},
      folded: {},
      contributed: {},
      pot: 0,
      base: BASE_START,
      bettingOrder: [],
      turnPtr: 0,
      turnSeq: 0,
      circuits: 0,
      stage: 'betting',
      lastAction: null,
      reveal: null,
      sessionNet: Object.fromEntries(seatOrder.map((id) => [id, 0])),
      handResults: [],
      turnResolved: false,
      pendingShow: false,
    };
    startHand(s, 0, ctx.shuffle);
    return s;
  },

  validateAction(state, memberId, action: GameAction): Validation {
    if (state.stage !== 'betting') return { ok: false, code: 'wrong_phase', message: 'No betting right now' };
    if (currentActor(state) !== memberId) return { ok: false, code: 'not_permitted', message: 'Not your turn' };
    if (state.turnResolved) return { ok: false, code: 'duplicate', message: 'You have already acted' };
    switch (action.type) {
      case 'see':
        if (state.seen[memberId]) return { ok: false, code: 'duplicate', message: 'Already seen' };
        return { ok: true };
      case 'bet': {
        const raise = (action.payload as { raise?: boolean } | undefined)?.raise === true;
        if (raise && !canRaise(state)) return { ok: false, code: 'not_permitted', message: 'The base is already at the cap' };
        return { ok: true };
      }
      case 'fold':
        return { ok: true };
      case 'show':
        if (!showAllowed(state, memberId)) return { ok: false, code: 'not_permitted', message: 'You cannot ask for a show now' };
        return { ok: true };
      default:
        return { ok: false, code: 'invalid_payload', message: `Unknown action ${action.type}` };
    }
  },

  reduce(state, action: ReduceAction, ctx: ReduceContext): TeenPattiState {
    const s = structuredClone(state) as TeenPattiState;

    if (isAdvance(action)) {
      if (s.stage === 'done') return s;
      if (s.stage === 'hand_over') {
        if (s.handIndex + 1 < s.totalHands) startHand(s, s.handIndex + 1, ctx.shuffle);
        else {
          s.stage = 'done';
          s.status = 'complete';
          s.phase = { ...s.phase, kind: 'done' };
        }
        return s;
      }
      // betting: a timeout packs the current actor
      const active = currentActor(s);
      if (!s.turnResolved) {
        s.folded[active] = true;
        s.lastAction = { memberId: active, type: 'fold' };
        s.turnResolved = true;
      }

      if (s.pendingShow) {
        settleHand(s, 'show', activeIds(s));
        return s;
      }
      const active2 = activeIds(s);
      if (active2.length === 1) {
        settleHand(s, 'fold', active2);
        return s;
      }
      advanceTurn(s);
      if (s.circuits >= MAX_CIRCUITS) {
        settleHand(s, 'showdown', activeIds(s));
        return s;
      }
      s.turnSeq += 1;
      s.turnResolved = false;
      s.phase = bettingPhase(s);
      return s;
    }

    const actor = action.memberId;
    switch (action.type) {
      case 'see':
        s.seen[actor] = true; // does not resolve the turn or reset the clock
        s.lastAction = { memberId: actor, type: 'see' };
        break;
      case 'bet': {
        const raise = (action.payload as { raise?: boolean } | undefined)?.raise === true && canRaise(s);
        const cost = raise ? raiseCost(s, actor) : callCost(s, actor);
        if (raise) s.base = Math.min(2 * s.base, BASE_CAP);
        s.contributed[actor] = (s.contributed[actor] ?? 0) + cost;
        s.pot += cost;
        s.lastAction = { memberId: actor, type: raise ? 'raise' : 'play', amount: cost };
        s.turnResolved = true;
        break;
      }
      case 'fold':
        s.folded[actor] = true;
        s.lastAction = { memberId: actor, type: 'fold' };
        s.turnResolved = true;
        break;
      case 'show': {
        const cost = showCost(s, actor);
        s.contributed[actor] = (s.contributed[actor] ?? 0) + cost;
        s.pot += cost;
        s.lastAction = { memberId: actor, type: 'show', amount: cost };
        s.pendingShow = true;
        s.turnResolved = true;
        break;
      }
    }
    return s;
  },

  allInputsIn(state): boolean {
    return state.turnResolved;
  },

  projectPublic(state): GamePublicView {
    const active = activeIds(state);
    return {
      gameType: 'teen_patti',
      round: state.round,
      totalRounds: state.totalRounds,
      phaseKind: state.stage === 'done' ? 'complete' : state.phase.kind,
      prompt: {
        stage: state.stage,
        handIndex: state.handIndex,
        totalHands: state.totalHands,
        dealerMemberId: state.seatOrder[state.dealerIndex],
        seatOrder: state.seatOrder,
        activeMemberId: state.stage === 'betting' ? currentActor(state) : null,
        pot: state.pot,
        base: state.base,
        circuit: state.circuits,
        seen: state.seen,
        folded: state.folded,
        contributed: state.contributed,
        sessionNet: state.sessionNet,
        activeCount: active.length,
        lastAction: state.lastAction,
        reveal: state.reveal, // revealed hands are contenders only; folded stay secret
      },
      reveal:
        state.stage === 'done'
          ? { sessionNet: state.sessionNet, handResults: state.handResults.map((h) => ({ pot: h.pot, winners: h.winners })) }
          : (state.reveal ?? undefined),
    };
  },

  projectPrivate(state, memberId): GamePrivateView {
    const myTurn = state.stage === 'betting' && currentActor(state) === memberId && !state.turnResolved;
    // A blind seat never receives its own cards until it sees.
    const myHand = state.seen[memberId] ? sortHand(state.hands[memberId] ?? []) : null;
    const secret: Record<string, unknown> = { myHand, seen: !!state.seen[memberId] };
    if (myTurn) {
      secret.canSee = !state.seen[memberId];
      secret.callCost = callCost(state, memberId);
      secret.canRaise = canRaise(state);
      secret.raiseCost = canRaise(state) ? raiseCost(state, memberId) : null;
      secret.canShow = showAllowed(state, memberId);
      secret.showCost = showAllowed(state, memberId) ? showCost(state, memberId) : null;
    }
    return { awaitingInput: myTurn, secret };
  },

  score(): GameScoreResult {
    return { max: 0, entries: [] };
  },

  placement(state): PlacementResult {
    const seats = [...state.seatOrder].sort((a, b) => (state.sessionNet[b] ?? 0) - (state.sessionNet[a] ?? 0));
    const ranked: Array<{ memberId: string; rank: number; metric: number }> = [];
    seats.forEach((id, i) => {
      const tiedWithPrev = i > 0 && (state.sessionNet[seats[i - 1]!] ?? 0) === (state.sessionNet[id] ?? 0);
      ranked.push({ memberId: id, rank: tiedWithPrev ? ranked[i - 1]!.rank : i + 1, metric: state.sessionNet[id] ?? 0 });
    });

    const awards: PlacementResult['awards'] = [];
    let biggest: { pot: number; winners: string[] } | null = null;
    for (const h of state.handResults) if (!biggest || h.pot > biggest.pot) biggest = { pot: h.pot, winners: h.winners };
    if (biggest && biggest.winners.length > 0)
      awards.push({ key: 'biggest_pot', title: 'Biggest pot', memberId: biggest.winners[0]!, detail: `${biggest.pot} chips` });
    return { standings: ranked, awards };
  },
};

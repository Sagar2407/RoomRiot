/**
 * Judgement — the exact-trick bidding game (Kachuful / Oh Hell family, plan §6).
 *
 * Six deals of 1,2,3,3,2,1 cards with trump rotating S→D→C→H. Each seat bids how
 * many tricks it will take; the dealer bids last and may not make the bids sum to
 * the number of tricks (the "dealer hook"). Play follows suit when able; the
 * highest trump, else the highest card of the led suit, wins and leads next. Hit
 * your bid exactly for 10 + bid; miss by any amount for 0.
 *
 * Hands are private: a seat's cards live only in its own projection, never in the
 * public view, the display token, or an opponent's projection. Deck order comes
 * from a server-side cryptographic shuffle (ctx.shuffle) and is never sent out.
 *
 * Sequential turns run on the shared phase/advance engine: each phase is one
 * seat's single decision (a bid or a card). A timed-out seat is auto-played by
 * the server with the documented fallback (lowest legal bid / lowest legal card).
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
import { FULL_DECK, legalPlays, rankValue, sortHand, suitOf, trickWinner, type Suit } from '../cards/cards.js';

const DEAL_SIZES = [1, 2, 3, 3, 2, 1];
const TRUMP_SEQUENCE: Suit[] = ['S', 'D', 'C', 'H'];
const BID_MS = 20_000;
const PLAY_MS = 15_000;

export interface JudgementState extends BaseGameState {
  gameType: 'judgement';
  seatOrder: string[];
  initialDealerIndex: number;
  dealIndex: number;
  handSize: number;
  trump: Suit;
  dealerIndex: number;
  stage: 'bidding' | 'playing' | 'done';
  hands: Record<string, string[]>;
  bids: Record<string, number>;
  bidOrder: string[];
  bidTurnIndex: number;
  tricksWon: Record<string, number>;
  trickCount: number;
  currentTrick: Array<{ memberId: string; card: string }>;
  leadSuit: Suit | null;
  trickLeaderIndex: number;
  scores: Record<string, number>;
  dealResults: Array<Record<string, { bid: number; won: number; points: number }>>;
  lastTrick: { plays: Array<{ memberId: string; card: string }>; winner: string } | null;
  turnResolved: boolean;
}

function range(nInclusive: number): number[] {
  return Array.from({ length: nInclusive + 1 }, (_, i) => i);
}

function dealHands(seatOrder: string[], handSize: number, shuffle?: <T>(a: readonly T[]) => T[]): Record<string, string[]> {
  const deck = shuffle ? shuffle(FULL_DECK) : [...FULL_DECK];
  const hands: Record<string, string[]> = {};
  seatOrder.forEach((seat, i) => {
    hands[seat] = sortHand(deck.slice(i * handSize, (i + 1) * handSize));
  });
  return hands;
}

/** Bidding order: dealer's left first … dealer last. */
function bidOrderFor(seatOrder: string[], dealerIndex: number): string[] {
  const n = seatOrder.length;
  const order: string[] = [];
  for (let k = 1; k <= n; k++) order.push(seatOrder[(dealerIndex + k) % n]!);
  return order;
}

function phaseBid(s: JudgementState): PhaseSpec {
  return { id: `judgement-d${s.dealIndex}-bid${s.bidTurnIndex}`, kind: 'bidding', round: s.dealIndex + 1, durationMs: BID_MS, collectsInput: true };
}
function phasePlay(s: JudgementState): PhaseSpec {
  return { id: `judgement-d${s.dealIndex}-t${s.trickCount}-c${s.currentTrick.length}`, kind: 'playing', round: s.dealIndex + 1, durationMs: PLAY_MS, collectsInput: true };
}

function setupDeal(s: JudgementState, dealIndex: number, shuffle?: <T>(a: readonly T[]) => T[]): void {
  const n = s.seatOrder.length;
  s.dealIndex = dealIndex;
  s.handSize = DEAL_SIZES[dealIndex]!;
  s.trump = TRUMP_SEQUENCE[dealIndex % TRUMP_SEQUENCE.length]!;
  s.dealerIndex = (s.initialDealerIndex + dealIndex) % n;
  s.hands = dealHands(s.seatOrder, s.handSize, shuffle);
  s.bids = {};
  s.bidOrder = bidOrderFor(s.seatOrder, s.dealerIndex);
  s.bidTurnIndex = 0;
  s.tricksWon = Object.fromEntries(s.seatOrder.map((id) => [id, 0]));
  s.trickCount = 0;
  s.currentTrick = [];
  s.leadSuit = null;
  s.trickLeaderIndex = (s.dealerIndex + 1) % n;
  s.stage = 'bidding';
  s.turnResolved = false;
  s.round = dealIndex + 1;
  s.phase = phaseBid(s);
}

function activeSeat(s: JudgementState): string | null {
  if (s.stage === 'bidding') return s.bidOrder[s.bidTurnIndex] ?? null;
  if (s.stage === 'playing') return s.seatOrder[(s.trickLeaderIndex + s.currentTrick.length) % s.seatOrder.length] ?? null;
  return null;
}

function legalBidsFor(s: JudgementState, memberId: string): number[] {
  const all = range(s.handSize);
  const isDealer = s.bidTurnIndex === s.bidOrder.length - 1 && s.bidOrder[s.bidTurnIndex] === memberId;
  if (!isDealer) return all;
  const sumOthers = Object.values(s.bids).reduce((a, b) => a + b, 0);
  const forbidden = s.handSize - sumOthers; // making bids sum to available tricks is illegal
  return all.filter((v) => v !== forbidden);
}

function lowestLegalCard(hand: string[], leadSuit: Suit | null): string {
  const legal = legalPlays(hand, leadSuit);
  const suitIdx: Record<Suit, number> = { S: 0, H: 1, D: 2, C: 3 };
  return [...legal].sort((a, b) => rankValue(a) - rankValue(b) || suitIdx[suitOf(a)] - suitIdx[suitOf(b)])[0]!;
}

function applyPlay(s: JudgementState, memberId: string, card: string): void {
  s.hands[memberId] = (s.hands[memberId] ?? []).filter((c) => c !== card);
  if (s.currentTrick.length === 0) s.leadSuit = suitOf(card);
  s.currentTrick.push({ memberId, card });
}

function scoreDeal(s: JudgementState): void {
  const summary: Record<string, { bid: number; won: number; points: number }> = {};
  for (const seat of s.seatOrder) {
    const bid = s.bids[seat] ?? 0;
    const won = s.tricksWon[seat] ?? 0;
    const points = won === bid ? 10 + bid : 0; // arithmetic, never string concatenation
    s.scores[seat] = (s.scores[seat] ?? 0) + points;
    summary[seat] = { bid, won, points };
  }
  s.dealResults.push(summary);
}

export const judgement: GameModule<JudgementState> = {
  type: 'judgement',
  interactionMode: 'sequential',
  resultKind: 'placement',
  manifest: {
    type: 'judgement',
    title: 'Judgement',
    family: 'Cards',
    minPlayers: 3,
    maxPlayers: 6,
    maxRaw: 100,
    summary: 'Bid exactly how many tricks you will win. Nail it for 10 + your bid; miss by one and you score nothing.',
    example: 'Hand of 3, spades trump: bid 2 and win exactly 2 → 12 points. Win 1 or 3 → 0.',
  },

  selectContent() {
    return [];
  },

  initialState(ctx: InitContext): JudgementState {
    const seatOrder = [...ctx.members].sort((a, b) => a.seat - b.seat).map((m) => m.memberId);
    const s: JudgementState = {
      gameType: 'judgement',
      status: 'active',
      round: 1,
      totalRounds: DEAL_SIZES.length,
      phase: { id: 'judgement-init', kind: 'bidding', round: 1, durationMs: BID_MS, collectsInput: true },
      seatOrder,
      initialDealerIndex: 0,
      dealIndex: 0,
      handSize: DEAL_SIZES[0]!,
      trump: TRUMP_SEQUENCE[0]!,
      dealerIndex: 0,
      stage: 'bidding',
      hands: {},
      bids: {},
      bidOrder: [],
      bidTurnIndex: 0,
      tricksWon: {},
      trickCount: 0,
      currentTrick: [],
      leadSuit: null,
      trickLeaderIndex: 0,
      scores: Object.fromEntries(seatOrder.map((id) => [id, 0])),
      dealResults: [],
      lastTrick: null,
      turnResolved: false,
    };
    setupDeal(s, 0, ctx.shuffle);
    return s;
  },

  validateAction(state, memberId, action: GameAction): Validation {
    if (state.stage === 'done') return { ok: false, code: 'wrong_phase', message: 'The game is over' };
    if (activeSeat(state) !== memberId) return { ok: false, code: 'not_permitted', message: 'Not your turn' };
    if (state.turnResolved) return { ok: false, code: 'duplicate', message: 'You have already acted' };
    if (state.stage === 'bidding') {
      if (action.type !== 'bid') return { ok: false, code: 'wrong_phase', message: 'Bidding is open' };
      const bid = (action.payload as { bid?: number } | undefined)?.bid;
      if (typeof bid !== 'number' || !Number.isInteger(bid) || !legalBidsFor(state, memberId).includes(bid))
        return { ok: false, code: 'invalid_payload', message: 'Illegal bid' };
      return { ok: true };
    }
    if (action.type !== 'play_card') return { ok: false, code: 'wrong_phase', message: 'It is the play phase' };
    const card = (action.payload as { card?: string } | undefined)?.card;
    const hand = state.hands[memberId] ?? [];
    if (typeof card !== 'string' || !hand.includes(card)) return { ok: false, code: 'invalid_payload', message: 'You do not hold that card' };
    if (!legalPlays(hand, state.leadSuit).includes(card)) return { ok: false, code: 'not_permitted', message: 'You must follow suit' };
    return { ok: true };
  },

  reduce(state, action: ReduceAction, ctx: ReduceContext): JudgementState {
    const s = structuredClone(state) as JudgementState;
    const n = s.seatOrder.length;

    if (isAdvance(action)) {
      if (s.stage === 'done') return s;
      const active = activeSeat(s)!;
      if (!s.turnResolved) {
        if (s.stage === 'bidding') s.bids[active] = Math.min(...legalBidsFor(s, active));
        else applyPlay(s, active, lowestLegalCard(s.hands[active] ?? [], s.leadSuit));
        s.turnResolved = true;
      }

      if (s.stage === 'bidding') {
        if (s.bidTurnIndex + 1 < s.bidOrder.length) {
          s.bidTurnIndex += 1;
          s.turnResolved = false;
          s.phase = phaseBid(s);
        } else {
          s.stage = 'playing';
          s.trickLeaderIndex = (s.dealerIndex + 1) % n;
          s.currentTrick = [];
          s.leadSuit = null;
          s.trickCount = 0;
          s.turnResolved = false;
          s.phase = phasePlay(s);
        }
        return s;
      }

      // playing — the active seat just played
      if (s.currentTrick.length < n) {
        s.turnResolved = false;
        s.phase = phasePlay(s);
        return s;
      }
      // trick complete
      const winner = trickWinner(s.currentTrick, s.trump).memberId;
      s.tricksWon[winner] = (s.tricksWon[winner] ?? 0) + 1;
      s.lastTrick = { plays: s.currentTrick, winner };
      s.trickCount += 1;
      s.currentTrick = [];
      s.leadSuit = null;
      if (s.trickCount < s.handSize) {
        s.trickLeaderIndex = s.seatOrder.indexOf(winner);
        s.turnResolved = false;
        s.phase = phasePlay(s);
        return s;
      }
      // deal complete
      scoreDeal(s);
      if (s.dealIndex + 1 < DEAL_SIZES.length) {
        setupDeal(s, s.dealIndex + 1, ctx.shuffle);
      } else {
        s.stage = 'done';
        s.status = 'complete';
        s.phase = { ...s.phase, kind: 'done' };
      }
      return s;
    }

    const actor = action.memberId;
    if (action.type === 'bid') {
      s.bids[actor] = (action.payload as { bid: number }).bid;
      s.turnResolved = true;
    } else if (action.type === 'play_card') {
      applyPlay(s, actor, (action.payload as { card: string }).card);
      s.turnResolved = true;
    }
    return s;
  },

  allInputsIn(state): boolean {
    return state.turnResolved;
  },

  projectPublic(state): GamePublicView {
    const handCounts: Record<string, number> = {};
    for (const seat of state.seatOrder) handCounts[seat] = (state.hands[seat] ?? []).length;
    return {
      gameType: 'judgement',
      round: state.round,
      totalRounds: state.totalRounds,
      phaseKind: state.stage === 'done' ? 'complete' : state.phase.kind,
      prompt: {
        stage: state.stage,
        dealIndex: state.dealIndex,
        totalDeals: DEAL_SIZES.length,
        handSize: state.handSize,
        trump: state.trump,
        dealerMemberId: state.seatOrder[state.dealerIndex],
        seatOrder: state.seatOrder,
        activeMemberId: state.stage === 'done' ? null : activeSeat(state),
        bids: state.bids,
        tricksWon: state.tricksWon,
        scores: state.scores,
        handCounts,
        currentTrick: state.currentTrick,
        leadSuit: state.leadSuit,
        trickCount: state.trickCount,
        lastTrick: state.lastTrick,
        dealResults: state.dealResults,
      },
      reveal: state.stage === 'done' ? { scores: state.scores, dealResults: state.dealResults } : undefined,
    };
  },

  projectPrivate(state, memberId): GamePrivateView {
    const hand = sortHand(state.hands[memberId] ?? []);
    const active = activeSeat(state) === memberId;
    const secret: Record<string, unknown> = { hand, trump: state.trump };
    if (active && state.stage === 'bidding') secret.legalBids = legalBidsFor(state, memberId);
    if (active && state.stage === 'playing') secret.legalCards = legalPlays(hand, state.leadSuit);
    return {
      awaitingInput: state.stage !== 'done' && active && !state.turnResolved,
      secret,
    };
  },

  score(): GameScoreResult {
    return { max: 0, entries: [] };
  },

  placement(state): PlacementResult {
    const seats = [...state.seatOrder].sort((a, b) => (state.scores[b] ?? 0) - (state.scores[a] ?? 0));
    const ranked: Array<{ memberId: string; rank: number; metric: number }> = [];
    seats.forEach((id, i) => {
      const tiedWithPrev = i > 0 && (state.scores[seats[i - 1]!] ?? 0) === (state.scores[id] ?? 0);
      ranked.push({ memberId: id, rank: tiedWithPrev ? ranked[i - 1]!.rank : i + 1, metric: state.scores[id] ?? 0 });
    });

    const exact: Record<string, number> = {};
    for (const deal of state.dealResults)
      for (const [seat, r] of Object.entries(deal)) if (r.points > 0) exact[seat] = (exact[seat] ?? 0) + 1;
    const awards: PlacementResult['awards'] = [];
    let best: { id: string; n: number } | null = null;
    for (const [id, nn] of Object.entries(exact)) if (!best || nn > best.n) best = { id, n: nn };
    if (best && best.n > 0)
      awards.push({ key: 'perfect_forecast', title: 'Perfect forecast', memberId: best.id, detail: `${best.n} exact bid${best.n > 1 ? 's' : ''}` });
    return { standings: ranked, awards };
  },
};

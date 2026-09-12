/**
 * Bluff Bureau — the bluffing game (blueprint §5).
 *
 * Three rounds. A curated question has a surprising true answer. Each player
 * writes a plausible decoy. The app shuffles the truth with the unique decoys,
 * hides authors, and everyone picks the truth.
 *
 * Raw per round: 60 for finding the truth, plus 10 per other player fooled by
 * your decoy (capped at 40). Max 100/round, 300/game. No self-votes; authors
 * cannot pick their own decoy. Duplicate or truth-matching decoys are dropped and
 * earn their author nothing.
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

const WRITE_MS = 35_000;
const CHOOSE_MS = 20_000;
const REVEAL_MS = 15_000;
const TOTAL_ROUNDS = 3;
const MAX_LEN = 120;

interface BBContent {
  question: string;
  answer: string;
  source?: string;
}
interface BBOption {
  id: string;
  text: string;
  authorMemberId: string | null; // null = the truth
  isTruth: boolean;
}
interface BBRound {
  question: string;
  truth: string;
  decoys: Record<string, string>;
  options: BBOption[];
  votes: Record<string, string>; // memberId -> optionId
  settled: boolean;
  optionsBuilt: boolean;
}
export interface BluffBureauState extends BaseGameState {
  gameType: 'bluff_bureau';
  seatOrder: string[]; // memberIds in seat order (deterministic decoy assignment)
  rounds: BBRound[];
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:'"()\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function phaseFor(round: number, kind: 'writing' | 'voting' | 'reveal'): PhaseSpec {
  const durationMs = kind === 'writing' ? WRITE_MS : kind === 'voting' ? CHOOSE_MS : REVEAL_MS;
  return {
    id: `bluff_bureau-r${round}-${kind}`,
    kind,
    round,
    durationMs,
    collectsInput: kind !== 'reveal',
  };
}

function buildOptions(round: BBRound, seatOrder: string[], rng: RNG): void {
  const seen = new Set<string>([normalize(round.truth)]);
  const opts: BBOption[] = [];
  for (const mid of seatOrder) {
    const text = round.decoys[mid];
    if (!text) continue;
    const norm = normalize(text);
    if (seen.has(norm)) continue; // duplicate or truth-matching → dropped
    seen.add(norm);
    opts.push({ id: `d-${mid}`, text, authorMemberId: mid, isTruth: false });
  }
  opts.push({ id: 'truth', text: round.truth, authorMemberId: null, isTruth: true });
  rng.shuffle(opts);
  round.options = opts;
  round.optionsBuilt = true;
}

function settle(round: BBRound): void {
  round.settled = true;
  const voteCount: Record<string, number> = {};
  for (const oid of Object.values(round.votes)) voteCount[oid] = (voteCount[oid] ?? 0) + 1;
  (round as unknown as { voteCount: Record<string, number> }).voteCount = voteCount;
}

export const bluffBureau: GameModule<BluffBureauState> = {
  type: 'bluff_bureau',
  manifest: {
    type: 'bluff_bureau',
    title: 'Bluff Bureau',
    family: 'Bluffing',
    minPlayers: 4,
    maxPlayers: 10,
    maxRaw: 300,
    summary: 'Mix a curated true answer with player-written decoys; find the truth and sell your lie.',
    example:
      'A curated question has one surprising true answer. Write a convincing fake, then pick the real answer from the shuffled list. Fool others for bonus points.',
  },

  selectContent(all, rng) {
    const pool = [...all];
    rng.shuffle(pool);
    return pool.slice(0, TOTAL_ROUNDS);
  },

  initialState(ctx: InitContext): BluffBureauState {
    const seatOrder = [...ctx.members].sort((a, b) => a.seat - b.seat).map((m) => m.memberId);
    const rounds: BBRound[] = ctx.content.slice(0, TOTAL_ROUNDS).map((c) => {
      const d = c.data as BBContent;
      return {
        question: d.question,
        truth: d.answer,
        decoys: {},
        options: [],
        votes: {},
        settled: false,
        optionsBuilt: false,
      };
    });
    return {
      gameType: 'bluff_bureau',
      status: 'active',
      round: 1,
      totalRounds: rounds.length,
      phase: phaseFor(1, 'writing'),
      seatOrder,
      rounds,
    };
  },

  validateAction(state, memberId, action: GameAction): Validation {
    const round = state.rounds[state.round - 1]!;
    if (action.type === 'submit_decoy') {
      if (state.phase.kind !== 'writing')
        return { ok: false, code: 'wrong_phase', message: 'Not writing now.' };
      if (round.decoys[memberId] !== undefined)
        return { ok: false, code: 'duplicate', message: 'Decoy already submitted.' };
      const p = action.payload as { text?: unknown } | undefined;
      if (!p || typeof p.text !== 'string' || p.text.trim().length === 0 || p.text.length > MAX_LEN)
        return { ok: false, code: 'invalid_payload', message: `1–${MAX_LEN} characters.` };
      if (normalize(p.text) === normalize(round.truth))
        return { ok: false, code: 'invalid_payload', message: 'Too close to the real answer — try another.' };
      return { ok: true };
    }
    if (action.type === 'submit_vote') {
      if (state.phase.kind !== 'voting')
        return { ok: false, code: 'wrong_phase', message: 'Not voting now.' };
      if (round.votes[memberId] !== undefined)
        return { ok: false, code: 'duplicate', message: 'Vote already cast.' };
      const p = action.payload as { optionId?: unknown } | undefined;
      const opt = round.options.find((o) => o.id === p?.optionId);
      if (!opt) return { ok: false, code: 'invalid_payload', message: 'Unknown option.' };
      if (opt.authorMemberId === memberId)
        return { ok: false, code: 'not_permitted', message: 'You cannot pick your own decoy.' };
      return { ok: true };
    }
    return { ok: false, code: 'not_permitted', message: 'Unknown action.' };
  },

  reduce(state, action: ReduceAction, ctx: ReduceContext): BluffBureauState {
    const next: BluffBureauState = structuredClone(state);
    const round = next.rounds[next.round - 1]!;

    if (!isAdvance(action)) {
      if (action.type === 'submit_decoy' && next.phase.kind === 'writing') {
        round.decoys[action.memberId] = (action.payload as { text: string }).text.trim();
      } else if (action.type === 'submit_vote' && next.phase.kind === 'voting') {
        round.votes[action.memberId] = (action.payload as { optionId: string }).optionId;
      }
      return next;
    }

    if (next.phase.kind === 'writing') {
      buildOptions(round, next.seatOrder, ctx.rng);
      next.phase = phaseFor(next.round, 'voting');
    } else if (next.phase.kind === 'voting') {
      settle(round);
      next.phase = phaseFor(next.round, 'reveal');
    } else {
      if (next.round < next.totalRounds) {
        next.round += 1;
        next.phase = phaseFor(next.round, 'writing');
      } else {
        next.status = 'complete';
      }
    }
    return next;
  },

  allInputsIn(state, activeMemberIds): boolean {
    const round = state.rounds[state.round - 1]!;
    if (state.phase.kind === 'writing')
      return activeMemberIds.length > 0 && activeMemberIds.every((m) => round.decoys[m] !== undefined);
    if (state.phase.kind === 'voting')
      return activeMemberIds.length > 0 && activeMemberIds.every((m) => round.votes[m] !== undefined);
    return false;
  },

  projectPublic(state): GamePublicView {
    const round = state.rounds[state.round - 1]!;
    const base: GamePublicView = {
      gameType: 'bluff_bureau',
      round: state.round,
      totalRounds: state.totalRounds,
      phaseKind: state.phase.kind,
      prompt: { question: round.question },
    };
    if (state.phase.kind === 'voting') {
      base.options = round.options.map((o) => ({ id: o.id, label: o.text }));
    }
    if (state.phase.kind === 'reveal') {
      const voteCount = (round as unknown as { voteCount?: Record<string, number> }).voteCount ?? {};
      base.reveal = {
        truthOptionId: 'truth',
        options: round.options.map((o) => ({
          id: o.id,
          text: o.text,
          authorMemberId: o.authorMemberId,
          isTruth: o.isTruth,
          votes: voteCount[o.id] ?? 0,
        })),
        votes: round.votes,
      };
    }
    return base;
  },

  projectPrivate(state, memberId): GamePrivateView {
    const round = state.rounds[state.round - 1]!;
    if (state.phase.kind === 'writing') {
      return { awaitingInput: round.decoys[memberId] === undefined };
    }
    if (state.phase.kind === 'voting') {
      const own = round.options.find((o) => o.authorMemberId === memberId);
      return {
        awaitingInput: round.votes[memberId] === undefined,
        secret: { ownOptionId: own?.id ?? null },
      };
    }
    return { awaitingInput: false };
  },

  score(state) {
    let counted = 0;
    const raw: Record<string, number> = {};
    const fooledTally: Record<string, number> = {};
    for (const round of state.rounds) {
      if (!round.settled) continue;
      counted += 1;
      const voteCount: Record<string, number> = {};
      for (const oid of Object.values(round.votes)) voteCount[oid] = (voteCount[oid] ?? 0) + 1;
      // Everyone who wrote a decoy or voted is an eligible scorer this round.
      const participants = new Set<string>([...Object.keys(round.decoys), ...Object.keys(round.votes)]);
      for (const mid of participants) raw[mid] ??= 0;
      // Truth-finding points.
      for (const [mid, oid] of Object.entries(round.votes)) {
        const opt = round.options.find((o) => o.id === oid);
        if (opt?.isTruth) raw[mid] = (raw[mid] ?? 0) + 60;
      }
      // Decoy points: 10 per other voter fooled, capped at 40.
      for (const opt of round.options) {
        if (opt.isTruth || !opt.authorMemberId) continue;
        const fooled = voteCount[opt.id] ?? 0;
        fooledTally[opt.authorMemberId] = (fooledTally[opt.authorMemberId] ?? 0) + fooled;
        raw[opt.authorMemberId] = (raw[opt.authorMemberId] ?? 0) + Math.min(40, fooled * 10);
      }
    }
    const entries = Object.keys(raw).map((memberId) => ({ memberId, raw: raw[memberId]! }));
    const max = counted > 0 ? 100 * counted : 100;
    let best: string | null = null;
    let bestN = 0;
    for (const [mid, n] of Object.entries(fooledTally)) {
      if (n > bestN) {
        bestN = n;
        best = mid;
      }
    }
    const awards =
      best && bestN > 0
        ? [{ key: 'best_bluff', title: 'Best Bluff', memberId: best, detail: `Fooled ${bestN} votes` }]
        : [];
    return { max, entries, awards };
  },
};

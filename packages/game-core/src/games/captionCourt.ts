/**
 * Caption Court — the creative game (blueprint §5).
 *
 * Three rounds. Caption an original text scenario (≤120 chars); vote for a
 * favourite before authors are revealed.
 *
 * Raw per round: 100 × votes received ÷ number of eligible non-author voters.
 * Abstentions stay in the denominator; max 100; no self-voting; equal vote totals
 * earn equal points. Void a round with fewer than three valid captions.
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
const VOTE_MS = 20_000;
const REVEAL_MS = 12_000;
const TOTAL_ROUNDS = 3;
const MAX_LEN = 120;

interface CCContent {
  scenario: string;
}
interface CCOption {
  id: string;
  text: string;
  authorMemberId: string;
}
interface CCRound {
  scenario: string;
  captions: Record<string, string>;
  options: CCOption[];
  votes: Record<string, string>;
  settled: boolean;
  voided: boolean;
  eligibleVoters: number;
}
export interface CaptionCourtState extends BaseGameState {
  gameType: 'caption_court';
  rounds: CCRound[];
}

function phaseFor(round: number, kind: 'writing' | 'voting' | 'reveal'): PhaseSpec {
  const durationMs = kind === 'writing' ? WRITE_MS : kind === 'voting' ? VOTE_MS : REVEAL_MS;
  return {
    id: `caption_court-r${round}-${kind}`,
    kind,
    round,
    durationMs,
    collectsInput: kind !== 'reveal',
  };
}

export const captionCourt: GameModule<CaptionCourtState> = {
  type: 'caption_court',
  manifest: {
    type: 'caption_court',
    title: 'Caption Court',
    family: 'Creative',
    minPlayers: 4,
    maxPlayers: 10,
    maxRaw: 300,
    summary: 'Caption an original scenario; vote for the funniest before names are revealed.',
    example:
      'Scenario: “A robot discovers the office coffee budget.” Everyone writes a caption; the room votes for a favourite before authors are exposed.',
  },

  selectContent(all, rng) {
    const pool = [...all];
    rng.shuffle(pool);
    return pool.slice(0, TOTAL_ROUNDS);
  },

  initialState(ctx: InitContext): CaptionCourtState {
    const rounds: CCRound[] = ctx.content.slice(0, TOTAL_ROUNDS).map((c) => ({
      scenario: (c.data as CCContent).scenario,
      captions: {},
      options: [],
      votes: {},
      settled: false,
      voided: false,
      eligibleVoters: 0,
    }));
    return {
      gameType: 'caption_court',
      status: 'active',
      round: 1,
      totalRounds: rounds.length,
      phase: phaseFor(1, 'writing'),
      rounds,
    };
  },

  validateAction(state, memberId, action: GameAction): Validation {
    const round = state.rounds[state.round - 1]!;
    if (action.type === 'submit_caption') {
      if (state.phase.kind !== 'writing')
        return { ok: false, code: 'wrong_phase', message: 'Not writing now.' };
      if (round.captions[memberId] !== undefined)
        return { ok: false, code: 'duplicate', message: 'Caption already submitted.' };
      const p = action.payload as { text?: unknown } | undefined;
      if (!p || typeof p.text !== 'string' || p.text.trim().length === 0 || p.text.length > MAX_LEN)
        return { ok: false, code: 'invalid_payload', message: `1–${MAX_LEN} characters.` };
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
        return { ok: false, code: 'not_permitted', message: 'You cannot vote for your own caption.' };
      return { ok: true };
    }
    return { ok: false, code: 'not_permitted', message: 'Unknown action.' };
  },

  reduce(state, action: ReduceAction, ctx: ReduceContext): CaptionCourtState {
    const next: CaptionCourtState = structuredClone(state);
    const round = next.rounds[next.round - 1]!;

    if (!isAdvance(action)) {
      if (action.type === 'submit_caption' && next.phase.kind === 'writing') {
        round.captions[action.memberId] = (action.payload as { text: string }).text.trim();
      } else if (action.type === 'submit_vote' && next.phase.kind === 'voting') {
        round.votes[action.memberId] = (action.payload as { optionId: string }).optionId;
      }
      return next;
    }

    if (next.phase.kind === 'writing') {
      const authors = Object.keys(round.captions);
      round.eligibleVoters = new Set([...ctx.activeMemberIds, ...authors]).size;
      if (authors.length < 3) {
        round.voided = true;
        round.settled = true;
        round.options = [];
        next.phase = phaseFor(next.round, 'reveal');
      } else {
        const opts: CCOption[] = authors.map((mid) => ({
          id: `c-${mid}`,
          text: round.captions[mid]!,
          authorMemberId: mid,
        }));
        ctx.rng.shuffle(opts);
        round.options = opts;
        next.phase = phaseFor(next.round, 'voting');
      }
    } else if (next.phase.kind === 'voting') {
      round.settled = true;
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
      return activeMemberIds.length > 0 && activeMemberIds.every((m) => round.captions[m] !== undefined);
    if (state.phase.kind === 'voting')
      return activeMemberIds.length > 0 && activeMemberIds.every((m) => round.votes[m] !== undefined);
    return false;
  },

  projectPublic(state): GamePublicView {
    const round = state.rounds[state.round - 1]!;
    const base: GamePublicView = {
      gameType: 'caption_court',
      round: state.round,
      totalRounds: state.totalRounds,
      phaseKind: state.phase.kind,
      prompt: { scenario: round.scenario },
    };
    if (state.phase.kind === 'voting') {
      base.options = round.options.map((o) => ({ id: o.id, label: o.text }));
    }
    if (state.phase.kind === 'reveal') {
      const voteCount: Record<string, number> = {};
      for (const oid of Object.values(round.votes)) voteCount[oid] = (voteCount[oid] ?? 0) + 1;
      base.reveal = {
        voided: round.voided,
        options: round.options.map((o) => ({
          id: o.id,
          text: o.text,
          authorMemberId: o.authorMemberId,
          votes: voteCount[o.id] ?? 0,
        })),
      };
    }
    return base;
  },

  projectPrivate(state, memberId): GamePrivateView {
    const round = state.rounds[state.round - 1]!;
    if (state.phase.kind === 'writing') return { awaitingInput: round.captions[memberId] === undefined };
    if (state.phase.kind === 'voting') {
      const own = round.options.find((o) => o.authorMemberId === memberId);
      return { awaitingInput: round.votes[memberId] === undefined, secret: { ownOptionId: own?.id ?? null } };
    }
    return { awaitingInput: false };
  },

  score(state) {
    let counted = 0;
    const raw: Record<string, number> = {};
    const votesTally: Record<string, number> = {};
    for (const round of state.rounds) {
      if (!round.settled || round.voided) continue;
      counted += 1;
      const denom = Math.max(1, round.eligibleVoters - 1);
      const voteCount: Record<string, number> = {};
      for (const oid of Object.values(round.votes)) voteCount[oid] = (voteCount[oid] ?? 0) + 1;
      for (const mid of Object.keys(round.votes)) raw[mid] ??= 0; // voters are eligible players
      for (const opt of round.options) {
        raw[opt.authorMemberId] ??= 0;
        const v = voteCount[opt.id] ?? 0;
        votesTally[opt.authorMemberId] = (votesTally[opt.authorMemberId] ?? 0) + v;
        raw[opt.authorMemberId] = (raw[opt.authorMemberId] ?? 0) + Math.min(100, (100 * v) / denom);
      }
    }
    const entries = Object.keys(raw).map((memberId) => ({ memberId, raw: raw[memberId]! }));
    const max = counted > 0 ? 100 * counted : 100;
    let best: string | null = null;
    let bestN = 0;
    for (const [mid, n] of Object.entries(votesTally)) {
      if (n > bestN) {
        bestN = n;
        best = mid;
      }
    }
    const awards =
      best && bestN > 0
        ? [{ key: 'caption_champion', title: 'Caption Champion', memberId: best, detail: `${bestN} votes won` }]
        : [];
    return { max, entries, awards };
  },
};

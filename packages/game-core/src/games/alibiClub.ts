/**
 * Alibi Club — the signature deduction game (blueprint §5).
 *
 * One case. Everyone except one outsider secretly receives a location; the
 * outsider receives only "a place people visit" plus four location choices to
 * guess from. Across three clue waves each player gives an indirect clue, the
 * room discusses, then everyone submits a sealed accusation while the outsider
 * guesses the location.
 *
 * Raw: insiders earn 100 for accusing the outsider. The outsider earns 50 if the
 * room does not uniquely convict them by plurality, plus 50 for guessing the
 * location. A tied plurality is no unique conviction. No self-accusation. Max 100.
 *
 * The secret location and outsider identity live only in the private projection
 * for authorised viewers and never appear in the public projection or display
 * token (blueprint §5 acceptance, §8 "one source of truth").
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

const ROLES_MS = 8_000;
const CLUE_MS = 30_000;
const DISCUSSION_MS = 60_000;
const ACCUSE_MS = 20_000;
const REVEAL_MS = 20_000;
const CLUE_WAVES = 3;
const MIN_PLAYERS = 5;
const MAX_CLUE_LEN = 140;

interface ACContent {
  category: string;
  location: string;
  options: string[]; // 4 including the true location
}
interface Clue {
  memberId: string;
  wave: number;
  text: string;
}
export interface AlibiClubState extends BaseGameState {
  gameType: 'alibi_club';
  category: string;
  location: string;
  locationOptions: string[];
  outsiderMemberId: string;
  memberIds: string[];
  currentWave: number;
  clues: Clue[];
  accusations: Record<string, string>;
  outsiderGuess: string | null;
  settled: boolean;
  result: {
    tally: Record<string, number>;
    topTargets: string[];
    uniqueConvict: boolean;
    guessedCorrect: boolean;
  } | null;
}

function phaseFor(
  kind: 'roles' | 'clue' | 'discussion' | 'accuse' | 'reveal',
  wave = 0,
): PhaseSpec {
  const durationMs =
    kind === 'roles'
      ? ROLES_MS
      : kind === 'clue'
        ? CLUE_MS
        : kind === 'discussion'
          ? DISCUSSION_MS
          : kind === 'accuse'
            ? ACCUSE_MS
            : REVEAL_MS;
  return {
    id: kind === 'clue' ? `alibi_club-clue-${wave}` : `alibi_club-${kind}`,
    kind,
    round: kind === 'clue' ? wave : 1,
    durationMs,
    collectsInput: kind === 'clue' || kind === 'accuse',
  };
}

export const alibiClub: GameModule<AlibiClubState> = {
  type: 'alibi_club',
  manifest: {
    type: 'alibi_club',
    title: 'Alibi Club',
    family: 'Deduction',
    minPlayers: MIN_PLAYERS,
    maxPlayers: 10,
    maxRaw: 100,
    summary: 'Everyone describes a secret location; one outsider only knows its category and must blend in.',
    example:
      'Insiders share the location “aquarium”; the outsider knows only “a place people visit”. Give indirect clues, then accuse the outsider — who is secretly guessing the location.',
  },

  selectContent(all, rng) {
    return [rng.pick(all)];
  },

  initialState(ctx: InitContext): AlibiClubState {
    const memberIds = [...ctx.members].sort((a, b) => a.seat - b.seat).map((m) => m.memberId);
    const c = ctx.content[0]!.data as ACContent;
    const outsiderMemberId = ctx.rng.pick(memberIds);
    const locationOptions = ctx.rng.shuffle([...c.options]);
    return {
      gameType: 'alibi_club',
      status: 'active',
      round: 1,
      totalRounds: CLUE_WAVES,
      phase: phaseFor('roles'),
      category: c.category,
      location: c.location,
      locationOptions,
      outsiderMemberId,
      memberIds,
      currentWave: 0,
      clues: [],
      accusations: {},
      outsiderGuess: null,
      settled: false,
      result: null,
    };
  },

  validateAction(state, memberId, action: GameAction): Validation {
    if (action.type === 'submit_clue') {
      if (state.phase.kind !== 'clue')
        return { ok: false, code: 'wrong_phase', message: 'Not a clue wave.' };
      if (state.clues.some((c) => c.memberId === memberId && c.wave === state.currentWave))
        return { ok: false, code: 'duplicate', message: 'Clue already given this wave.' };
      const p = action.payload as { text?: unknown } | undefined;
      if (!p || typeof p.text !== 'string' || p.text.trim().length === 0 || p.text.length > MAX_CLUE_LEN)
        return { ok: false, code: 'invalid_payload', message: `1–${MAX_CLUE_LEN} characters.` };
      return { ok: true };
    }
    if (action.type === 'submit_accusation') {
      if (state.phase.kind !== 'accuse')
        return { ok: false, code: 'wrong_phase', message: 'Not accusing now.' };
      if (state.accusations[memberId] !== undefined)
        return { ok: false, code: 'duplicate', message: 'Accusation already sealed.' };
      const p = action.payload as { targetMemberId?: unknown } | undefined;
      if (!p || typeof p.targetMemberId !== 'string' || !state.memberIds.includes(p.targetMemberId))
        return { ok: false, code: 'invalid_payload', message: 'Choose a player.' };
      if (p.targetMemberId === memberId)
        return { ok: false, code: 'not_permitted', message: 'You cannot accuse yourself.' };
      return { ok: true };
    }
    if (action.type === 'submit_outsider_guess') {
      if (state.phase.kind !== 'accuse')
        return { ok: false, code: 'wrong_phase', message: 'Not the accusation phase.' };
      if (memberId !== state.outsiderMemberId)
        return { ok: false, code: 'not_permitted', message: 'Only the outsider guesses the location.' };
      if (state.outsiderGuess !== null)
        return { ok: false, code: 'duplicate', message: 'Guess already sealed.' };
      const p = action.payload as { location?: unknown } | undefined;
      if (!p || typeof p.location !== 'string' || !state.locationOptions.includes(p.location))
        return { ok: false, code: 'invalid_payload', message: 'Pick a location.' };
      return { ok: true };
    }
    return { ok: false, code: 'not_permitted', message: 'Unknown action.' };
  },

  reduce(state, action: ReduceAction, _ctx: ReduceContext): AlibiClubState {
    const next: AlibiClubState = structuredClone(state);
    if (!isAdvance(action)) {
      if (action.type === 'submit_clue' && next.phase.kind === 'clue') {
        next.clues.push({
          memberId: action.memberId,
          wave: next.currentWave,
          text: (action.payload as { text: string }).text.trim(),
        });
      } else if (action.type === 'submit_accusation' && next.phase.kind === 'accuse') {
        next.accusations[action.memberId] = (action.payload as { targetMemberId: string }).targetMemberId;
      } else if (action.type === 'submit_outsider_guess' && next.phase.kind === 'accuse') {
        next.outsiderGuess = (action.payload as { location: string }).location;
      }
      return next;
    }

    switch (next.phase.kind) {
      case 'roles':
        next.currentWave = 1;
        next.phase = phaseFor('clue', 1);
        break;
      case 'clue':
        if (next.currentWave < CLUE_WAVES) {
          next.currentWave += 1;
          next.phase = phaseFor('clue', next.currentWave);
        } else {
          next.phase = phaseFor('discussion');
        }
        break;
      case 'discussion':
        next.phase = phaseFor('accuse');
        break;
      case 'accuse': {
        const tally: Record<string, number> = {};
        for (const t of Object.values(next.accusations)) tally[t] = (tally[t] ?? 0) + 1;
        const max = Math.max(0, ...Object.values(tally));
        const topTargets = Object.keys(tally).filter((t) => tally[t] === max);
        const uniqueConvict = max > 0 && topTargets.length === 1 && topTargets[0] === next.outsiderMemberId;
        const guessedCorrect = next.outsiderGuess === next.location;
        next.result = { tally, topTargets, uniqueConvict, guessedCorrect };
        next.settled = true;
        next.phase = phaseFor('reveal');
        break;
      }
      case 'reveal':
        next.status = 'complete';
        break;
    }
    return next;
  },

  allInputsIn(state, activeMemberIds): boolean {
    if (state.phase.kind === 'clue') {
      return (
        activeMemberIds.length > 0 &&
        activeMemberIds.every((m) => state.clues.some((c) => c.memberId === m && c.wave === state.currentWave))
      );
    }
    if (state.phase.kind === 'accuse') {
      const allAccused = activeMemberIds.length > 0 && activeMemberIds.every((m) => state.accusations[m] !== undefined);
      const outsiderActive = activeMemberIds.includes(state.outsiderMemberId);
      const guessDone = !outsiderActive || state.outsiderGuess !== null;
      return allAccused && guessDone;
    }
    return false;
  },

  projectPublic(state): GamePublicView {
    const base: GamePublicView = {
      gameType: 'alibi_club',
      round: Math.max(1, state.currentWave),
      totalRounds: CLUE_WAVES,
      phaseKind: state.phase.kind,
      prompt: {
        category: state.category,
        wave: state.currentWave,
        clues: state.clues.map((c) => ({ memberId: c.memberId, wave: c.wave, text: c.text })),
      },
    };
    if (state.phase.kind === 'accuse') {
      base.options = state.memberIds.map((m) => ({ id: m, label: m }));
    }
    if (state.phase.kind === 'reveal' && state.result) {
      base.reveal = {
        outsiderMemberId: state.outsiderMemberId,
        location: state.location,
        locationOptions: state.locationOptions,
        outsiderGuess: state.outsiderGuess,
        guessedCorrect: state.result.guessedCorrect,
        uniqueConvict: state.result.uniqueConvict,
        tally: state.result.tally,
        accusations: state.accusations,
      };
    }
    return base;
  },

  projectPrivate(state, memberId): GamePrivateView {
    const isOutsider = memberId === state.outsiderMemberId;
    const secret = isOutsider
      ? { role: 'outsider', category: state.category, locationOptions: state.locationOptions }
      : { role: 'insider', category: state.category, location: state.location };

    let awaitingInput = false;
    if (state.phase.kind === 'clue') {
      awaitingInput = !state.clues.some((c) => c.memberId === memberId && c.wave === state.currentWave);
    } else if (state.phase.kind === 'accuse') {
      awaitingInput = state.accusations[memberId] === undefined || (isOutsider && state.outsiderGuess === null);
    }
    return { awaitingInput, secret };
  },

  score(state) {
    const active = state.memberIds;
    const raw: Record<string, number> = {};
    for (const m of active) raw[m] = 0;
    const r = state.result;
    if (r) {
      for (const [mid, target] of Object.entries(state.accusations)) {
        if (mid === state.outsiderMemberId) continue;
        if (target === state.outsiderMemberId) raw[mid] = 100;
      }
      let outsiderRaw = 0;
      if (!r.uniqueConvict) outsiderRaw += 50;
      if (r.guessedCorrect) outsiderRaw += 50;
      raw[state.outsiderMemberId] = outsiderRaw;
    }
    const entries = active.map((memberId) => ({ memberId, raw: raw[memberId]! }));
    return { max: 100, entries };
  },
};

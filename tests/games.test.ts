import { describe, it, expect } from 'vitest';
import {
  getGameModule,
  createRng,
  toNightPoints,
  makeGroups,
  bandScore,
  type GameMember,
  type GameModule,
  type BaseGameState,
  type ContentItem,
  type GamePublicView,
  type GamePrivateView,
} from '@roomriot/game-core';
import { getContentFor } from '@roomriot/content';
import type { GameType } from '@roomriot/contracts';

const ALL_GAMES: GameType[] = [
  'majority_report',
  'bluff_bureau',
  'caption_court',
  'link_up',
  'alibi_club',
  'close_call',
];

function members(n: number): GameMember[] {
  return Array.from({ length: n }, (_, i) => ({ memberId: `m${i + 1}`, seat: i + 1, nickname: `P${i + 1}` }));
}

/** A minimal, valid move picker mirroring the server's fictional players. */
function pickMove(type: GameType, pub: GamePublicView, priv: GamePrivateView, selfId: string): { type: string; payload: unknown } | null {
  const opts = pub.options ?? [];
  const secret = priv.secret as { ownOptionId?: string; role?: string; locationOptions?: string[] } | undefined;
  switch (type) {
    case 'majority_report':
      return opts.length ? { type: 'submit_round', payload: { answer: opts[0]!.id, forecast: opts[0]!.id } } : null;
    case 'bluff_bureau':
      if (pub.phaseKind === 'writing') return { type: 'submit_decoy', payload: { text: `decoy-${selfId}` } };
      if (pub.phaseKind === 'voting') {
        const pick = opts.find((o) => o.id !== secret?.ownOptionId);
        return pick ? { type: 'submit_vote', payload: { optionId: pick.id } } : null;
      }
      return null;
    case 'caption_court':
      if (pub.phaseKind === 'writing') return { type: 'submit_caption', payload: { text: `caption-${selfId}` } };
      if (pub.phaseKind === 'voting') {
        const pick = opts.find((o) => o.id !== secret?.ownOptionId);
        return pick ? { type: 'submit_vote', payload: { optionId: pick.id } } : null;
      }
      return null;
    case 'link_up':
      return opts.length ? { type: 'submit_choice', payload: { optionId: opts[0]!.id } } : null;
    case 'alibi_club':
      if (pub.phaseKind === 'clue') return { type: 'submit_clue', payload: { text: `clue-${selfId}` } };
      if (pub.phaseKind === 'accuse') {
        const t = opts.find((o) => o.id !== selfId);
        return t ? { type: 'submit_accusation', payload: { targetMemberId: t.id } } : null;
      }
      return null;
    case 'close_call': {
      const rangeMax = (pub.prompt as { rangeMax?: number }).rangeMax ?? 10;
      return { type: 'submit_estimate', payload: { value: Math.floor(rangeMax / 2) } };
    }
    default:
      return null;
  }
}

/** Drive a game module to completion with no timers, applying valid moves. */
function play(mod: GameModule, mem: GameMember[], content: ContentItem[]): BaseGameState {
  const seed = 'test-seed';
  let state = mod.initialState({
    members: mem,
    rng: createRng(`${seed}:init`),
    content: mod.selectContent(content, createRng(`${seed}:select`), mem.length),
  });
  const activeMemberIds = mem.map((m) => m.memberId);
  let guard = 0;
  while (state.status !== 'complete' && guard++ < 200) {
    if (state.phase.collectsInput) {
      for (const m of mem) {
        const priv = mod.projectPrivate(state, m.memberId);
        if (!priv.awaitingInput) continue;
        const move = pickMove(mod.type, mod.projectPublic(state), priv, m.memberId);
        if (!move) continue;
        const v = mod.validateAction(state, m.memberId, { memberId: m.memberId, type: move.type, payload: move.payload });
        if (v.ok) state = mod.reduce(state, { memberId: m.memberId, type: move.type, payload: move.payload }, { activeMemberIds, rng: createRng('move') });
        // Alibi outsider also guesses the location.
        if (mod.type === 'alibi_club' && state.phase.kind === 'accuse') {
          const s = mod.projectPrivate(state, m.memberId).secret as { role?: string; locationOptions?: string[] } | undefined;
          if (s?.role === 'outsider' && s.locationOptions?.length) {
            state = mod.reduce(state, { memberId: m.memberId, type: 'submit_outsider_guess', payload: { location: s.locationOptions[0]! } }, { activeMemberIds, rng: createRng('g') });
          }
        }
      }
    }
    state = mod.reduce(state, { type: '__advance', reason: 'timeout' }, { activeMemberIds, rng: createRng(`${seed}:${state.phase.id}:advance`) });
  }
  return state;
}

describe('each launch game completes and scores within bounds', () => {
  for (const type of ALL_GAMES) {
    it(`${type}: reaches completion with valid Night Points`, () => {
      const mod = getGameModule(type);
      const n = Math.max(mod.manifest.minPlayers, 6);
      const mem = members(n);
      const state = play(mod, mem, getContentFor(type));
      expect(state.status).toBe('complete');
      const result = mod.score(state);
      expect(result.max).toBeGreaterThan(0);
      for (const e of result.entries) {
        expect(e.raw).toBeGreaterThanOrEqual(0);
        expect(e.raw).toBeLessThanOrEqual(result.max);
      }
      const np = toNightPoints(result.entries, result.max);
      for (const e of np) {
        expect(e.nightPoints).toBeGreaterThanOrEqual(0);
        expect(e.nightPoints).toBeLessThanOrEqual(100);
      }
    });
  }
});

describe('Close Call scoring bands (blueprint §5)', () => {
  it('scores exact, close, approximate, and miss', () => {
    expect(bandScore(100, 100)).toBe(100);
    expect(bandScore(100, 109)).toBe(70); // 9% error
    expect(bandScore(100, 110)).toBe(70); // exactly 10%
    expect(bandScore(100, 111)).toBe(40); // 11%
    expect(bandScore(100, 125)).toBe(40); // exactly 25%
    expect(bandScore(100, 126)).toBe(0); // 26%
  });
});

describe('Link Up pairing (blueprint §5)', () => {
  it('never pairs a player with themselves and includes everyone', () => {
    for (const n of [4, 5, 6, 7, 8, 9, 10]) {
      const ids = Array.from({ length: n }, (_, i) => `m${i + 1}`);
      for (let round = 0; round < 3; round++) {
        const groups = makeGroups(ids, round);
        const seen = new Set<string>();
        for (const g of groups) {
          expect(g).not.toContain('__ghost__');
          expect(new Set(g).size).toBe(g.length); // no self-duplicate in a group
          for (const m of g) seen.add(m);
        }
        expect(seen.size).toBe(n); // everyone is placed
      }
    }
  });

  it('forms a single trio for odd rosters', () => {
    const groups = makeGroups(['a', 'b', 'c', 'd', 'e'], 0);
    const trios = groups.filter((g) => g.length === 3);
    expect(trios.length).toBe(1);
    expect(groups.reduce((s, g) => s + g.length, 0)).toBe(5);
  });
});

describe('Alibi Club secrecy (blueprint §5 acceptance)', () => {
  it('keeps location and outsider identity out of the public projection during play', () => {
    const mod = getGameModule('alibi_club');
    const mem = members(6);
    const state = mod.initialState({
      members: mem,
      rng: createRng('s:init'),
      content: mod.selectContent(getContentFor('alibi_club'), createRng('s:sel'), 6),
    });
    const pub = JSON.stringify(mod.projectPublic(state));
    // The true location string must not appear in any pre-reveal public payload.
    const anyState = state as unknown as { location: string; outsiderMemberId: string };
    expect(pub).not.toContain(anyState.location);
    expect(pub).not.toContain(anyState.outsiderMemberId);
    // Exactly one member sees the "outsider" role privately.
    const outsiders = mem.filter((m) => (mod.projectPrivate(state, m.memberId).secret as { role: string }).role === 'outsider');
    expect(outsiders.length).toBe(1);
  });
});

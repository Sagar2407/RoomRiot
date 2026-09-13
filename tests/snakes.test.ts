/**
 * Snakes & Ladders — the sequential-engine proving ground.
 *
 * Covers board-fixture validity, the deterministic move mechanics (ladders,
 * snakes, Quick reach-or-exceed, Classic exact/overshoot), placement scoring,
 * turn ordering / out-of-turn rejection, and — end-to-end on the real server —
 * a full bot game, duplicate-roll idempotency, and the absence of any leaked
 * randomness in projections.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  snakesAndLadders,
  createSnakesState,
  createRng,
  placementToNightPoints,
  validateBoard,
  SNAKES_QUICK_50,
  SNAKES_CLASSIC_100,
  type SnakesState,
} from '@roomriot/game-core';
import { buildServer, type BuiltServer } from '@roomriot/game-server/src/index.ts';
import { config } from '@roomriot/game-server/src/config.ts';

// A reduce context with a fixed die, so mechanics are deterministic in tests.
function ctx(die: number) {
  return { activeMemberIds: [], rng: createRng('test'), rollDie: () => die };
}
function roll(state: SnakesState, memberId: string, die: number): SnakesState {
  return snakesAndLadders.reduce(state, { memberId, type: 'roll', payload: {} }, ctx(die));
}
function advance(state: SnakesState, die = 1, reason: 'timeout' | 'all_in' = 'all_in'): SnakesState {
  return snakesAndLadders.reduce(state, { type: '__advance', reason }, ctx(die));
}

describe('board fixtures are valid (plan §8.1)', () => {
  it('Quick and Classic boards satisfy every invariant', () => {
    expect(validateBoard(SNAKES_QUICK_50)).toEqual([]);
    expect(validateBoard(SNAKES_CLASSIC_100)).toEqual([]);
  });
});

describe('move mechanics', () => {
  it('climbs a ladder on the landing square', () => {
    const s = roll(createSnakesState(['P1', 'P2'], 'quick'), 'P1', 3); // 0+3=3 → ladder 3→14
    expect(s.positions.P1).toBe(14);
    expect(s.lastRoll).toMatchObject({ jumpedFrom: 3, jumpedTo: 14 });
  });

  it('slides down a snake on the landing square', () => {
    const start = createSnakesState(['P1', 'P2'], 'quick');
    start.positions.P1 = 20;
    const s = roll(start, 'P1', 3); // 20+3=23 → snake 23→7
    expect(s.positions.P1).toBe(7);
    expect(s.lastRoll).toMatchObject({ jumpedFrom: 23, jumpedTo: 7 });
  });

  it('Quick finishes on reach-or-exceed', () => {
    const start = createSnakesState(['P1', 'P2'], 'quick');
    start.positions.P1 = 48;
    const s = roll(start, 'P1', 4); // 52 ≥ 50 → clamps to 50, finished
    expect(s.positions.P1).toBe(50);
    expect(s.finishedOrder).toContain('P1');
    expect(advance(s).status).toBe('complete'); // first finisher ends the game
  });

  it('Classic needs an exact finish; an overshoot stays put', () => {
    const base = createSnakesState(['P1', 'P2'], 'classic');
    base.positions.P1 = 98;
    expect(roll(base, 'P1', 5).positions.P1).toBe(98); // 103 overshoots → stays
    const exact = roll(base, 'P1', 2); // 100 exact → finish
    expect(exact.positions.P1).toBe(100);
    expect(exact.finishedOrder).toContain('P1');
  });
});

describe('turns & validation', () => {
  it('only the active seat may roll, and only once per turn', () => {
    const s = createSnakesState(['P1', 'P2'], 'quick');
    expect(snakesAndLadders.validateAction(s, 'P2', { memberId: 'P2', type: 'roll', payload: {} }).ok).toBe(false);
    expect(snakesAndLadders.validateAction(s, 'P1', { memberId: 'P1', type: 'roll', payload: {} }).ok).toBe(true);
    const rolled = roll(s, 'P1', 2);
    expect(snakesAndLadders.validateAction(rolled, 'P1', { memberId: 'P1', type: 'roll', payload: {} }).ok).toBe(false);
  });

  it('a timed-out seat is auto-rolled by the server and the turn passes on', () => {
    const s = createSnakesState(['P1', 'P2'], 'quick'); // P1 to act, has not rolled
    const advanced = advance(s, 4, 'timeout'); // server rolls 4 for P1, then advances
    expect(advanced.positions.P1).toBeGreaterThan(0);
    expect(advanced.lastRoll).toMatchObject({ memberId: 'P1', auto: true });
    expect(advanced.seatOrder[advanced.activeIndex]).toBe('P2'); // now P2's turn
  });
});

describe('placement scoring (np-classics-v2)', () => {
  it('converts ranks to the plan §9 point table', () => {
    const np = placementToNightPoints([
      { memberId: 'A', rank: 1 },
      { memberId: 'B', rank: 2 },
      { memberId: 'C', rank: 3 },
      { memberId: 'D', rank: 4 },
    ]);
    const by = Object.fromEntries(np.map((e) => [e.memberId, e.nightPoints]));
    expect(by).toEqual({ A: 100, B: 67, C: 33, D: 0 });
  });

  it('a two-way tie splits the middle (50 each)', () => {
    const np = placementToNightPoints([
      { memberId: 'A', rank: 1 },
      { memberId: 'B', rank: 2 },
      { memberId: 'C', rank: 2 },
      { memberId: 'D', rank: 4 },
    ]);
    const by = Object.fromEntries(np.map((e) => [e.memberId, e.nightPoints]));
    expect(by.B).toBe(50);
    expect(by.C).toBe(50);
  });

  it('ranks the winner first and the rest by board position', () => {
    const s = createSnakesState(['P1', 'P2', 'P3'], 'quick');
    s.finishedOrder = ['P2'];
    s.positions = { P1: 30, P2: 50, P3: 10 };
    const pr = snakesAndLadders.placement(s);
    const rankOf = Object.fromEntries(pr.standings.map((x) => [x.memberId, x.rank]));
    expect(rankOf.P2).toBe(1); // finisher
    expect(rankOf.P1).toBe(2); // higher position
    expect(rankOf.P3).toBe(3);
  });
});

let built: BuiltServer | null = null;
afterEach(() => {
  vi.useRealTimers();
  if (built) {
    built.db.close();
    built = null;
  }
});

describe('server integration (behind the enabled-games flag)', () => {
  it('runs a full bot game to a champion, is idempotent on a retried roll, and leaks no randomness', async () => {
    const prevEnabled = config.enabledGames;
    const prevBilling = config.billingEnabled;
    config.enabledGames = [...prevEnabled, 'snakes_and_ladders'];
    config.billingEnabled = false;
    try {
      vi.useFakeTimers();
      built = await buildServer(':memory:');
      const { rm, db } = built;
      const { credentials: host } = rm.createRoom('Host', { playlist: ['snakes_and_ladders'] }, 'bot:host');
      rm.addBots(host.roomId, 2); // three seats
      rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });

      // A retried roll (same actionId) must not roll twice.
      const proj0 = rm.resync(host.memberId, host.roomId)!;
      expect(proj0.game!.gameType).toBe('snakes_and_ladders');
      const active = (proj0.game!.prompt as { activeMemberId: string }).activeMemberId;
      const r1 = rm.handleAction(active, host.roomId, { actionId: 'DUP', type: 'roll', gameId: proj0.gameId!, phaseId: proj0.phaseId! });
      const afterFirst = (rm.resync(host.memberId, host.roomId)!.game!.prompt as { positions: Record<string, number> }).positions[active];
      const r2 = rm.handleAction(active, host.roomId, { actionId: 'DUP', type: 'roll', gameId: proj0.gameId!, phaseId: proj0.phaseId! });
      const afterSecond = (rm.resync(host.memberId, host.roomId)!.game!.prompt as { positions: Record<string, number> }).positions[active];
      expect(r1.accepted).toBe(true);
      expect(r2.accepted).toBe(true);
      expect(afterSecond).toBe(afterFirst); // no double-roll
      expect((db.prepare('SELECT count(*) AS c FROM actions WHERE action_id = ?').get('DUP') as { c: number }).c).toBe(1);

      // No seed / entropy ever appears in a projection.
      expect(JSON.stringify(proj0.game)).not.toContain('seed');
      expect(proj0.self?.private?.secret).toBeUndefined();

      // Let the bots play the rest of the night out.
      let iter = 0;
      while (rm.getRoom(host.roomId)!.status !== 'complete' && iter++ < 5000) {
        vi.advanceTimersByTime(3000);
      }
      expect(rm.getRoom(host.roomId)!.status).toBe('complete');

      const ledger = (db.prepare('SELECT count(*) AS c FROM score_ledger WHERE room_id = ? AND game_type = ?').get(host.roomId, 'snakes_and_ladders') as { c: number }).c;
      expect(ledger).toBe(3); // one placement result per seat
      const final = rm.resync(host.memberId, host.roomId)!;
      expect(final.scoreboard).toHaveLength(3);
      expect(final.awards?.some((a) => a.key === 'night_champion')).toBe(true);
    } finally {
      config.enabledGames = prevEnabled;
      config.billingEnabled = prevBilling;
    }
  });
});

/**
 * Ludo — board geometry and movement.
 *
 * Covers the shared-track / home-lane mapping, yard entry on a 6, exact home
 * (overshoot rejected), captures vs. safe cells, the three-consecutive-sixes rule,
 * bonus rolls, progress ranking, and an end-to-end bot match.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ludo, createLudoState, ludoStartOffset, ludoTrackCell, ludoColorsForSeats, createRng, type LudoState } from '@roomriot/game-core';
import { buildServer, type BuiltServer } from '@roomriot/game-server/src/index.ts';
import { config } from '@roomriot/game-server/src/config.ts';

const ctx = (die: number) => ({ activeMemberIds: [], rng: createRng('t'), rollDie: () => die });

function roll(s: LudoState, die: number): LudoState {
  const active = s.seatOrder[s.activeIndex]!;
  const v = ludo.validateAction(s, active, { memberId: active, type: 'roll', payload: {} });
  if (!v.ok) throw new Error(`illegal roll: ${v.message}`);
  let next = ludo.reduce(s, { memberId: active, type: 'roll', payload: {} }, ctx(die));
  return ludo.reduce(next, { type: '__advance', reason: 'all_in' }, ctx(die));
}
function move(s: LudoState, tokenIndex: number): LudoState {
  const active = s.seatOrder[s.activeIndex]!;
  const v = ludo.validateAction(s, active, { memberId: active, type: 'move', payload: { tokenIndex } });
  if (!v.ok) throw new Error(`illegal move: ${v.message}`);
  let next = ludo.reduce(s, { memberId: active, type: 'move', payload: { tokenIndex } }, ctx(1));
  return ludo.reduce(next, { type: '__advance', reason: 'all_in' }, ctx(1));
}

describe('board geometry (plan §7.2)', () => {
  it('maps personal progress to the shared track and home lane', () => {
    expect([ludoStartOffset(0), ludoStartOffset(1), ludoStartOffset(2), ludoStartOffset(3)]).toEqual([0, 13, 26, 39]);
    expect(ludoTrackCell(0, 0)).toBe(0);
    expect(ludoTrackCell(1, 0)).toBe(13);
    expect(ludoTrackCell(1, 50)).toBe((13 + 50) % 52);
    expect(ludoTrackCell(0, 51)).toBeNull(); // home lane
    expect(ludoTrackCell(0, 56)).toBeNull(); // home
    expect(ludoColorsForSeats(2)).toEqual([0, 2]);
    expect(ludoColorsForSeats(4)).toEqual([0, 1, 2, 3]);
  });
});

describe('movement rules', () => {
  it('only lets a 6 bring a token out of the yard', () => {
    const s = createLudoState(['P1', 'P2'], 'quick');
    expect(s.positions.P1).toEqual([0, -1]); // one out, one in the yard
    const rolled3 = roll(s, 3);
    expect(rolled3.legalTokens).toEqual([0]); // yard token can't move on a 3
    const rolled6 = roll(s, 6);
    expect(rolled6.legalTokens).toEqual([0, 1]); // the 6 lets the yard token enter
    const moved = move(rolled6, 1);
    expect(moved.positions.P1[1]).toBe(0); // entered on the start square
    expect(moved.stage).toBe('roll'); // and earned a bonus roll
    expect(moved.seatOrder[moved.activeIndex]).toBe('P1');
  });

  it('requires an exact roll to reach home; overshoot cannot move', () => {
    const s = createLudoState(['P1', 'P2'], 'quick');
    s.positions.P1 = [54, -1];
    const over = roll(s, 3); // 54+3 = 57 > 56 → no legal move → passes
    expect(over.positions.P1[0]).toBe(54);
    expect(over.seatOrder[over.activeIndex]).toBe('P2');
    const s2 = createLudoState(['P1', 'P2'], 'quick');
    s2.positions.P1 = [54, -1];
    const home = move(roll(s2, 2), 0); // 54+2 = 56 exact
    expect(home.positions.P1[0]).toBe(56);
  });

  it('captures an opponent on an unsafe cell but not a safe one', () => {
    const s = createLudoState(['P1', 'P2'], 'quick'); // P1 color 0, P2 color 2
    s.positions.P1 = [2, -1];
    s.positions.P2 = [30, -1]; // (26+30)%52 = 4 → shares cell 4 (unsafe) after P1 moves +2
    const cap = move(roll(s, 2), 0);
    expect(cap.positions.P1[0]).toBe(4);
    expect(cap.positions.P2[0]).toBe(-1); // captured back to the yard
    expect(cap.lastEvent?.captured).toContain('P2:0');

    const s2 = createLudoState(['P1', 'P2'], 'quick');
    s2.positions.P1 = [6, -1];
    s2.positions.P2 = [34, -1]; // (26+34)%52 = 8 → safe cell
    const safe = move(roll(s2, 2), 0);
    expect(safe.positions.P1[0]).toBe(8);
    expect(safe.positions.P2[0]).toBe(34); // safe cell → no capture
  });

  it('voids the third consecutive six and passes the turn', () => {
    const s = createLudoState(['P1', 'P2'], 'quick');
    s.consecutiveSixes = 2;
    const third = roll(s, 6);
    expect(third.positions.P1).toEqual([0, -1]); // no move on the void third six
    expect(third.consecutiveSixes).toBe(0);
    expect(third.seatOrder[third.activeIndex]).toBe('P2');
  });
});

describe('progress ranking (plan §7.3)', () => {
  it('ranks by tokens finished, then total progress', () => {
    const s = createLudoState(['P1', 'P2', 'P3'], 'quick');
    s.positions.P1 = [56, 56];
    s.positions.P2 = [30, 10];
    s.positions.P3 = [-1, -1];
    const rank = Object.fromEntries(ludo.placement(s).standings.map((x) => [x.memberId, x.rank]));
    expect(rank).toEqual({ P1: 1, P2: 2, P3: 3 });
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
  it('runs a full bot match to a settled result', async () => {
    const prevEnabled = config.enabledGames;
    const prevBilling = config.billingEnabled;
    config.enabledGames = [...prevEnabled, 'ludo'];
    config.billingEnabled = false;
    try {
      vi.useFakeTimers();
      built = await buildServer(':memory:');
      const { rm, db } = built;
      const { credentials: host } = rm.createRoom('Host', { playlist: ['ludo'] }, 'bot:host');
      rm.addBots(host.roomId, 3); // four seats (Ludo's max)
      rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });
      expect(rm.resync(host.memberId, host.roomId)!.game!.gameType).toBe('ludo');

      let iter = 0;
      while (rm.getRoom(host.roomId)!.status !== 'complete' && iter++ < 100000) {
        vi.advanceTimersByTime(8000);
      }
      expect(rm.getRoom(host.roomId)!.status).toBe('complete');

      const ledger = (db.prepare('SELECT count(*) AS c FROM score_ledger WHERE room_id = ? AND game_type = ?').get(host.roomId, 'ludo') as { c: number }).c;
      expect(ledger).toBe(4);
      const final = rm.resync(host.memberId, host.roomId)!;
      expect(final.scoreboard).toHaveLength(4);
      expect(final.awards?.some((a) => a.key === 'night_champion')).toBe(true);
    } finally {
      config.enabledGames = prevEnabled;
      config.billingEnabled = prevBilling;
    }
  });
});

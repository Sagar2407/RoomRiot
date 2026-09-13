/**
 * Teen Patti: Capped Party.
 *
 * Covers the 3-card evaluator (classification of all 22,100 hands + A23_HIGH
 * ordering), chip conservation, blind-hand privacy, the seen-can't-show-a-blind
 * convention, timeout = pack, and an end-to-end bot match.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { teenPatti, evaluate3, compare3, FULL_DECK, createRng, type TeenPattiState } from '@roomriot/game-core';
import { buildServer, type BuiltServer } from '@roomriot/game-server/src/index.ts';
import { config } from '@roomriot/game-server/src/config.ts';

const identity = <T,>(a: readonly T[]): T[] => [...a];
const mem = (ids: string[]) => ids.map((id, i) => ({ memberId: id, seat: i + 1, nickname: id }));
const rctx = () => ({ activeMemberIds: [], rng: createRng('t'), shuffle: identity });

function act(s: TeenPattiState, memberId: string, type: string, payload: unknown = {}): TeenPattiState {
  const v = teenPatti.validateAction(s, memberId, { memberId, type, payload });
  if (!v.ok) throw new Error(`illegal ${type} by ${memberId}: ${v.message}`);
  let next = teenPatti.reduce(s, { memberId, type, payload }, rctx());
  if (teenPatti.allInputsIn(next, [])) next = teenPatti.reduce(next, { type: '__advance', reason: 'all_in' }, rctx());
  return next;
}
const init = (ids: string[]) => teenPatti.initialState({ members: mem(ids), rng: createRng('t'), content: [], shuffle: identity });

describe('three-card evaluator (plan §5.2)', () => {
  it('classifies all 22,100 hands into the known distribution', () => {
    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (let i = 0; i < 52; i++)
      for (let j = i + 1; j < 52; j++)
        for (let k = j + 1; k < 52; k++) counts[evaluate3([FULL_DECK[i]!, FULL_DECK[j]!, FULL_DECK[k]!])[0]!]++;
    expect(counts).toEqual({ 6: 52, 5: 48, 4: 720, 3: 1096, 2: 3744, 1: 16440 });
  });

  it('applies A23_HIGH ace ordering', () => {
    expect(compare3(['AS', '2S', '3S'], ['AH', 'KH', 'QH'])).toBeGreaterThan(0); // A-2-3 is the top pure sequence
    expect(compare3(['AS', '2H', '3D'], ['AH', 'KD', 'QC'])).toBeGreaterThan(0); // and the top plain sequence
    expect(evaluate3(['KS', 'AH', '2D'])[0]).toBe(1); // K-A-2 is not a sequence → high card
    expect(compare3(['AS', 'AH', 'AD'], ['KS', 'QS', 'JS'])).toBeGreaterThan(0); // trail beats pure sequence
    expect(compare3(['5S', '5H', '5D'], ['2S', '2H', '2D'])).toBeGreaterThan(0); // higher trail wins
  });
});

describe('betting, privacy, and settlement', () => {
  it('keeps a blind seat’s cards out of every projection until it sees', () => {
    const s = init(['P1', 'P2', 'P3']);
    // Public projection carries no hand at all.
    const pub = JSON.stringify(teenPatti.projectPublic(s));
    for (const c of Object.values(s.hands).flat()) expect(pub).not.toContain(`"${c}"`);
    // A blind seat doesn't even receive its own cards.
    expect(teenPatti.projectPrivate(s, 'P2').secret).toMatchObject({ myHand: null });
    // …until it sees (it is P2's turn to open).
    const seen = teenPatti.reduce(s, { memberId: 'P2', type: 'see', payload: {} }, rctx());
    expect((teenPatti.projectPrivate(seen, 'P2').secret as { myHand: string[] }).myHand).toHaveLength(3);
  });

  it('conserves chips when everyone folds to one winner (no reveal)', () => {
    let s = init(['P1', 'P2', 'P3']); // dealer P1 → order P2, P3, P1
    s = act(s, 'P2', 'fold');
    s = act(s, 'P3', 'fold');
    expect(s.stage).toBe('hand_over');
    expect(s.reveal?.kind).toBe('fold');
    expect(s.reveal?.winners).toEqual(['P1']);
    expect(Object.keys(s.reveal?.hands ?? {})).toHaveLength(0); // lone winner never revealed
    expect(s.sessionNet).toEqual({ P1: 2, P2: -1, P3: -1 });
    expect(Object.values(s.sessionNet).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('lets a blind seat ask for a show but forbids a seen seat asking a blind one', () => {
    let s = init(['P1', 'P2', 'P3']);
    s = act(s, 'P2', 'fold'); // now P1 vs P3, P3 to act
    expect((teenPatti.projectPrivate(s, 'P3').secret as { canShow: boolean }).canShow).toBe(true); // both blind
    const seen = teenPatti.reduce(s, { memberId: 'P3', type: 'see', payload: {} }, rctx());
    expect((teenPatti.projectPrivate(seen, 'P3').secret as { canShow: boolean }).canShow).toBe(false); // seen vs blind
  });

  it('packs a timed-out seat rather than wagering for it', () => {
    const s = init(['P1', 'P2', 'P3']); // P2 to act
    const timed = teenPatti.reduce(s, { type: '__advance', reason: 'timeout' }, rctx());
    expect(timed.folded.P2).toBe(true);
    expect(timed.lastAction).toMatchObject({ memberId: 'P2', type: 'fold' });
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
  it('runs a full bot match, settles once, and never puts a hand in the opening public view', async () => {
    const prevEnabled = config.enabledGames;
    const prevBilling = config.billingEnabled;
    config.enabledGames = [...prevEnabled, 'teen_patti'];
    config.billingEnabled = false;
    try {
      vi.useFakeTimers();
      built = await buildServer(':memory:');
      const { rm, db } = built;
      const { credentials: host } = rm.createRoom('Host', { playlist: ['teen_patti'] }, 'bot:host');
      rm.addBots(host.roomId, 3); // four seats
      rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });

      // At the opening (everyone blind, nothing revealed), no card token is public.
      const proj0 = rm.resync(host.memberId, host.roomId)!;
      expect(proj0.game!.gameType).toBe('teen_patti');
      expect(/"[AKQJT2-9][SHDC]"/.test(JSON.stringify(proj0.game))).toBe(false);

      let iter = 0;
      while (rm.getRoom(host.roomId)!.status !== 'complete' && iter++ < 30000) {
        vi.advanceTimersByTime(5000);
      }
      expect(rm.getRoom(host.roomId)!.status).toBe('complete');

      const ledger = (db.prepare('SELECT count(*) AS c FROM score_ledger WHERE room_id = ? AND game_type = ?').get(host.roomId, 'teen_patti') as { c: number }).c;
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

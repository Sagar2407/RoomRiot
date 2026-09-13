/**
 * Judgement — exact-trick bidding (Kachuful / Oh Hell).
 *
 * Covers the card primitives (trick winner, follow-suit), the dealer hook, a
 * full scored deal, hand privacy, and an end-to-end bot match that settles once
 * and never leaks a hand into a public projection.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { judgement, createRng, trickWinner, legalPlays, type JudgementState } from '@roomriot/game-core';
import { buildServer, type BuiltServer } from '@roomriot/game-server/src/index.ts';
import { config } from '@roomriot/game-server/src/config.ts';

const identity = <T,>(a: readonly T[]): T[] => [...a];
const mem = (ids: string[]) => ids.map((id, i) => ({ memberId: id, seat: i + 1, nickname: id }));
const rctx = () => ({ activeMemberIds: [], rng: createRng('t'), shuffle: identity });

// Apply an action the way the engine does: reduce, then advance once if the
// active seat's decision is in.
function act(s: JudgementState, memberId: string, type: string, payload: unknown): JudgementState {
  const v = judgement.validateAction(s, memberId, { memberId, type, payload });
  if (!v.ok) throw new Error(`illegal ${type} by ${memberId}: ${v.message}`);
  let next = judgement.reduce(s, { memberId, type, payload }, rctx());
  if (judgement.allInputsIn(next, [])) next = judgement.reduce(next, { type: '__advance', reason: 'all_in' }, rctx());
  return next;
}

describe('card primitives', () => {
  it('picks the trick winner: highest trump, else highest of the led suit', () => {
    expect(trickWinner([{ memberId: 'a', card: 'KS' }, { memberId: 'b', card: 'AS' }, { memberId: 'c', card: 'QS' }], 'S').memberId).toBe('b');
    expect(trickWinner([{ memberId: 'a', card: '9H' }, { memberId: 'b', card: 'KH' }, { memberId: 'c', card: '2D' }], 'S').memberId).toBe('b');
    expect(trickWinner([{ memberId: 'a', card: 'AH' }, { memberId: 'b', card: '2S' }], 'S').memberId).toBe('b'); // a low trump beats the ace of a plain suit
  });

  it('enforces follow-suit', () => {
    expect(legalPlays(['AH', '2S', 'KD'], 'H')).toEqual(['AH']);
    expect(legalPlays(['2S', 'KD'], 'H')).toEqual(['2S', 'KD']); // void → anything
    expect(legalPlays(['AH', '2S'], null)).toEqual(['AH', '2S']); // leading → anything
  });
});

describe('a full deal', () => {
  it('applies the dealer hook and scores exact bids (10 + bid) vs misses (0)', () => {
    let s = judgement.initialState({ members: mem(['P1', 'P2', 'P3']), rng: createRng('t'), content: [], shuffle: identity });
    expect(s.handSize).toBe(1);
    expect(s.trump).toBe('S');

    // Bid order is dealer's-left-first: [P2, P3, P1] (dealer P1 last).
    s = act(s, 'P2', 'bid', { bid: 0 });
    s = act(s, 'P3', 'bid', { bid: 0 });
    // Dealer hook: P1 cannot bid 1 (that would make bids sum to the 1 available trick).
    expect(judgement.validateAction(s, 'P1', { memberId: 'P1', type: 'bid', payload: { bid: 1 } }).ok).toBe(false);
    s = act(s, 'P1', 'bid', { bid: 0 });
    expect(s.stage).toBe('playing');

    // Play the single-card trick in order P2, P3, P1. With the identity shuffle,
    // P1 holds AS (top trump) and takes the trick.
    for (const id of ['P2', 'P3', 'P1']) {
      s = act(s, id, 'play_card', { card: s.hands[id]![0]! });
    }
    // Deal 0 settled, deal 1 dealt. P1 bid 0 but won 1 (miss → 0); P2/P3 bid 0 won 0 (exact → 10).
    expect(s.dealIndex).toBe(1);
    expect(s.scores).toEqual({ P1: 0, P2: 10, P3: 10 });
  });
});

describe('privacy', () => {
  it('keeps hands out of the public projection and out of opponents’ private views', () => {
    const s = judgement.initialState({ members: mem(['P1', 'P2', 'P3']), rng: createRng('t'), content: [], shuffle: identity });
    const pub = JSON.stringify(judgement.projectPublic(s));
    for (const card of Object.values(s.hands).flat()) expect(pub).not.toContain(`"${card}"`);

    const privP2 = JSON.stringify(judgement.projectPrivate(s, 'P2'));
    for (const card of s.hands.P2!) expect(privP2).toContain(`"${card}"`); // own hand present
    for (const card of [...s.hands.P1!, ...s.hands.P3!]) expect(privP2).not.toContain(`"${card}"`); // opponents' hidden
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
  it('runs a full bot match, settles once, and leaks no hand into a public projection', async () => {
    const prevEnabled = config.enabledGames;
    const prevBilling = config.billingEnabled;
    config.enabledGames = [...prevEnabled, 'judgement'];
    config.billingEnabled = false;
    try {
      vi.useFakeTimers();
      built = await buildServer(':memory:');
      const { rm, db } = built;
      const { credentials: host } = rm.createRoom('Host', { playlist: ['judgement'] }, 'bot:host');
      rm.addBots(host.roomId, 3); // four seats (min 3)
      rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });

      // The host's own hand must never appear in the public projection.
      const proj0 = rm.resync(host.memberId, host.roomId)!;
      expect(proj0.game!.gameType).toBe('judgement');
      const myHand = (proj0.self!.private!.secret as { hand: string[] }).hand;
      const pubBlob = JSON.stringify(proj0.game);
      for (const card of myHand) expect(pubBlob).not.toContain(`"${card}"`);

      let iter = 0;
      while (rm.getRoom(host.roomId)!.status !== 'complete' && iter++ < 20000) {
        vi.advanceTimersByTime(5000);
      }
      expect(rm.getRoom(host.roomId)!.status).toBe('complete');

      const ledger = (db.prepare('SELECT count(*) AS c FROM score_ledger WHERE room_id = ? AND game_type = ?').get(host.roomId, 'judgement') as { c: number }).c;
      expect(ledger).toBe(4); // one placement result per seat, settled once
      const final = rm.resync(host.memberId, host.roomId)!;
      expect(final.scoreboard).toHaveLength(4);
      expect(final.awards?.some((a) => a.key === 'night_champion')).toBe(true);
    } finally {
      config.enabledGames = prevEnabled;
      config.billingEnabled = prevBilling;
    }
  });
});

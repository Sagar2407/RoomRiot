import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildServer, type BuiltServer } from '@roomriot/game-server/src/index.ts';
import { RoomManager } from '@roomriot/game-server/src/roomManager.ts';

let built: BuiltServer | null = null;
afterEach(async () => {
  vi.useRealTimers();
  if (built) {
    built.db.close();
    built = null;
  }
});

describe('idempotency & authorization (blueprint §10, §8)', () => {
  it('returns the recorded result for a retried actionId and never re-applies it', async () => {
    built = await buildServer(':memory:');
    const { rm, db } = built;
    const { credentials: host } = rm.createRoom('Host', {}, 'guest:h');

    const a1 = rm.handleAction(host.memberId, host.roomId, { actionId: 'dup-1', type: 'next' });
    const a2 = rm.handleAction(host.memberId, host.roomId, { actionId: 'dup-1', type: 'next' });
    expect(a1.accepted).toBe(true);
    expect(a2.accepted).toBe(true);
    const row = db.prepare('SELECT count(*) AS c FROM actions WHERE action_id = ?').get('dup-1') as { c: number };
    expect(row.c).toBe(1);
  });

  it('records and replays a rejection idempotently', async () => {
    built = await buildServer(':memory:');
    const { rm } = built;
    const { credentials: host } = rm.createRoom('Host', {}, 'guest:h');
    const jr = rm.joinRoom(host.code, 'P2', 'guest:2');
    if (!('credentials' in jr)) throw new Error('join failed');
    const p2 = jr.credentials;

    const r1 = rm.handleAction(p2.memberId, host.roomId, { actionId: 'dup-2', type: 'start_night' });
    const r2 = rm.handleAction(p2.memberId, host.roomId, { actionId: 'dup-2', type: 'start_night' });
    expect(r1.accepted).toBe(false);
    expect(r1.reason).toBe('not_permitted');
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toBe('not_permitted');
  });

  it('never leaks the private self overlay to the display projection', async () => {
    built = await buildServer(':memory:');
    const { rm } = built;
    const { credentials: host } = rm.createRoom('Host', {}, 'guest:h');
    const display = rm.resync(null, host.roomId)!;
    const mine = rm.resync(host.memberId, host.roomId)!;
    expect(display.self).toBeUndefined();
    expect(mine.self).toBeDefined();
    expect(mine.self!.memberId).toBe(host.memberId);
  });
});

describe('a full six-game night runs unattended and settles once (blueprint §5, §10)', () => {
  it('completes with a champion and a stable, restart-safe score ledger', async () => {
    vi.useFakeTimers();
    built = await buildServer(':memory:');
    const { rm, db, io } = built;

    // A bot host so the whole table plays unattended (a socketless human host is
    // correctly treated as disconnected and would not submit).
    const { credentials: host } = rm.createRoom(
      'Bot Host',
      { playlist: ['majority_report', 'bluff_bureau', 'caption_court', 'link_up', 'alibi_club', 'close_call'] },
      'bot:host',
    );
    rm.addBots(host.roomId, 5); // six seats total

    rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });

    let iter = 0;
    while (rm.getRoom(host.roomId)!.status !== 'complete' && iter++ < 600) {
      if (rm.getRoom(host.roomId)!.status === 'intermission') {
        rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'next' });
      }
      vi.advanceTimersByTime(4000);
    }

    const room = rm.getRoom(host.roomId)!;
    expect(room.status).toBe('complete');

    const finalProjection = rm.resync(host.memberId, host.roomId)!;
    expect(finalProjection.scoreboard.length).toBe(6);
    expect(finalProjection.scoreboard.every((l) => l.total >= 0)).toBe(true);
    expect(finalProjection.awards?.some((a) => a.key === 'night_champion')).toBe(true);
    // Every game in the playlist produced ledger entries.
    const ledgerBefore = (db.prepare('SELECT count(*) AS c FROM score_ledger WHERE room_id = ?').get(host.roomId) as { c: number }).c;
    expect(ledgerBefore).toBe(6 * 6); // 6 games × 6 members

    // Simulate a process restart: a fresh RoomManager rehydrates from the same DB.
    const rm2 = new RoomManager(db, io);
    const ledgerAfter = (db.prepare('SELECT count(*) AS c FROM score_ledger WHERE room_id = ?').get(host.roomId) as { c: number }).c;
    expect(ledgerAfter).toBe(ledgerBefore); // settlement is not repeated
    const reboard = rm2.resync(host.memberId, host.roomId)!;
    expect(reboard.scoreboard.reduce((s, l) => s + l.total, 0)).toBe(
      finalProjection.scoreboard.reduce((s, l) => s + l.total, 0),
    );
  });
});

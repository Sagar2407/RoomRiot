/**
 * Rematch — "play again with this crew" (plan §3, §6).
 *
 * A rematch keeps the room and roster but starts a fresh night: the scoreboard is
 * scoped per night (so a new night doesn't sum onto the old one), while the ledger
 * keeps every night for history.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildServer, type BuiltServer } from '@roomriot/game-server/src/index.ts';
import { config } from '@roomriot/game-server/src/config.ts';
import type { RoomManager } from '@roomriot/game-server/src/roomManager.ts';

let built: BuiltServer | null = null;
afterEach(() => {
  vi.useRealTimers();
  if (built) {
    built.db.close();
    built = null;
  }
});

function playNight(rm: RoomManager, roomId: string, memberId: string) {
  let iter = 0;
  while (rm.getRoom(roomId)!.status !== 'complete' && iter++ < 5000) {
    if (rm.getRoom(roomId)!.status === 'intermission') rm.handleAction(memberId, roomId, { actionId: randomUUID(), type: 'next' });
    vi.advanceTimersByTime(3000);
  }
}

describe('rematch', () => {
  it('runs a fresh night in the same room and scopes the scoreboard per night', async () => {
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

      // Night 1.
      rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });
      playNight(rm, host.roomId, host.memberId);
      expect(rm.getRoom(host.roomId)!.status).toBe('complete');
      expect((db.prepare('SELECT count(*) AS c FROM score_ledger WHERE room_id = ? AND night_seq = 0').get(host.roomId) as { c: number }).c).toBe(3);

      // Rematch → back to the lobby with a fresh, empty scoreboard.
      rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'rematch' });
      const room = rm.getRoom(host.roomId)!;
      expect(room.status).toBe('lobby');
      expect(room.nightSeq).toBe(1);
      expect(rm.resync(host.memberId, host.roomId)!.scoreboard.every((l) => l.total === 0)).toBe(true);

      // Night 2.
      rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });
      playNight(rm, host.roomId, host.memberId);
      expect(rm.getRoom(host.roomId)!.status).toBe('complete');
      expect((db.prepare('SELECT count(*) AS c FROM score_ledger WHERE room_id = ? AND night_seq = 1').get(host.roomId) as { c: number }).c).toBe(3);

      // History preserved: both nights in the ledger; the live board counts only night 2.
      expect((db.prepare('SELECT count(*) AS c FROM score_ledger WHERE room_id = ?').get(host.roomId) as { c: number }).c).toBe(6);
      expect(rm.resync(host.memberId, host.roomId)!.scoreboard).toHaveLength(3);
    } finally {
      config.enabledGames = prevEnabled;
      config.billingEnabled = prevBilling;
    }
  });
});

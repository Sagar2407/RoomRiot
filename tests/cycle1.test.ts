/**
 * Cycle 1 — reliability & security hardening.
 *
 * Covers the fixes made after the launch review: mandatory phase targeting on
 * game moves, room capacity (max) and per-game minimum enforcement, idempotent
 * night completion, socket-side report rate limiting, and the token-guarded
 * /metrics endpoint.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildServer, type BuiltServer } from '@roomriot/game-server/src/index.ts';
import { processBillingEvent } from '@roomriot/game-server/src/billing.ts';
import { config } from '@roomriot/game-server/src/config.ts';

let built: BuiltServer | null = null;
const savedMetricsToken = config.metricsToken;
const savedIsProduction = config.isProduction;

afterEach(() => {
  vi.useRealTimers();
  config.metricsToken = savedMetricsToken;
  config.isProduction = savedIsProduction;
  if (built) {
    built.db.close();
    built = null;
  }
});

/** A Party Pass so a requested playlist is honored (a free host is capped to the
 * rotating trio, blueprint §14). */
function grantPass(b: BuiltServer, guestId: string): void {
  processBillingEvent(b.db, b.analytics, {
    id: `evt_${guestId}`,
    type: 'payment.succeeded',
    data: { guestId, product: 'party_pass', platform: 'web' },
  });
}

describe('game moves must target the current game + phase (blueprint §8, §10)', () => {
  it('rejects a move with a missing or stale phaseId, accepts the current one', async () => {
    vi.useFakeTimers();
    built = await buildServer(':memory:');
    const { rm } = built;
    grantPass(built, 'bot:host');
    const { credentials: host } = rm.createRoom('Host', { playlist: ['majority_report'] }, 'bot:host');
    rm.addBots(host.roomId, 3); // 4 seats — Majority Report's minimum

    rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });
    const proj = rm.resync(host.memberId, host.roomId)!;
    expect(proj.status).toBe('in_game');
    expect(proj.gameId).toBeTruthy();
    expect(proj.phaseId).toBe('majority_report-r1-choosing');

    const opt = (proj.game!.options ?? [])[0]!.id;
    const payload = { answer: opt, forecast: opt };

    // No phaseId → treated as stale, never applied to the live round.
    const missing = rm.handleAction(host.memberId, host.roomId, {
      actionId: randomUUID(), type: 'submit_round', gameId: proj.gameId!, payload,
    });
    expect(missing.accepted).toBe(false);
    expect(missing.reason).toBe('wrong_phase');

    // A phaseId from a different/earlier phase → rejected.
    const stale = rm.handleAction(host.memberId, host.roomId, {
      actionId: randomUUID(), type: 'submit_round', gameId: proj.gameId!, phaseId: 'majority_report-r1-reveal', payload,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe('wrong_phase');

    // The current phaseId is accepted.
    const ok = rm.handleAction(host.memberId, host.roomId, {
      actionId: randomUUID(), type: 'submit_round', gameId: proj.gameId!, phaseId: proj.phaseId!, payload,
    });
    expect(ok.accepted).toBe(true);
  });
});

describe('player limits are enforced (blueprint §5)', () => {
  it('rejects a join once the room is at capacity', async () => {
    built = await buildServer(':memory:');
    const { rm } = built;
    const { credentials: host } = rm.createRoom('Host', {}, 'guest:h'); // seat 1

    // Fill to the cap (10: the largest table any launch game supports).
    for (let i = 2; i <= 10; i++) {
      const jr = rm.joinRoom(host.code, `P${i}`, `guest:${i}`);
      expect('credentials' in jr).toBe(true);
    }
    const overflow = rm.joinRoom(host.code, 'P11', 'guest:11');
    expect('error' in overflow && overflow.error).toBe('room_full');
  });

  it('blocks starting a night when no game can meet its minimum', async () => {
    built = await buildServer(':memory:');
    const { rm } = built;
    grantPass(built, 'bot:host');
    // Alibi Club needs 5; only 4 seats here.
    const { credentials: host } = rm.createRoom('Host', { playlist: ['alibi_club'] }, 'bot:host');
    rm.addBots(host.roomId, 3);

    const res = rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('not_permitted');
    expect(rm.getRoom(host.roomId)!.status).toBe('lobby');
  });

  it('skips an unplayable game and starts the next playable one', async () => {
    vi.useFakeTimers();
    built = await buildServer(':memory:');
    const { rm } = built;
    grantPass(built, 'bot:host');
    // Alibi Club (min 5) is first but only 4 seats — it must be skipped.
    const { credentials: host } = rm.createRoom('Host', { playlist: ['alibi_club', 'majority_report'] }, 'bot:host');
    rm.addBots(host.roomId, 3);

    rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });
    const room = rm.getRoom(host.roomId)!;
    expect(room.status).toBe('in_game');
    expect(room.playlistIndex).toBe(1);
    expect(rm.resync(host.memberId, host.roomId)!.game!.gameType).toBe('majority_report');
  });
});

describe('night completion is idempotent (blueprint §10, §16)', () => {
  it('emits session_completed exactly once across repeated end_night', async () => {
    built = await buildServer(':memory:');
    const { rm, analytics } = built;
    const { credentials: host } = rm.createRoom('Host', {}, 'guest:h');

    rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'end_night' });
    rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'end_night' });
    rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'end_night' });

    expect(rm.getRoom(host.roomId)!.status).toBe('complete');
    expect(analytics.funnel().counts.nights_completed).toBe(1);
  });
});

describe('report_content is rate limited at the socket layer (blueprint §12)', () => {
  it('accepts a short burst then rejects with rate_limited', async () => {
    built = await buildServer(':memory:');
    const { rm } = built;
    const { credentials: host } = rm.createRoom('Host', {}, 'guest:h');

    for (let i = 0; i < 5; i++) {
      const r = rm.handleAction(host.memberId, host.roomId, {
        actionId: randomUUID(), type: 'report_content', payload: { reason: 'test' },
      });
      expect(r.accepted).toBe(true);
    }
    const sixth = rm.handleAction(host.memberId, host.roomId, {
      actionId: randomUUID(), type: 'report_content', payload: { reason: 'test' },
    });
    expect(sixth.accepted).toBe(false);
    expect(sixth.reason).toBe('rate_limited');
  });
});

describe('the roster locked at game start is persisted (blueprint §10)', () => {
  it('writes the locked roster to the game instance', async () => {
    vi.useFakeTimers();
    built = await buildServer(':memory:');
    const { rm, db } = built;
    grantPass(built, 'bot:host');
    const { credentials: host } = rm.createRoom('Host', { playlist: ['majority_report'] }, 'bot:host');
    rm.addBots(host.roomId, 3);
    rm.handleAction(host.memberId, host.roomId, { actionId: randomUUID(), type: 'start_night' });

    const row = db.prepare('SELECT roster_json FROM game_instances WHERE room_id = ?').get(host.roomId) as
      | { roster_json: string | null }
      | undefined;
    const roster = JSON.parse(row?.roster_json ?? '[]') as string[];
    expect(roster.length).toBe(4);
    expect(roster).toContain(host.memberId);
  });
});

describe('/metrics is token-protected (blueprint §16)', () => {
  it('requires the configured token', async () => {
    built = await buildServer(':memory:');
    const { app } = built;
    await app.ready();
    config.metricsToken = 'secret-tok';

    const noAuth = await app.inject({ method: 'GET', url: '/metrics' });
    expect(noAuth.statusCode).toBe(401);

    const withToken = await app.inject({ method: 'GET', url: '/metrics?token=secret-tok' });
    expect(withToken.statusCode).toBe(200);
    expect(withToken.json()).toHaveProperty('counts');

    const withBearer = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer secret-tok' } });
    expect(withBearer.statusCode).toBe(200);
  });

  it('is locked by default in production, open in dev', async () => {
    built = await buildServer(':memory:');
    const { app } = built;
    await app.ready();
    config.metricsToken = '';

    config.isProduction = true;
    const locked = await app.inject({ method: 'GET', url: '/metrics' });
    expect(locked.statusCode).toBe(401);

    config.isProduction = false;
    const open = await app.inject({ method: 'GET', url: '/metrics' });
    expect(open.statusCode).toBe(200);
  });
});

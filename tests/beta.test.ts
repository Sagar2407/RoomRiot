import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildServer, type BuiltServer } from '@roomriot/game-server/src/index.ts';

let built: BuiltServer | null = null;
afterEach(() => {
  if (built) {
    built.db.close();
    built = null;
  }
});

describe('reporting & moderation (blueprint §12, §16)', () => {
  it('records a scoped, private report and counts content_reported', async () => {
    built = await buildServer(':memory:');
    const { rm, db, analytics } = built;
    const { credentials: host } = rm.createRoom('Host', {}, 'guest:h');
    const jr = rm.joinRoom(host.code, 'P2', 'guest:2');
    if (!('credentials' in jr)) throw new Error('join failed');
    const p2 = jr.credentials;

    const res = rm.handleAction(p2.memberId, host.roomId, {
      actionId: randomUUID(),
      type: 'report_content',
      payload: { reason: 'Inappropriate content' },
    });
    expect(res.accepted).toBe(true);

    const row = db.prepare('SELECT reporter_ref, reason, status FROM reports WHERE room_id = ?').get(host.roomId) as
      | { reporter_ref: string; reason: string; status: string }
      | undefined;
    expect(row?.reason).toBe('Inappropriate content');
    expect(row?.status).toBe('open');
    // Reporter is stored pseudonymously, not as the raw member id.
    expect(row?.reporter_ref).not.toBe(p2.memberId);

    expect(analytics.funnel().counts.content_reported).toBe(1);
  });

  it('emits join_started/join_succeeded and computes join success rate', async () => {
    built = await buildServer(':memory:');
    const { rm, analytics } = built;
    const { credentials: host } = rm.createRoom('Host', {}, 'guest:h');
    // Simulate the join route's analytics + the manager join.
    analytics.emit('join_started', {});
    rm.joinRoom(host.code, 'P2', 'guest:2');
    const funnel = analytics.funnel();
    expect(funnel.counts.join_started).toBe(1);
    expect(funnel.counts.join_succeeded).toBe(1);
    expect(funnel.rates_pct.join_success).toBe(100);
  });

  it('rate-limits room creation per IP (blueprint §9)', async () => {
    built = await buildServer(':memory:');
    const { app } = built;
    await app.ready();
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/rooms',
        headers: { 'content-type': 'application/json' },
        payload: { nickname: `H${i}` },
      });
      if (res.statusCode === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it('never stores prompt answers or nicknames in analytics rows', async () => {
    built = await buildServer(':memory:');
    const { rm, db } = built;
    rm.createRoom('SecretNickname', {}, 'guest:h');
    const cols = (db.prepare('SELECT * FROM analytics_events LIMIT 1').get() ?? {}) as Record<string, unknown>;
    const serialized = JSON.stringify(cols);
    expect(serialized).not.toContain('SecretNickname');
  });
});

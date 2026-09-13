import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildServer, type BuiltServer } from '@roomriot/game-server/src/index.ts';
import {
  processBillingEvent,
  verifySignature,
  signPayload,
  activePartyPass,
  resolvePlaylist,
  freeRotationGames,
  type BillingEvent,
} from '@roomriot/game-server/src/billing.ts';

let built: BuiltServer | null = null;
afterEach(() => {
  if (built) {
    built.db.close();
    built = null;
  }
});

function payment(guestId: string, id = `evt_${randomUUID()}`): BillingEvent {
  return { id, type: 'payment.succeeded', data: { guestId, product: 'party_pass', platform: 'web' } };
}

describe('billing webhook signature (blueprint §14)', () => {
  it('accepts a correctly signed body and rejects tampering / staleness', () => {
    const body = JSON.stringify(payment('guest:1'));
    const sig = signPayload(body);
    expect(verifySignature(body, sig)).toBe(true);
    expect(verifySignature(body + ' ', sig)).toBe(false); // tampered body
    expect(verifySignature(body, 't=1,v1=deadbeef')).toBe(false); // stale + wrong
    expect(verifySignature(body, undefined)).toBe(false);
  });
});

describe('entitlements & idempotency (blueprint §14)', () => {
  it('grants a Party Pass on payment and is idempotent on replay', async () => {
    built = await buildServer(':memory:');
    const { db, analytics } = built;
    const evt = payment('guest:buyer');

    const first = processBillingEvent(db, analytics, evt);
    const replay = processBillingEvent(db, analytics, evt);
    expect(first.ok).toBe(true);
    expect(replay.duplicate).toBe(true);

    // Only one entitlement despite the replayed webhook.
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM entitlements WHERE guest_id = ?`).get('guest:buyer') as { c: number };
    expect(rows.c).toBe(1);
    expect(activePartyPass(db, 'guest:buyer')?.active).toBe(true);
    expect(analytics.funnel().counts.purchases_verified).toBe(1);
  });

  it('expires the pass on refund', async () => {
    built = await buildServer(':memory:');
    const { db, analytics } = built;
    processBillingEvent(db, analytics, payment('guest:refund'));
    expect(activePartyPass(db, 'guest:refund')).not.toBeNull();

    processBillingEvent(db, analytics, {
      id: `evt_${randomUUID()}`,
      type: 'charge.refunded',
      data: { guestId: 'guest:refund', product: 'party_pass' },
    });
    expect(activePartyPass(db, 'guest:refund')).toBeNull();
  });
});

describe('free-tier gate (blueprint §14)', () => {
  it('caps a free host to the rotating trio but honours a Party Pass', async () => {
    built = await buildServer(':memory:');
    const { db, analytics } = built;
    const full = ['majority_report', 'bluff_bureau', 'caption_court', 'link_up', 'alibi_club', 'close_call'] as const;

    const free = resolvePlaylist(db, 'guest:free', [...full]);
    expect(free.tier).toBe('free');
    expect(free.playlist).toHaveLength(3);
    expect(free.playlist).toEqual(freeRotationGames());

    processBillingEvent(db, analytics, payment('guest:paid'));
    const paid = resolvePlaylist(db, 'guest:paid', [...full]);
    expect(paid.tier).toBe('party_pass');
    expect(paid.playlist).toHaveLength(6);
  });

  it('a free room created through the manager runs the trio and reports its tier', async () => {
    built = await buildServer(':memory:');
    const { rm } = built;
    const { credentials: host } = rm.createRoom('Host', {}, 'guest:free2');
    const proj = rm.resync(host.memberId, host.roomId)!;
    expect(proj.tier).toBe('free');
    expect(proj.playlist).toHaveLength(3);
  });
});

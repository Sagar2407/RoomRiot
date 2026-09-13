/**
 * Billing & entitlements (blueprint §14).
 *
 * Guests always join free; the host buys the experience for the room. The free
 * tier is a complete short night of three rotating games; the Party Pass unlocks
 * all launch games for 24 hours from activation. There are no paid multipliers or
 * purchasable in-game advantages, and no payment screen ever appears mid-game —
 * the tier is resolved once, at room creation.
 *
 * This is provider-agnostic and Stripe-shaped: `verifySignature` mirrors Stripe's
 * `t=…,v1=…` signed-webhook scheme, and `processBillingEvent` is idempotent by
 * event id. Swapping in real Stripe means replacing `verifySignature` with
 * `stripe.webhooks.constructEvent` and mapping event types — the entitlement
 * logic below is unchanged.
 */
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { PARTY_GAMES, PARTY_PASS, type GameType, type EntitlementStatus, type Tier } from '@roomriot/contracts';
import type { DB } from './db.js';
import type { Analytics } from './analytics.js';
import { config } from './config.js';

const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface BillingEvent {
  id: string;
  type: 'payment.succeeded' | 'charge.refunded';
  data: { guestId: string; product?: string; platform?: string };
}

/** Verify a Stripe-style signed webhook: header `t=<unix>,v1=<hmac>` over `${t}.${rawBody}`. */
export function verifySignature(rawBody: string, header: string | undefined, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now - t * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const expected = createHmac('sha256', config.billingWebhookSecret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(v1);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sign a payload the way our (or Stripe's) provider would — used by dev-checkout and tests. */
export function signPayload(rawBody: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  const v1 = createHmac('sha256', config.billingWebhookSecret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export interface ProcessResult {
  ok: boolean;
  duplicate?: boolean;
  entitlementId?: string;
}

/** Apply a verified event idempotently (blueprint §14 "idempotent entitlement changes"). */
export function processBillingEvent(db: DB, analytics: Analytics, event: BillingEvent, now = Date.now()): ProcessResult {
  if (!event?.id || !event.type || !event.data?.guestId) return { ok: false };

  const seen = db.prepare(`SELECT 1 FROM billing_events WHERE event_id = ?`).get(event.id);
  if (seen) return { ok: true, duplicate: true };
  db.prepare(`INSERT INTO billing_events (event_id, type, guest_id, created_at) VALUES (?,?,?,?)`).run(
    event.id,
    event.type,
    event.data.guestId,
    now,
  );

  const product = event.data.product ?? PARTY_PASS.product;
  const platform = event.data.platform ?? 'web';

  if (event.type === 'payment.succeeded') {
    const id = randomUUID();
    const validUntil = now + config.partyPassHours * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO entitlements (id, guest_id, product, platform, source_event, state, valid_from, valid_until)
       VALUES (?,?,?,?,?, 'active', ?, ?)`,
    ).run(id, event.data.guestId, product, platform, event.id, now, validUntil);
    analytics.emit('purchase_verified', { memberId: event.data.guestId, platform, meta: { product } });
    return { ok: true, entitlementId: id };
  }

  if (event.type === 'charge.refunded') {
    // Expire the buyer's entitlement for this product without interrupting an
    // already-started night (the tier is only read at room creation, §10/§14).
    db.prepare(
      `UPDATE entitlements SET state = 'refunded', valid_until = ? WHERE guest_id = ? AND product = ? AND state = 'active'`,
    ).run(now, event.data.guestId, product);
    return { ok: true };
  }

  return { ok: false };
}

export function activePartyPass(db: DB, guestId: string, now = Date.now()): { active: boolean; validUntil: number } | null {
  const row = db
    .prepare(
      `SELECT valid_until FROM entitlements
       WHERE guest_id = ? AND product = 'party_pass' AND state = 'active' AND valid_until > ?
       ORDER BY valid_until DESC LIMIT 1`,
    )
    .get(guestId, now) as { valid_until: number } | undefined;
  return row ? { active: true, validUntil: row.valid_until } : null;
}

/** The rotating free trio available right now (blueprint §14). Party games only —
 * classics never appear in the free rotation. */
export function freeRotationGames(now = Date.now()): GameType[] {
  const day = Math.floor(now / (24 * 60 * 60 * 1000));
  const start = ((day % PARTY_GAMES.length) + PARTY_GAMES.length) % PARTY_GAMES.length;
  return [0, 1, 2].map((i) => PARTY_GAMES[(start + i) % PARTY_GAMES.length]!);
}

/** Keep only games the deployment has enabled (classics stay off until ready). */
function enabledOnly(games: GameType[]): GameType[] {
  return games.filter((g) => (config.enabledGames as string[]).includes(g));
}

export function tierFor(db: DB, guestId: string, now = Date.now()): Tier {
  return activePartyPass(db, guestId, now) ? 'party_pass' : 'free';
}

/**
 * Resolve the playlist a host is allowed to run. With an active Party Pass the
 * requested playlist stands; on the free tier it is replaced by the rotating
 * trio — a complete short night, never a mid-game paywall.
 */
export function resolvePlaylist(db: DB, guestId: string, requested: GameType[], now = Date.now()): { playlist: GameType[]; tier: Tier } {
  const fallback = enabledOnly(config.launchPlaylist as GameType[]);
  // Billing off ⇒ the whole app is free. Honor a standalone/explicit selection
  // (restricted to enabled games); fall back to the launch playlist otherwise
  // (integration issue #5 — a "Play Snakes" pick must not launch the party set).
  if (!config.billingEnabled) {
    const picked = enabledOnly(requested);
    return { playlist: picked.length > 0 ? picked : fallback, tier: 'free' };
  }
  if (activePartyPass(db, guestId, now)) {
    const picked = enabledOnly(requested);
    return { playlist: picked.length > 0 ? picked : fallback, tier: 'party_pass' };
  }
  return { playlist: enabledOnly(freeRotationGames(now)), tier: 'free' };
}

export function entitlementStatus(db: DB, guestId: string, now = Date.now()): EntitlementStatus {
  const pass = config.billingEnabled ? activePartyPass(db, guestId, now) : null;
  return {
    tier: pass ? 'party_pass' : 'free',
    partyPass: pass,
    freeGames: config.billingEnabled ? freeRotationGames(now) : (config.launchPlaylist as GameType[]),
    offer: {
      product: PARTY_PASS.product,
      priceUsd: config.partyPassPriceUsd,
      durationHours: config.partyPassHours,
      label: PARTY_PASS.label,
      unlocks: PARTY_PASS.unlocks,
    },
    billingEnabled: config.billingEnabled,
  };
}

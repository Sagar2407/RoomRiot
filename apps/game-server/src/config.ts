import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  /**
   * HMAC secret for signed guest/member/display tokens. In production set
   * ROOM_RIOT_SECRET; a random per-boot secret is fine for local dev (tokens just
   * don't survive a restart, which the reconnect flow already tolerates).
   */
  secret: process.env.ROOM_RIOT_SECRET ?? randomBytes(32).toString('hex'),
  /** SQLite file. `:memory:` is handy for tests. */
  dbPath: process.env.ROOM_RIOT_DB ?? resolve(__dirname, '../../../data/room-riot.sqlite'),
  /** CORS origin for the web client. */
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  /** Blueprint §10: expire abandoned rooms after a two-hour inactivity window. */
  roomTtlMs: Number(process.env.ROOM_TTL_MS ?? 2 * 60 * 60 * 1000),

  // ---- Billing (blueprint §14). Stripe drops in behind these seams. --------
  /** Secret used to verify signed billing webhook events (Stripe: webhook signing secret). */
  billingWebhookSecret: process.env.BILLING_WEBHOOK_SECRET ?? process.env.ROOM_RIOT_SECRET ?? 'dev-billing-secret',
  /**
   * Enables POST /billing/dev-checkout, which simulates a completed purchase so
   * the full entitlement flow is runnable without a Stripe account. Off in
   * production. Defaults on unless NODE_ENV=production.
   */
  enableDevCheckout: (process.env.ENABLE_DEV_CHECKOUT ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',
  /** Party Pass: $4.99 for 24 hours from activation. */
  partyPassPriceUsd: Number(process.env.PARTY_PASS_PRICE ?? 4.99),
  partyPassHours: Number(process.env.PARTY_PASS_HOURS ?? 24),
};

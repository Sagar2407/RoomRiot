import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALL_GAMES = ['majority_report', 'bluff_bureau', 'caption_court', 'link_up', 'alibi_club', 'close_call'] as const;

/** Parse ROOM_RIOT_PLAYLIST ("a,b,c") into a validated game-type list. */
function parsePlaylist(raw: string | undefined): string[] {
  if (!raw) return [...ALL_GAMES];
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => (ALL_GAMES as readonly string[]).includes(s));
  return wanted.length > 0 ? wanted : [...ALL_GAMES];
}

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
  /**
   * Global safety ceiling on a room's roster. The effective capacity is the
   * smaller of this and the largest maxPlayers across the room's playlist, so a
   * room can never grow past what its games support (blueprint §5).
   */
  roomMaxPlayers: Number(process.env.ROOM_MAX_PLAYERS ?? 12),

  /** True in production; used to lock ops endpoints by default. */
  isProduction: process.env.NODE_ENV === 'production',
  /**
   * Bearer token guarding GET /metrics. When set, callers must present it
   * (Authorization: Bearer <token> or ?token=). In production an unset token
   * locks the endpoint entirely; in dev it stays open for convenience.
   */
  metricsToken: process.env.ROOM_RIOT_METRICS_TOKEN ?? '',

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

  // ---- Launch configuration ------------------------------------------------
  /**
   * When false, the whole app is free: no paywall, no offer, everyone plays the
   * launch playlist. Flip to true (and set BILLING_WEBHOOK_SECRET + wire Stripe)
   * to gate extra games behind the Party Pass later.
   */
  billingEnabled: (process.env.ROOM_RIOT_BILLING_ENABLED ?? 'true') === 'true',
  /** The set of games a night runs (also the free launch set). */
  launchPlaylist: parsePlaylist(process.env.ROOM_RIOT_PLAYLIST),

  /**
   * If set (and the directory exists), the game server also serves the built web
   * app from here, so a single service hosts everything on one origin.
   */
  serveWebDir: process.env.SERVE_WEB_DIR ?? '',
};

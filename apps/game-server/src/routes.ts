/**
 * HTTP surface (blueprint §9 "API surface"). Room creation, joining, a display
 * token, and a snapshot endpoint. Live gameplay flows over Socket.IO.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CreateRoomRequestSchema, JoinRoomRequestSchema } from '@roomriot/contracts';
import type { RoomManager } from './roomManager.js';
import type { Analytics } from './analytics.js';
import type { DB } from './db.js';
import { config } from './config.js';
import {
  entitlementStatus,
  processBillingEvent,
  verifySignature,
  type BillingEvent,
} from './billing.js';
import { issueToken, verifyToken, type GuestClaims, type MemberClaims, type DisplayClaims } from './tokens.js';

function guestIdFrom(token: string | undefined): string {
  const claims = verifyToken<GuestClaims>(token);
  return claims?.typ === 'guest' && claims.guestId ? claims.guestId : `guest:${randomUUID()}`;
}

// Per-route limits. Joins are generous so a whole party on one Wi-Fi is never
// throttled, while still slowing room-code brute forcing (blueprint §9).
const LIMIT = {
  create: { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } },
  join: { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
  guest: { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } },
  support: { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
};

export function registerRoutes(app: FastifyInstance, rm: RoomManager, analytics: Analytics, db: DB): void {
  app.get('/health', async () => ({ ok: true, service: 'room-riot-game-server' }));

  // Operations funnel (blueprint §16). Aggregates only — no per-user data.
  app.get('/metrics', async () => analytics.funnel());

  // Mint a stable guest identity up front, so a pre-room purchase attaches to the
  // same identity that later hosts the room (blueprint §14).
  app.post('/guest', LIMIT.guest, async () => ({ guestToken: issueToken({ typ: 'guest', guestId: `guest:${randomUUID()}` }) }));

  // ---- Billing & entitlements (blueprint §14) ----------------------------

  // Host setup reads this to show the current tier + offer. Viewing it is the
  // offer impression.
  app.get('/entitlements', async (req) => {
    const guestId = guestIdFrom(bearer(req.headers.authorization) ?? (req.query as { guestToken?: string })?.guestToken);
    analytics.emit('offer_viewed', { memberId: guestId, meta: { product: 'party_pass' } });
    return entitlementStatus(db, guestId);
  });

  // Verified provider webhook → idempotent entitlement change.
  app.post('/billing/webhook', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const sig = req.headers['x-roomriot-signature'] as string | undefined;
    if (!verifySignature(raw, sig)) return reply.code(400).send({ error: 'bad_signature' });
    const event = req.body as BillingEvent;
    const result = processBillingEvent(db, analytics, event);
    if (!result.ok) return reply.code(400).send({ error: 'unprocessable_event' });
    return reply.send({ received: true, duplicate: result.duplicate ?? false });
  });

  // Dev-only: simulate a completed checkout so the flow runs without Stripe.
  app.post('/billing/dev-checkout', async (req, reply) => {
    if (!config.enableDevCheckout) return reply.code(404).send({ error: 'not_found' });
    const guestId = guestIdFrom((req.body as { guestToken?: string })?.guestToken);
    const event: BillingEvent = {
      id: `dev_${randomUUID()}`,
      type: 'payment.succeeded',
      data: { guestId, product: 'party_pass', platform: 'web' },
    };
    processBillingEvent(db, analytics, event);
    return reply.send(entitlementStatus(db, guestId));
  });

  // Support flow (blueprint §15).
  app.post('/support', LIMIT.support, async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; message?: string; roomId?: string };
    if (!body.message || body.message.trim().length === 0) return reply.code(400).send({ error: 'message_required' });
    db.prepare(
      `INSERT INTO support_requests (id, email, message, room_ref, status, created_at) VALUES (?,?,?,?, 'open', ?)`,
    ).run(randomUUID(), (body.email ?? '').slice(0, 200), body.message.slice(0, 4000), body.roomId ? analytics.ref(body.roomId) : null, Date.now());
    return reply.send({ ok: true });
  });

  app.post('/rooms', LIMIT.create, async (req, reply) => {
    const parsed = CreateRoomRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.flatten() });
    const guestId = guestIdFrom(parsed.data.guestToken);
    const { credentials } = rm.createRoom(parsed.data.nickname, parsed.data.settings, guestId);
    return reply.code(201).send(credentials);
  });

  app.post('/rooms/join', LIMIT.join, async (req, reply) => {
    const parsed = JoinRoomRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.flatten() });
    const guestId = guestIdFrom(parsed.data.guestToken);
    analytics.emit('join_started', { meta: { hasCode: !!parsed.data.code } });
    const result = rm.joinRoom(parsed.data.code, parsed.data.nickname, guestId);
    if ('error' in result) return reply.code(404).send({ error: 'room_not_found' });
    return reply.send(result.credentials);
  });

  // A solo host with a full table of fictional players (blueprint §3).
  app.post('/practice', LIMIT.create, async (req, reply) => {
    const body = (req.body ?? {}) as { nickname?: string; guestToken?: string };
    const guestId = guestIdFrom(body.guestToken);
    const { credentials } = rm.createRoom(body.nickname?.trim() || 'You', { playlist: ['majority_report'] }, guestId);
    rm.addBots(credentials.roomId, 3);
    return reply.code(201).send({ ...credentials, practice: true });
  });

  app.post<{ Params: { id: string } }>('/rooms/:id/display-token', async (req, reply) => {
    const claims = verifyToken<MemberClaims>(bearer(req.headers.authorization));
    if (!claims || claims.typ !== 'member' || claims.roomId !== req.params.id)
      return reply.code(401).send({ error: 'unauthorized' });
    const room = rm.getRoom(req.params.id);
    if (!room) return reply.code(404).send({ error: 'room_not_found' });
    if (room.hostMemberId !== claims.memberId) return reply.code(403).send({ error: 'host_only' });
    const token = rm.issueDisplayToken(req.params.id);
    return reply.send({ displayToken: token });
  });

  app.get<{ Params: { id: string } }>('/rooms/:id/snapshot', async (req, reply) => {
    const auth = bearer(req.headers.authorization);
    const member = verifyToken<MemberClaims>(auth);
    if (member?.typ === 'member' && member.roomId === req.params.id) {
      const p = rm.resync(member.memberId, req.params.id);
      return p ? reply.send(p) : reply.code(404).send({ error: 'room_not_found' });
    }
    const display = verifyToken<DisplayClaims>(auth);
    if (display?.typ === 'display' && display.roomId === req.params.id) {
      const p = rm.resync(null, req.params.id);
      return p ? reply.send(p) : reply.code(404).send({ error: 'room_not_found' });
    }
    return reply.code(401).send({ error: 'unauthorized' });
  });
}

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return header.startsWith('Bearer ') ? header.slice(7) : header;
}

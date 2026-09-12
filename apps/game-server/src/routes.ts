/**
 * HTTP surface (blueprint §9 "API surface"). Room creation, joining, a display
 * token, and a snapshot endpoint. Live gameplay flows over Socket.IO.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CreateRoomRequestSchema, JoinRoomRequestSchema } from '@roomriot/contracts';
import type { RoomManager } from './roomManager.js';
import { verifyToken, type GuestClaims, type MemberClaims, type DisplayClaims } from './tokens.js';

function guestIdFrom(token: string | undefined): string {
  const claims = verifyToken<GuestClaims>(token);
  return claims?.typ === 'guest' && claims.guestId ? claims.guestId : `guest:${randomUUID()}`;
}

export function registerRoutes(app: FastifyInstance, rm: RoomManager): void {
  app.get('/health', async () => ({ ok: true, service: 'room-riot-game-server' }));

  app.post('/rooms', async (req, reply) => {
    const parsed = CreateRoomRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.flatten() });
    const guestId = guestIdFrom(parsed.data.guestToken);
    const { credentials } = rm.createRoom(parsed.data.nickname, parsed.data.settings, guestId);
    return reply.code(201).send(credentials);
  });

  app.post('/rooms/join', async (req, reply) => {
    const parsed = JoinRoomRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.flatten() });
    const guestId = guestIdFrom(parsed.data.guestToken);
    const result = rm.joinRoom(parsed.data.code, parsed.data.nickname, guestId);
    if ('error' in result) return reply.code(404).send({ error: 'room_not_found' });
    return reply.send(result.credentials);
  });

  // A solo host with a full table of fictional players (blueprint §3).
  app.post('/practice', async (req, reply) => {
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

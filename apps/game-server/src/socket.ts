/**
 * Socket.IO handlers. The handshake carries a signed member or display token;
 * identity is taken from the verified token, never from the payload. Actions are
 * acknowledged (`action.result`) and authorised projections are pushed
 * (`room.state`). Reconnecting clients call `room.resync` to get a fresh snapshot
 * (blueprint §10 — Socket.IO delivery is at-most-once, so we never rely on replay).
 */
import type { Server as IOServer, Socket } from 'socket.io';
import { ClientActionSchema } from '@roomriot/contracts';
import type { RoomManager } from './roomManager.js';
import { verifyToken, type MemberClaims, type DisplayClaims } from './tokens.js';

interface SocketState {
  memberId: string | null;
  roomId: string | null;
}

export function registerSocket(io: IOServer, rm: RoomManager): void {
  io.on('connection', (socket: Socket) => {
    const auth = socket.handshake.auth as { memberToken?: string; displayToken?: string };
    const state: SocketState = { memberId: null, roomId: null };

    const member = verifyToken<MemberClaims>(auth.memberToken);
    if (member?.typ === 'member') {
      state.memberId = member.memberId;
      state.roomId = member.roomId;
      const room = rm.attachMemberSocket(member.memberId, socket);
      if (!room) socket.emit('room.error', { message: 'Room not found' });
    } else {
      const display = verifyToken<DisplayClaims>(auth.displayToken);
      if (display?.typ === 'display') {
        state.roomId = display.roomId;
        const room = rm.attachDisplaySocket(display.roomId, socket);
        if (!room) socket.emit('room.error', { message: 'Room not found' });
      } else {
        socket.emit('room.error', { message: 'Missing or invalid token' });
        socket.disconnect(true);
        return;
      }
    }

    socket.on('game.action', (raw: unknown, ack?: (result: unknown) => void) => {
      const parsed = ClientActionSchema.safeParse(raw);
      if (!parsed.success) {
        const result = { actionId: (raw as { actionId?: string })?.actionId ?? 'unknown', accepted: false, reason: 'invalid_payload', sequence: 0 };
        ack?.(result);
        socket.emit('action.result', result);
        return;
      }
      if (!state.memberId || !state.roomId) {
        const result = { actionId: parsed.data.actionId, accepted: false, reason: 'unauthorized', sequence: 0 };
        ack?.(result);
        socket.emit('action.result', result);
        return;
      }
      const result = rm.handleAction(state.memberId, state.roomId, parsed.data);
      ack?.(result);
      socket.emit('action.result', result);
    });

    socket.on('room.resync', () => {
      if (!state.roomId) return;
      const projection = rm.resync(state.memberId, state.roomId);
      if (projection) socket.emit('room.state', projection);
    });

    socket.on('disconnect', () => rm.detachSocket(socket));
  });
}

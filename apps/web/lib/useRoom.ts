'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { RoomProjection, ClientAction, ActionResult } from '@roomriot/contracts';
import { SERVER_URL } from './config';

export interface UseRoom {
  projection: RoomProjection | null;
  connected: boolean;
  error: string | null;
  /** Send a game/host action; returns the server's acknowledgement. */
  send: (input: Omit<ClientAction, 'actionId'>) => Promise<ActionResult>;
}

type Auth = { memberToken: string } | { displayToken: string };

/**
 * Connects to the game server, keeps the latest authorized projection, and
 * exposes an acknowledged `send`. On reconnect it asks for a fresh snapshot
 * rather than trusting event replay (blueprint §10).
 */
export function useRoom(auth: Auth | null): UseRoom {
  const [projection, setProjection] = useState<RoomProjection | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!auth) return;
    // Empty SERVER_URL ⇒ same-origin (single-service deploy): let socket.io default.
    const target = SERVER_URL || undefined;
    const socket = io(target, { auth, transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setError(null);
      socket.emit('room.resync', { lastSequence: 0 });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('room.state', (p: RoomProjection) => setProjection(p));
    socket.on('room.error', (e: { message: string }) => setError(e.message));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
    // Reconnect only when the token identity changes.
  }, [JSON.stringify(auth)]);

  const send = useCallback((input: Omit<ClientAction, 'actionId'>): Promise<ActionResult> => {
    // The actionId is minted once and reused on every retry. The server is
    // idempotent by actionId (blueprint §10), so a retry after a lost ack returns
    // the recorded outcome instead of applying the action twice.
    const actionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    const action: ClientAction = { ...input, actionId };
    const MAX_ATTEMPTS = 3;
    const ACK_TIMEOUT_MS = 6000;

    return new Promise((resolve) => {
      let settled = false;
      let attempts = 0;
      const finish = (r: ActionResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const attempt = () => {
        attempts += 1;
        const socket = socketRef.current;
        if (!socket || !socket.connected) {
          // No live socket yet — wait briefly for (re)connect, then give up so the
          // caller never hangs forever on a dead connection.
          if (attempts >= MAX_ATTEMPTS) {
            finish({ actionId, accepted: false, reason: 'internal_error', message: 'Not connected — check your connection and try again.', sequence: 0 });
            return;
          }
          setTimeout(attempt, 1000);
          return;
        }
        let acked = false;
        socket.emit('game.action', action, (result: ActionResult) => {
          acked = true;
          finish(result);
        });
        setTimeout(() => {
          if (settled || acked) return;
          if (attempts >= MAX_ATTEMPTS) {
            finish({ actionId, accepted: false, reason: 'internal_error', message: 'No response from the server — please try again.', sequence: 0 });
            return;
          }
          attempt(); // retry with the same actionId
        }, ACK_TIMEOUT_MS);
      };
      attempt();
    });
  }, []);

  return { projection, connected, error, send };
}

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
    return new Promise((resolve) => {
      const socket = socketRef.current;
      const actionId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      const action: ClientAction = { ...input, actionId };
      if (!socket) {
        resolve({ actionId, accepted: false, reason: 'internal_error', sequence: 0 });
        return;
      }
      socket.emit('game.action', action, (result: ActionResult) => resolve(result));
    });
  }, []);

  return { projection, connected, error, send };
}

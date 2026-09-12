'use client';
import type { MembershipCredentials, RoomSettings } from '@roomriot/contracts';
import { SERVER_URL } from './config';
import { loadGuestToken } from './storage';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function hostRoom(nickname: string, settings?: Partial<RoomSettings>): Promise<MembershipCredentials> {
  return post('/rooms', { nickname, settings, guestToken: loadGuestToken() });
}

export function joinRoom(code: string, nickname: string): Promise<MembershipCredentials> {
  return post('/rooms/join', { code: code.toUpperCase(), nickname, guestToken: loadGuestToken() });
}

export function startPractice(nickname: string): Promise<MembershipCredentials & { practice: boolean }> {
  return post('/practice', { nickname, guestToken: loadGuestToken() });
}

export async function requestDisplayToken(roomId: string, memberToken: string): Promise<string> {
  const res = await fetch(`${SERVER_URL}/rooms/${roomId}/display-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${memberToken}` },
  });
  if (!res.ok) throw new Error('Could not create a display link');
  const data = (await res.json()) as { displayToken: string };
  return data.displayToken;
}

'use client';
import type { MembershipCredentials } from '@roomriot/contracts';

const CREDS = 'roomriot.creds';
const GUEST = 'roomriot.guestToken';

/** Per-viewer conveniences only; wrapped so private windows / blocked storage never crash the app. */
export function saveCreds(creds: MembershipCredentials): void {
  try {
    localStorage.setItem(CREDS, JSON.stringify(creds));
    localStorage.setItem(GUEST, creds.guestToken);
  } catch {
    /* ignore */
  }
}

export function loadCreds(): MembershipCredentials | null {
  try {
    const raw = localStorage.getItem(CREDS);
    return raw ? (JSON.parse(raw) as MembershipCredentials) : null;
  } catch {
    return null;
  }
}

export function loadGuestToken(): string | undefined {
  try {
    return localStorage.getItem(GUEST) ?? undefined;
  } catch {
    return undefined;
  }
}

export function clearCreds(): void {
  try {
    localStorage.removeItem(CREDS);
  } catch {
    /* ignore */
  }
}

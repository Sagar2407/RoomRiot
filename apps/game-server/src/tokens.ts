/**
 * Compact signed tokens (HMAC-SHA256), used for guest, member, and display
 * credentials. Identity always comes from the verified token, never a
 * client-supplied id (blueprint §9). This is the seam where Supabase Auth drops
 * in later: swap sign/verify for Supabase JWT verification and keep the claim
 * shapes below.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadJson: string): string {
  return createHmac('sha256', config.secret).update(payloadJson).digest('base64url');
}

export function issueToken(claims: Record<string, unknown>, ttlMs?: number): string {
  const now = Date.now();
  const payload = { ...claims, iat: now, ...(ttlMs ? { exp: now + ttlMs } : {}) };
  const json = JSON.stringify(payload);
  return `${b64url(json)}.${sign(json)}`;
}

export function verifyToken<T = Record<string, unknown>>(token: string | undefined): T | null {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let json: string;
  try {
    json = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(json);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
  return payload as T;
}

export interface GuestClaims {
  typ: 'guest';
  guestId: string;
}
export interface MemberClaims {
  typ: 'member';
  guestId: string;
  memberId: string;
  roomId: string;
}
export interface DisplayClaims {
  typ: 'display';
  roomId: string;
}

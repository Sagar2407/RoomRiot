/**
 * Server-authoritative randomness for board/card games (plan §4.5).
 *
 * `crypto.randomInt` is used for dice and shuffles because it draws from the
 * system CSPRNG and avoids modulo bias (unlike the seeded Mulberry32 generator,
 * which stays for deterministic unit tests and content selection). Outcomes are
 * resolved here and then baked into the persisted game state, so a restart loads
 * the applied outcome and never rerolls. Seeds, unused deck order, and opponent
 * hands are never derived from or sent to the client.
 */
import { randomInt } from 'node:crypto';

/** A fair d6 (1–6). */
export function rollDie(): number {
  return randomInt(1, 7);
}

/** A cryptographic Fisher–Yates shuffle (for future card decks). */
export function shuffle<T>(input: readonly T[]): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

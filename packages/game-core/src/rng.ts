/**
 * Deterministic, seeded pseudo-random generator.
 *
 * Blueprint §8: "Persist random decisions so reconnection and restarts cannot
 * reshuffle roles or alter results." The server seeds one RNG per game instance
 * from a stored seed string, so replaying the same accepted actions reproduces
 * the same roles, orderings, and pairings exactly.
 */
export interface RNG {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** In-place Fisher–Yates shuffle, returning the same array. */
  shuffle<T>(arr: T[]): T[];
  /** Pick one element (throws on empty). */
  pick<T>(arr: readonly T[]): T;
}

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: string): RNG {
  const seedFn = xmur3(seed);
  const rand = mulberry32(seedFn());
  const api: RNG = {
    next: rand,
    int(min: number, max: number) {
      if (max < min) [min, max] = [max, min];
      return min + Math.floor(rand() * (max - min + 1));
    },
    shuffle<T>(arr: T[]): T[] {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = tmp;
      }
      return arr;
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error('pick() from empty array');
      return arr[Math.floor(rand() * arr.length)]!;
    },
  };
  return api;
}

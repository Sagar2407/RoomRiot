/**
 * Night Points conversion (blueprint §6 "Points that stay fun and fair").
 *
 * Each game produces a raw score R out of a published maximum M. We convert to a
 * fixed 0–100 Night Points scale so games with different internal ranges combine
 * fairly:
 *
 *   performance = 100 × R / M
 *   placement   = 100 × (b + (t − 1) / 2) / (n − 1)
 *   NightPoints = round(0.75 × performance + 0.25 × placement)
 *
 * where, for a given player among n eligible players, b is the number of players
 * with a strictly lower raw score and t is the number tied with them (including
 * themselves). Ties receive equal placement. Requires n ≥ 2 eligible players.
 */
import { SCORING_VERSION } from '@roomriot/contracts';

export { SCORING_VERSION };

export interface RawEntry {
  memberId: string;
  raw: number;
}

export interface NightPointsEntry {
  memberId: string;
  raw: number;
  performance: number;
  placement: number;
  nightPoints: number;
}

/**
 * Convert one game's raw scores into Night Points.
 *
 * @param entries eligible players and their raw scores (0 ≤ raw ≤ max)
 * @param max     the game's published maximum raw score (M), possibly reduced by
 *                voided rounds so it stays consistent for everyone (§6).
 */
export function toNightPoints(entries: RawEntry[], max: number): NightPointsEntry[] {
  const n = entries.length;
  if (max <= 0) throw new Error('scoring: max must be positive');

  return entries.map((e) => {
    const performance = (100 * clamp(e.raw, 0, max)) / max;

    let placement: number;
    if (n < 2) {
      // Placement is undefined for a single eligible player; award performance only.
      placement = performance;
    } else {
      const b = entries.filter((o) => o.raw < e.raw).length;
      const t = entries.filter((o) => o.raw === e.raw).length; // includes self
      placement = (100 * (b + (t - 1) / 2)) / (n - 1);
    }

    const nightPoints = Math.round(0.75 * performance + 0.25 * placement);
    return {
      memberId: e.memberId,
      raw: e.raw,
      performance: round2(performance),
      placement: round2(placement),
      nightPoints,
    };
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

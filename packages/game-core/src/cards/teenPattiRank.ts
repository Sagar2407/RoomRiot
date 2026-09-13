/**
 * Teen Patti three-card hand ranking (plan §5.2), with A23_HIGH ace ordering:
 * A-2-3 is the highest sequence, then A-K-Q down to 2-3-4. Q-K-A ranks as A-K-Q;
 * K-A-2 is not a sequence.
 *
 * `evaluate3` returns a lexicographically-comparable tuple
 * `[category, ...tiebreakers]` where category is 6=trail, 5=pure sequence,
 * 4=sequence, 3=color(flush), 2=pair, 1=high card. `compare3(a,b) > 0` means a
 * beats b; `=== 0` is a genuine tie (which splits the pot).
 */
import { rankValue, suitOf } from './cards.js';

export function evaluate3(cards: string[]): number[] {
  const vals = cards.map(rankValue).sort((a, b) => b - a); // high → low
  const suits = cards.map(suitOf);
  const flush = suits.every((s) => s === suits[0]);

  let straightHigh = 0;
  if (vals[0]! - 1 === vals[1] && vals[1]! - 1 === vals[2]) straightHigh = vals[0]!; // A-K-Q … 2-3-4
  if (vals[0] === 14 && vals[1] === 3 && vals[2] === 2) straightHigh = 15; // A-2-3 is the top straight

  const trail = vals[0] === vals[1] && vals[1] === vals[2];
  const pair = !trail && (vals[0] === vals[1] || vals[1] === vals[2]);

  if (trail) return [6, vals[0]!];
  if (straightHigh && flush) return [5, straightHigh];
  if (straightHigh) return [4, straightHigh];
  if (flush) return [3, vals[0]!, vals[1]!, vals[2]!];
  if (pair) {
    const pairRank = vals[0] === vals[1] ? vals[0]! : vals[1]!;
    const kicker = vals[0] === vals[1] ? vals[2]! : vals[0]!;
    return [2, pairRank, kicker];
  }
  return [1, vals[0]!, vals[1]!, vals[2]!];
}

export function compare3(a: string[], b: string[]): number {
  const ea = evaluate3(a);
  const eb = evaluate3(b);
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) {
    const d = (ea[i] ?? 0) - (eb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const TEEN_PATTI_CATEGORY: Record<number, string> = {
  6: 'Trail',
  5: 'Pure sequence',
  4: 'Sequence',
  3: 'Colour',
  2: 'Pair',
  1: 'High card',
};

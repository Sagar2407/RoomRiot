/**
 * Snakes & Ladders board fixtures (plan §8).
 *
 * Original Room Riot layouts — not copied from any commercial board. Each board
 * is versioned and validated against these invariants (plan §8.1):
 *   - every jump origin/destination is within 1..size-1 (no jump off the finish);
 *   - origins are unique (object keys guarantee this);
 *   - no destination is itself an origin, so a single roll causes at most one jump;
 *   - the finish square is never a jump origin.
 * `reachOrExceed` distinguishes Quick (land on or past the final square finishes)
 * from Classic (exact finish; an overshoot leaves the token in place).
 */
export interface SnakeLadderBoard {
  id: string;
  version: string;
  /** The final square. A token at `size` has finished. */
  size: number;
  /** origin square → destination square (ladders go up, snakes go down). */
  jumps: Record<number, number>;
  /** true = reach-or-exceed `size` finishes (Quick); false = exact finish (Classic). */
  reachOrExceed: boolean;
}

/** Quick preset — Room Riot's 50-square warm-up board (plan §8.1 candidate layout). */
export const SNAKES_QUICK_50: SnakeLadderBoard = {
  id: 'snakes_quick_50',
  version: 'sl-quick-50-v1',
  size: 50,
  reachOrExceed: true,
  jumps: {
    // ladders (up)
    3: 14,
    9: 22,
    18: 31,
    27: 40,
    // snakes (down)
    23: 7,
    36: 20,
    44: 29,
    48: 35,
  },
};

/** Classic preset — an original 100-square board with an exact finish. */
export const SNAKES_CLASSIC_100: SnakeLadderBoard = {
  id: 'snakes_classic_100',
  version: 'sl-classic-100-v1',
  size: 100,
  reachOrExceed: false,
  jumps: {
    // ladders (up)
    4: 25,
    13: 46,
    33: 49,
    42: 63,
    50: 69,
    62: 81,
    74: 92,
    // snakes (down)
    27: 5,
    40: 3,
    43: 18,
    54: 31,
    66: 45,
    76: 58,
    89: 53,
    97: 75,
  },
};

export type SnakesPreset = 'quick' | 'classic';

export function boardForPreset(preset: SnakesPreset): SnakeLadderBoard {
  return preset === 'classic' ? SNAKES_CLASSIC_100 : SNAKES_QUICK_50;
}

/** Returns a list of validation errors (empty when the board is valid). */
export function validateBoard(b: SnakeLadderBoard): string[] {
  const errors: string[] = [];
  const origins = Object.keys(b.jumps).map(Number);
  const originSet = new Set(origins);
  for (const o of origins) {
    const d = b.jumps[o]!;
    if (o < 1 || o >= b.size) errors.push(`origin ${o} out of range 1..${b.size - 1}`);
    if (d < 1 || d >= b.size) errors.push(`destination ${d} (from ${o}) out of range 1..${b.size - 1}`);
    if (d === o) errors.push(`self-jump at ${o}`);
    if (originSet.has(d)) errors.push(`destination ${d} (from ${o}) is also an origin — would chain`);
  }
  if (originSet.has(b.size)) errors.push(`finish square ${b.size} is a jump origin`);
  return errors;
}

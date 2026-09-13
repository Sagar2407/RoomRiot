/**
 * Ludo board geometry (plan §7.2). One logical board; the client renders from it.
 *
 * - Shared outer track: 52 cells, indexed 0..51.
 * - Seat start offsets: color 0/1/2/3 start at 0/13/26/39.
 * - Personal progress 0..50 maps to (startOffset + progress) % 52 on the shared
 *   track; progress 51..55 are that color's five private home-lane cells; 56 is
 *   the final home. A token enters its private lane after personal progress 50.
 * - Safe outer cells (no capture): the four starts plus four stars.
 */
export const LUDO_TRACK = 52;
export const LUDO_HOME = 56;
export const LUDO_SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export function ludoStartOffset(color: number): number {
  return color * 13;
}

/** The shared-track cell for a token, or null when it's in the yard / home lane / home. */
export function ludoTrackCell(color: number, progress: number): number | null {
  if (progress < 0 || progress > 50) return null;
  return (ludoStartOffset(color) + progress) % LUDO_TRACK;
}

/** Color assignment: 2 seats take opposite corners; 3 and 4 take distinct corners. */
export function ludoColorsForSeats(n: number): number[] {
  if (n <= 2) return [0, 2];
  if (n === 3) return [0, 1, 2];
  return [0, 1, 2, 3];
}

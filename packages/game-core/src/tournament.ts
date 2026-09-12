/**
 * Night tournament aggregation (blueprint §6 "Attendance and fairness").
 *
 * Pure helper: given the members and each settled game's Night Points, build the
 * scoreboard. Official standings include only players with a valid result in every
 * counted (settled) game; others still see earned points, labelled partial.
 */
import type { GameType, ScoreLine } from '@roomriot/contracts';

export interface SettledGame {
  gameType: GameType;
  /** memberId → Night Points for members who had a valid result. */
  points: Record<string, number>;
}

export function buildScoreboard(
  members: Array<{ memberId: string; nickname: string }>,
  playlist: GameType[],
  settled: SettledGame[],
): ScoreLine[] {
  const settledByType = new Map<GameType, SettledGame>();
  for (const g of settled) settledByType.set(g.gameType, g);
  const countedTypes = playlist.filter((t) => settledByType.has(t));

  const lines = members.map((m) => {
    const perGame = playlist.map((gameType) => {
      const g = settledByType.get(gameType);
      const points = g ? (g.points[m.memberId] ?? null) : null;
      return { gameType, points };
    });
    const total = perGame.reduce((s, e) => s + (e.points ?? 0), 0);
    const official = countedTypes.every((t) => settledByType.get(t)!.points[m.memberId] !== undefined);
    return { memberId: m.memberId, nickname: m.nickname, perGame, total, official };
  });

  // Rank by total desc; ties keep insertion (seat) order.
  return lines.sort((a, b) => b.total - a.total);
}

'use client';
import type { RoomProjection } from '@roomriot/contracts';

export function Scoreboard({ projection, selfId }: { projection: RoomProjection; selfId?: string }) {
  const board = projection.scoreboard;
  if (board.length === 0) return null;
  const anyScores = board.some((l) => l.total > 0) || projection.playlistIndex > 0;
  if (!anyScores && projection.status === 'lobby') return null;

  return (
    <div className="card">
      <h2>Night standings</h2>
      <div className="small muted" style={{ marginBottom: 6 }}>
        Scoring {projection.scoringVersion} · 75% performance + 25% placement
      </div>
      {board.map((line, i) => (
        <div className="score-row" key={line.memberId}>
          <span className="rank">{i + 1}</span>
          <span>
            {line.nickname}
            {line.memberId === selfId ? ' (you)' : ''}
            {!line.official && projection.status === 'complete' ? <span className="pill grey" style={{ marginLeft: 8 }}>partial</span> : null}
          </span>
          <span className="pts">{line.total}</span>
        </div>
      ))}
    </div>
  );
}

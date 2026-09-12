'use client';
import type { RoomProjection } from '@roomriot/contracts';
import { Scoreboard } from './Scoreboard';

export function Results({ projection, selfId }: { projection: RoomProjection; selfId?: string }) {
  const awards = projection.awards ?? [];
  const champion = awards.find((a) => a.key === 'night_champion');
  const skill = awards.filter((a) => a.key !== 'night_champion');

  return (
    <div className="stack">
      <div className="hero center">
        <span className="eyebrow">Midnight Edition</span>
        <h1 style={{ fontSize: 32 }}>That’s a night.</h1>
        {champion && (
          <p style={{ color: '#fff' }}>
            🏆 Night Champion: <strong>{champion.nickname ?? '—'}</strong>
            <br />
            <span className="small">{champion.detail}</span>
          </p>
        )}
      </div>

      <Scoreboard projection={projection} selfId={selfId} />

      {skill.length > 0 && (
        <div className="card stack">
          <h2>Awards</h2>
          {skill.map((a) => (
            <div key={a.key} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>
                <strong>{a.title}</strong> — {a.nickname ?? '—'}
              </span>
              <span className="small muted">{a.detail}</span>
            </div>
          ))}
        </div>
      )}

      <a className="btn ghost" href="/" style={{ textAlign: 'center', textDecoration: 'none' }}>
        Play again with this crew
      </a>
      <p className="small muted center">
        No photos, recordings, or publishing. Your recap stays private to the room.
      </p>
    </div>
  );
}

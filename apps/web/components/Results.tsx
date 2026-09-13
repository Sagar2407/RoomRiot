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

      {projection.billingEnabled && projection.tier !== 'party_pass' && (
        <div className="card stack center">
          <strong>Enjoyed the night?</strong>
          <p className="muted small" style={{ margin: 0 }}>
            A Party Pass unlocks all six games for your next 24 hours of hosting. Guests always play free.
          </p>
          <a className="btn" href="/host" style={{ textDecoration: 'none' }}>
            See the Party Pass
          </a>
        </div>
      )}

      <a className="btn ghost" href="/host" style={{ textAlign: 'center', textDecoration: 'none' }}>
        Play again with this crew
      </a>
      <p className="small muted center">
        No photos, recordings, or publishing. Your recap stays private to the room. · <a href="/support">Support</a>
      </p>
    </div>
  );
}

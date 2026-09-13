'use client';
import { useState } from 'react';
import type { RoomProjection, ClientAction, ActionResult } from '@roomriot/contracts';
import { Scoreboard } from './Scoreboard';

type Send = (a: Omit<ClientAction, 'actionId'>) => Promise<ActionResult>;

export function Results({
  projection,
  selfId,
  isHost,
  send,
}: {
  projection: RoomProjection;
  selfId?: string;
  isHost?: boolean;
  send?: Send;
}) {
  const awards = projection.awards ?? [];
  const champion = awards.find((a) => a.key === 'night_champion');
  const skill = awards.filter((a) => a.key !== 'night_champion');
  const [copied, setCopied] = useState(false);

  function copyRecap() {
    const lines: string[] = ['Room Riot — night recap'];
    if (champion) lines.push(`🏆 Champion: ${champion.nickname ?? '—'} (${champion.detail})`);
    lines.push('', 'Scores:');
    projection.scoreboard.forEach((l, i) => lines.push(`${i + 1}. ${l.nickname} — ${l.total}${l.official ? '' : ' (partial)'}`));
    if (skill.length) {
      lines.push('', 'Awards:');
      for (const a of skill) lines.push(`• ${a.title}: ${a.nickname ?? '—'} — ${a.detail}`);
    }
    const text = lines.join('\n');
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {
        /* clipboard unavailable — no-op */
      });
  }

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

      {/* Play again with the same crew — a fresh night in this same room. */}
      <div className="card stack center">
        {isHost && send ? (
          <>
            <strong>Play again with this crew?</strong>
            <p className="muted small" style={{ margin: 0 }}>
              Same room and players, a brand-new night with fresh deals.
            </p>
            <button className="btn orange" onClick={() => send({ type: 'rematch' })}>
              Rematch
            </button>
          </>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>Waiting for the host to start a rematch…</p>
        )}
        <button className="btn ghost small" onClick={copyRecap}>
          {copied ? 'Recap copied!' : 'Copy recap'}
        </button>
      </div>

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

      <p className="small muted center">
        No photos, recordings, or publishing. Your recap stays private to the room. · <a href="/support">Support</a>
      </p>
    </div>
  );
}

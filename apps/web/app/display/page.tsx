'use client';
import { useEffect, useState } from 'react';
import { useRoom } from '../../lib/useRoom';
import { GameView } from '../../components/GameView';
import { Scoreboard } from '../../components/Scoreboard';
import { Results } from '../../components/Results';
import { Members } from '../../components/Members';

/**
 * The shared board for a TV or laptop. It authenticates with a read-only display
 * token and renders only public information — its projection carries no `self`
 * overlay and no secrets (blueprint §3, §8).
 */
export default function DisplayPage() {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get('token'));
  }, []);

  const { projection, connected, error } = useRoom(token ? { displayToken: token } : null);

  if (!token)
    return (
      <main className="wrap">
        <div className="error">Missing display token. Create the board link from the host’s device.</div>
      </main>
    );
  if (!projection)
    return (
      <main className="wrap">
        <div className="card">{error ?? 'Connecting to the room…'}</div>
      </main>
    );

  const noop = async () => ({ actionId: '', accepted: false as const, sequence: 0 });

  return (
    <main className="wrap stack">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="brand">
          ROOM <em>RIOT</em>
        </div>
        <span className={`pill ${connected ? '' : 'grey'}`}>Room {projection.code}</span>
      </div>

      {projection.status === 'lobby' && (
        <div className="stack">
          <div className="card center stack">
            <span className="eyebrow">Join at the room code</span>
            <div className="big-code">{projection.code}</div>
          </div>
          <div className="card">
            <h2>Players</h2>
            <Members projection={projection} />
          </div>
        </div>
      )}

      {projection.status === 'in_game' && <GameView projection={projection} send={noop} board />}

      {(projection.status === 'intermission' || projection.status === 'complete') &&
        (projection.status === 'complete' ? (
          <Results projection={projection} />
        ) : (
          <Scoreboard projection={projection} />
        ))}
    </main>
  );
}

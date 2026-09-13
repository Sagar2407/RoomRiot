'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MembershipCredentials } from '@roomriot/contracts';
import { useRoom } from '../../lib/useRoom';
import { loadCreds, clearCreds } from '../../lib/storage';
import { Lobby } from '../../components/Lobby';
import { GameView } from '../../components/GameView';
import { Results } from '../../components/Results';
import { Scoreboard } from '../../components/Scoreboard';
import { ReportButton } from '../../components/ReportButton';

export default function RoomPage() {
  const router = useRouter();
  const [creds, setCreds] = useState<MembershipCredentials | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const c = loadCreds();
    setCreds(c);
    setReady(true);
  }, []);

  const { projection, connected, error, send } = useRoom(creds ? { memberToken: creds.memberToken } : null);

  if (ready && !creds) {
    return (
      <main className="wrap stack">
        <div className="card stack">
          <h2>No room yet</h2>
          <p className="muted">Host a night or join a room to get started.</p>
          <a className="btn" href="/" style={{ textAlign: 'center', textDecoration: 'none' }}>
            Go home
          </a>
        </div>
      </main>
    );
  }

  if (!projection) {
    return (
      <main className="wrap stack">
        <div className="brand">
          ROOM <em>RIOT</em>
        </div>
        <div className="card">{error ? <span className="error">{error}</span> : 'Connecting…'}</div>
      </main>
    );
  }

  const isHost = projection.hostMemberId === creds?.memberId;
  const selfId = creds?.memberId;

  return (
    <main className="wrap stack">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="brand">
          ROOM <em>RIOT</em>
        </div>
        <span className={`pill ${connected ? '' : 'grey'}`}>{connected ? 'Live' : 'Reconnecting…'}</span>
      </div>

      {error && <div className="error">{error}</div>}

      {projection.status === 'lobby' && creds && (
        <Lobby projection={projection} isHost={isHost} memberToken={creds.memberToken} send={send} />
      )}

      {projection.status === 'in_game' && (
        <>
          <GameView projection={projection} send={send} />
          <ReportButton send={send} />
        </>
      )}

      {projection.status === 'intermission' && (
        <div className="stack">
          <div className="card center stack">
            <span className="eyebrow">Between games</span>
            <h2>Nice round.</h2>
            {isHost ? (
              <button className="btn orange" onClick={() => send({ type: 'next' })}>
                Next game
              </button>
            ) : (
              <p className="muted">Waiting for the host to start the next game…</p>
            )}
          </div>
          <Scoreboard projection={projection} selfId={selfId} />
        </div>
      )}

      {projection.status === 'complete' && <Results projection={projection} selfId={selfId} isHost={isHost} send={send} />}

      {projection.status !== 'complete' && projection.status !== 'lobby' && (
        <button
          className="btn ghost small"
          style={{ alignSelf: 'center' }}
          onClick={() => {
            clearCreds();
            router.push('/');
          }}
        >
          Leave room
        </button>
      )}
    </main>
  );
}

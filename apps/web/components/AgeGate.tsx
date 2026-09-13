'use client';
import { useEffect, useState } from 'react';

const KEY = 'roomriot.ageConfirmed';

/**
 * A one-time adults-only confirmation (blueprint §3, §12). This is a stated
 * product boundary, not age verification — a checkbox can't prove age. The choice
 * is remembered per browser so returning players aren't re-prompted.
 */
export function AgeGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'ask' | 'ok' | 'declined'>('loading');

  useEffect(() => {
    try {
      setState(localStorage.getItem(KEY) === '1' ? 'ok' : 'ask');
    } catch {
      setState('ask');
    }
  }, []);

  if (state === 'loading') return null;
  if (state === 'ok') return <>{children}</>;

  if (state === 'declined') {
    return (
      <div className="card stack">
        <h2>Come back another time</h2>
        <p className="muted" style={{ margin: 0 }}>
          Room Riot is a party game for adults (21+). Thanks for stopping by!
        </p>
      </div>
    );
  }

  return (
    <div className="card stack">
      <h2>Adults only (21+)</h2>
      <p className="muted" style={{ margin: 0 }}>
        Room Riot is a party game for adults. Please confirm you’re 21 or older. Drinking is always optional — the games work
        great with water or no drink at all.
      </p>
      <button
        className="btn orange"
        onClick={() => {
          try {
            localStorage.setItem(KEY, '1');
          } catch {
            /* ignore */
          }
          setState('ok');
        }}
      >
        I’m 21 or older
      </button>
      <button className="btn ghost" onClick={() => setState('declined')}>
        I’m under 21
      </button>
    </div>
  );
}

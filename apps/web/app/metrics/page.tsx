'use client';
import { useEffect, useState } from 'react';
import { SERVER_URL } from '../../lib/config';

interface Funnel {
  generatedAt: string;
  counts: Record<string, number>;
  rates_pct: Record<string, number | null>;
  targets: Record<string, string>;
}

/**
 * A lightweight operations view of the §16 funnel. Aggregate counts only — the
 * server's /metrics endpoint never exposes per-user data.
 */
export default function MetricsPage() {
  const [data, setData] = useState<Funnel | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`${SERVER_URL}/metrics`);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="wrap stack">
      <div className="brand">
        ROOM <em>RIOT</em>
      </div>
      <div className="card stack">
        <h2>Beta funnel</h2>
        <p className="small muted">Blueprint §16 — completed group nights whose hosts return is the north-star measure. Refreshes every 5s.</p>
        {error && <div className="error">{error}</div>}
        {!data && !error && <p className="muted">Loading…</p>}
        {data && (
          <>
            <div>
              {Object.entries(data.counts).map(([k, v]) => (
                <div className="score-row" key={k}>
                  <span />
                  <span>{k.replace(/_/g, ' ')}</span>
                  <span className="pts">{v}</span>
                </div>
              ))}
            </div>
            <h2 style={{ marginTop: 8 }}>Rates vs. targets</h2>
            {Object.entries(data.rates_pct).map(([k, v]) => (
              <div className="score-row" key={k}>
                <span />
                <span>
                  {k.replace(/_/g, ' ')}
                  <span className="small muted" style={{ marginLeft: 8 }}>target {data.targets[k] ?? '—'}</span>
                </span>
                <span className="pts">{v === null ? '—' : `${v}%`}</span>
              </div>
            ))}
            <p className="small muted">Generated {new Date(data.generatedAt).toLocaleTimeString()}</p>
          </>
        )}
      </div>
    </main>
  );
}

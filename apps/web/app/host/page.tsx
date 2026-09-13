'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { EntitlementStatus, GameType } from '@roomriot/contracts';
import { GAME_FAMILY } from '@roomriot/contracts';
import { hostRoom, getEntitlements, devCheckout } from '../../lib/api';
import { saveCreds } from '../../lib/storage';

const TITLES: Record<GameType, string> = {
  majority_report: 'Majority Report',
  bluff_bureau: 'Bluff Bureau',
  caption_court: 'Caption Court',
  link_up: 'Link Up',
  alibi_club: 'Alibi Club',
  close_call: 'Close Call',
};

export default function HostSetup() {
  const router = useRouter();
  const [nickname, setNickname] = useState('');
  const [ent, setEnt] = useState<EntitlementStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEntitlements()
      .then(setEnt)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load offer'));
  }, []);

  const isPass = ent?.tier === 'party_pass';

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      setEnt(await devCheckout());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      // The server resolves the actual playlist from the host's entitlement; a
      // free night becomes the rotating trio, a Party Pass keeps all six.
      const creds = await hostRoom(nickname.trim());
      saveCreds(creds);
      router.push('/room');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create room');
      setBusy(false);
    }
  }

  return (
    <main className="wrap stack">
      <div className="brand">
        ROOM <em>RIOT</em>
      </div>

      <div className="card stack">
        <h2>Host a night</h2>
        <label className="field">
          Your nickname
          <input value={nickname} maxLength={24} onChange={(e) => setNickname(e.target.value)} placeholder="e.g. Sagar" />
        </label>
        <button className="btn orange" disabled={busy || !nickname.trim()} onClick={start}>
          {busy ? 'Starting…' : isPass ? 'Start the full night (6 games)' : 'Start a free night (3 games)'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {ent && (
        <div className="card stack">
          {isPass ? (
            <>
              <div className="pill">Party Pass active</div>
              <p className="muted" style={{ margin: 0 }}>
                All six launch games are unlocked{ent.partyPass ? ` until ${new Date(ent.partyPass.validUntil).toLocaleString()}` : ''}.
              </p>
              <div className="stack" style={{ gap: 4 }}>
                {(Object.keys(TITLES) as GameType[]).map((g) => (
                  <div key={g} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{TITLES[g]}</span>
                    <span className="pill grey">{GAME_FAMILY[g]}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="pill grey">Free night · tonight’s rotating trio</div>
              <div className="stack" style={{ gap: 4 }}>
                {ent.freeGames.map((g) => (
                  <div key={g} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{TITLES[g]}</span>
                    <span className="pill grey">{GAME_FAMILY[g]}</span>
                  </div>
                ))}
              </div>
              <hr style={{ border: 0, borderTop: '1px solid var(--line)', width: '100%' }} />
              <h2 style={{ margin: 0 }}>{ent.offer.label} — ${ent.offer.priceUsd.toFixed(2)}</h2>
              <p className="muted" style={{ margin: 0 }}>
                {ent.offer.unlocks} Guests always join free.
              </p>
              <button className="btn" disabled={busy} onClick={unlock}>
                {busy ? 'Unlocking…' : `Unlock all six games (24h)`}
              </button>
              <p className="small muted" style={{ margin: 0 }}>
                Dev checkout — simulates a completed purchase. Real Stripe drops in behind the same webhook.
              </p>
            </>
          )}
        </div>
      )}

      <a className="btn ghost small" href="/" style={{ alignSelf: 'center', textDecoration: 'none' }}>
        Back
      </a>
    </main>
  );
}

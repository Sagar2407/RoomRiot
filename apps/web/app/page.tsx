'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MembershipCredentials } from '@roomriot/contracts';
import { hostRoom, joinRoom, startPractice } from '../lib/api';
import { saveCreds } from '../lib/storage';

type Mode = 'home' | 'host' | 'join';

export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('home');
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(fn: () => Promise<MembershipCredentials>) {
    setBusy(true);
    setError(null);
    try {
      const creds = await fn();
      saveCreds(creds);
      router.push('/room');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap stack">
      <div className="brand">
        ROOM <em>RIOT</em>
      </div>

      <header className="hero">
        <span className="eyebrow">A web-first party game</span>
        <h1>
          Turn a gathering into a <span>great story.</span>
        </h1>
        <p>Private rooms. Unexpected games. Friendly rivalries. Scan in, pick a vibe, play a night worth repeating.</p>
      </header>

      {error && <div className="error">{error}</div>}

      {mode === 'home' && (
        <div className="stack">
          <button className="btn orange" onClick={() => setMode('host')}>
            Host a night
          </button>
          <button className="btn" onClick={() => setMode('join')}>
            Join a room
          </button>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() => go(() => startPractice('You'))}
          >
            Try a 1-minute practice round
          </button>
          <p className="muted small center">
            Adults · 4–10 players · drinks optional. The competition rewards how you play, not what you drink.
          </p>
        </div>
      )}

      {mode === 'host' && (
        <div className="card stack">
          <h2>Host a night</h2>
          <label className="field">
            Your nickname
            <input value={nickname} maxLength={24} onChange={(e) => setNickname(e.target.value)} placeholder="e.g. Sagar" />
          </label>
          <button className="btn orange" disabled={busy || !nickname.trim()} onClick={() => go(() => hostRoom(nickname.trim()))}>
            {busy ? 'Creating…' : 'Create room'}
          </button>
          <button className="btn ghost small" onClick={() => setMode('home')}>
            Back
          </button>
        </div>
      )}

      {mode === 'join' && (
        <div className="card stack">
          <h2>Join a room</h2>
          <label className="field">
            Room code
            <input
              className="code-input"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              placeholder="ABCDEF"
            />
          </label>
          <label className="field">
            Your nickname
            <input value={nickname} maxLength={24} onChange={(e) => setNickname(e.target.value)} placeholder="e.g. Maya" />
          </label>
          <button
            className="btn"
            disabled={busy || code.length < 4 || !nickname.trim()}
            onClick={() => go(() => joinRoom(code, nickname.trim()))}
          >
            {busy ? 'Joining…' : 'Join'}
          </button>
          <button className="btn ghost small" onClick={() => setMode('home')}>
            Back
          </button>
        </div>
      )}
    </main>
  );
}

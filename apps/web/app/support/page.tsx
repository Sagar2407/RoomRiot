'use client';
import { useState } from 'react';
import { sendSupport } from '../../lib/api';

export default function SupportPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await sendSupport(message.trim(), email.trim() || undefined);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap stack">
      <div className="brand">
        ROOM <em>RIOT</em>
      </div>
      <div className="card stack">
        <h2>Contact support</h2>
        {done ? (
          <p className="muted" role="status">
            Thanks — we’ve logged your message. If you left an email, we’ll follow up.
          </p>
        ) : (
          <>
            <label className="field">
              Email (optional)
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <label className="field">
              How can we help?
              <textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Describe the issue…" />
            </label>
            {error && <div className="error">{error}</div>}
            <button className="btn orange" disabled={busy || message.trim().length === 0} onClick={submit}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </>
        )}
      </div>
      <a className="btn ghost small" href="/" style={{ alignSelf: 'center', textDecoration: 'none' }}>
        Back
      </a>
    </main>
  );
}

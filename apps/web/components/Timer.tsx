'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Countdown derived from the server's absolute deadline (blueprint §10: clients
 * never own an authoritative timer — this is display only).
 */
export function Timer({ deadlineAt }: { deadlineAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  const fullRef = useRef<number>(0);
  const lastDeadline = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (!deadlineAt) return null;
  if (lastDeadline.current !== deadlineAt) {
    lastDeadline.current = deadlineAt;
    fullRef.current = Math.max(1, deadlineAt - Date.now());
  }
  const remaining = Math.max(0, deadlineAt - now);
  const pct = Math.max(0, Math.min(100, (remaining / fullRef.current) * 100));
  const secs = Math.ceil(remaining / 1000);

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="timer">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="small muted" style={{ textAlign: 'right' }}>
        {secs}s
      </div>
    </div>
  );
}

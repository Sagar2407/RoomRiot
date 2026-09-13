'use client';
import { useState } from 'react';
import type { ClientAction, ActionResult } from '@roomriot/contracts';

type Send = (a: Omit<ClientAction, 'actionId'>) => Promise<ActionResult>;

const REASONS = ['Inappropriate content', 'Harassment or bullying', 'Broken or confusing prompt', 'Other'];

/**
 * Always within easy reach during a game (blueprint §7, §12). Sends a scoped,
 * private report to moderation; nothing is surfaced to the room.
 */
export function ReportButton({ send }: { send: Send }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);

  async function report(reason: string) {
    await send({ type: 'report_content', payload: { reason } });
    setDone(true);
    setOpen(false);
    setTimeout(() => setDone(false), 2500);
  }

  if (done)
    return (
      <p className="small muted center" role="status">
        Thanks — reported privately to moderation.
      </p>
    );

  return (
    <div className="center">
      {!open ? (
        <button className="btn ghost small" onClick={() => setOpen(true)} aria-haspopup="true">
          Report this content
        </button>
      ) : (
        <div className="card stack" style={{ textAlign: 'left' }}>
          <strong className="small">Report the current prompt</strong>
          <div className="options">
            {REASONS.map((r) => (
              <button key={r} className="opt" onClick={() => report(r)}>
                {r}
              </button>
            ))}
          </div>
          <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

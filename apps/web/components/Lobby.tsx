'use client';
import { useState } from 'react';
import type { RoomProjection, ClientAction, ActionResult, GameType } from '@roomriot/contracts';
import { GAME_FAMILY } from '@roomriot/contracts';
import { Members } from './Members';
import { requestDisplayToken } from '../lib/api';
import { SERVER_URL } from '../lib/config';

const TITLES: Record<GameType, string> = {
  majority_report: 'Majority Report',
  bluff_bureau: 'Bluff Bureau',
  caption_court: 'Caption Court',
  link_up: 'Link Up',
  alibi_club: 'Alibi Club',
  close_call: 'Close Call',
};

export function Lobby({
  projection,
  isHost,
  memberToken,
  send,
}: {
  projection: RoomProjection;
  isHost: boolean;
  memberToken: string;
  send: (a: Omit<ClientAction, 'actionId'>) => Promise<ActionResult>;
}) {
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function makeDisplay() {
    try {
      const token = await requestDisplayToken(projection.roomId, memberToken);
      const url = `${location.origin}/display?token=${encodeURIComponent(token)}`;
      setDisplayUrl(url);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="stack">
      <div className="card center stack">
        <span className="eyebrow">Room code</span>
        <div className="big-code">{projection.code}</div>
        <button
          className="btn ghost small"
          style={{ margin: '0 auto' }}
          onClick={() => {
            navigator.clipboard?.writeText(projection.code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied!' : 'Copy code'}
        </button>
        <p className="small muted">Friends open the app, tap “Join a room”, and enter this code.</p>
      </div>

      <div className="card stack">
        <h2>Who’s here</h2>
        <Members projection={projection} />
      </div>

      <div className="card stack">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>Tonight’s playlist</h2>
          <span className={`pill ${projection.tier === 'party_pass' ? '' : 'grey'}`}>
            {projection.tier === 'party_pass' ? 'Party Pass' : 'Free night'}
          </span>
        </div>
        {projection.playlist.map((g) => (
          <div key={g} style={{ display: 'flex', justifyContent: 'space-between' }}>
            <strong>{TITLES[g]}</strong>
            <span className="pill grey">{GAME_FAMILY[g]}</span>
          </div>
        ))}
      </div>

      {isHost ? (
        <div className="card stack">
          <h2>Host controls</h2>
          <button className="btn orange" onClick={() => send({ type: 'start_night' })}>
            Start the night
          </button>
          <div className="btn-row">
            <button className="btn ghost small" onClick={() => send({ type: 'add_bot' })}>
              + Add a fictional player
            </button>
            <button className="btn ghost small" onClick={makeDisplay}>
              Create TV / laptop board
            </button>
          </div>
          {displayUrl && (
            <div className="notice small" style={{ overflowWrap: 'anywhere' }}>
              Open this on a shared screen (read-only, no secrets): <br />
              <a href={displayUrl} target="_blank" rel="noreferrer">
                {displayUrl}
              </a>
            </div>
          )}
          <p className="small muted">
            You can play from this same device. Fictional players help you try a full night solo.
          </p>
        </div>
      ) : (
        <div className="notice">Waiting for the host to start the night…</div>
      )}

      <p className="small muted center">Server: {SERVER_URL}</p>
    </div>
  );
}

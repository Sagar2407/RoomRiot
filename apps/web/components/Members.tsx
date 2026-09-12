'use client';
import type { RoomProjection } from '@roomriot/contracts';

export function Members({ projection }: { projection: RoomProjection }) {
  const inGame = projection.status === 'in_game';
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small muted">
        {projection.members.length} in the room
        {inGame ? ` · ${projection.members.filter((m) => m.submitted).length} submitted` : ''}
      </div>
      <div className="members">
        {projection.members.map((m) => {
          const state = inGame && m.submitted ? 'done' : m.connected ? 'on' : '';
          return (
            <span className="member" key={m.memberId}>
              <span className={`dot ${state}`} />
              {m.nickname}
              {m.memberId === projection.hostMemberId ? ' ★' : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

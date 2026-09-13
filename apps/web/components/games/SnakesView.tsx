'use client';
import { useMemo } from 'react';
import type { RoomProjection, ClientAction, ActionResult } from '@roomriot/contracts';

type Send = (a: Omit<ClientAction, 'actionId'>) => Promise<ActionResult>;

interface SnakesPrompt {
  preset: string;
  size: number;
  jumps: Record<string, number>;
  reachOrExceed: boolean;
  seatOrder: string[];
  activeMemberId: string | null;
  positions: Record<string, number>;
  finishedOrder: string[];
  lastRoll: {
    memberId: string;
    die: number;
    from: number;
    to: number;
    jumpedFrom: number | null;
    jumpedTo: number | null;
    auto: boolean;
  } | null;
  turnResolved: boolean;
}

const SEAT_COLORS = ['#e07a5f', '#3d8361', '#5b7db1', '#c9a227', '#8f5bb1', '#3aa6a0', '#b1563a', '#6b8e23', '#a03d6e', '#4a6fa5'];

export function SnakesView({ projection, send, board }: { projection: RoomProjection; send: Send; board?: boolean }) {
  const game = projection.game!;
  const p = game.prompt as unknown as SnakesPrompt;
  const complete = projection.status === 'complete' || game.phaseKind === 'complete';
  const me = projection.self?.memberId;

  const nameOf = useMemo(() => {
    const map = new Map(projection.members.map((m) => [m.memberId, m.nickname]));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? '—') : '—');
  }, [projection.members]);

  const colorOf = useMemo(() => {
    const map = new Map(p.seatOrder.map((id, i) => [id, SEAT_COLORS[i % SEAT_COLORS.length]!]));
    return (id: string) => map.get(id) ?? '#888';
  }, [p.seatOrder]);

  const isMyTurn = !complete && p.activeMemberId === me && !p.turnResolved;

  async function roll() {
    await send({ type: 'roll', gameId: projection.gameId ?? undefined, phaseId: projection.phaseId ?? undefined });
  }

  // Board rows, bottom (1) to top, boustrophedon like a physical board.
  const rows = useMemo(() => {
    const rowCount = Math.ceil(p.size / 10);
    const out: number[][] = [];
    for (let r = rowCount - 1; r >= 0; r--) {
      const nums: number[] = [];
      for (let c = 1; c <= 10; c++) {
        const n = r * 10 + c;
        if (n <= p.size) nums.push(n);
      }
      if (r % 2 === 1) nums.reverse();
      out.push(nums);
    }
    return out;
  }, [p.size]);

  const tokensAt = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const id of p.seatOrder) {
      const pos = p.positions[id] ?? 0;
      if (!map.has(pos)) map.set(pos, []);
      map.get(pos)!.push(id);
    }
    return map;
  }, [p.positions, p.seatOrder]);

  const jumpBadge = (n: number) => {
    const dest = p.jumps[String(n)];
    if (dest === undefined) return null;
    const up = dest > n;
    return (
      <span
        title={`${up ? 'Ladder' : 'Snake'} → ${dest}`}
        style={{ position: 'absolute', top: 1, right: 2, fontSize: 8, color: up ? 'var(--good, #2f9e44)' : '#c0392b', fontWeight: 700 }}
      >
        {up ? `▲${dest}` : `▼${dest}`}
      </span>
    );
  };

  const chips = (ids: string[]) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 1, justifyContent: 'center' }}>
      {ids.map((id) => (
        <span
          key={id}
          title={nameOf(id)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 13,
            height: 13,
            borderRadius: '50%',
            background: colorOf(id),
            color: '#fff',
            fontSize: 8,
            fontWeight: 700,
            border: id === me ? '1.5px solid #111' : 'none',
          }}
        >
          {nameOf(id).charAt(0).toUpperCase()}
        </span>
      ))}
    </div>
  );

  const startTray = tokensAt.get(0) ?? [];

  return (
    <div className="stack">
      {/* Turn banner */}
      <div className="card stack" style={{ gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <strong>Snakes &amp; Ladders</strong>
          <span className="small muted">{p.preset === 'classic' ? 'Classic · exact 100' : 'Quick · first to 50'}</span>
        </div>
        {complete ? (
          <div className="pill">🏆 {nameOf(p.finishedOrder[0] ?? null)} wins!</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{ width: 12, height: 12, borderRadius: '50%', background: colorOf(p.activeMemberId ?? '') }}
            />
            <span className="small">
              {p.activeMemberId === me ? 'Your turn' : `${nameOf(p.activeMemberId)}’s turn`}
            </span>
          </div>
        )}
        {p.lastRoll && (
          <div className="small muted">
            {nameOf(p.lastRoll.memberId)} rolled a <strong>{p.lastRoll.die}</strong>
            {p.lastRoll.jumpedTo !== null
              ? p.lastRoll.jumpedTo > (p.lastRoll.jumpedFrom ?? 0)
                ? ` — climbed to ${p.lastRoll.to}! 🪜`
                : ` — snaked down to ${p.lastRoll.to} 🐍`
              : ` → ${p.lastRoll.to}`}
            {p.lastRoll.auto ? ' (auto)' : ''}
          </div>
        )}
      </div>

      {/* Board */}
      <div className="card" style={{ overflowX: 'auto', padding: 8 }}>
        <div style={{ display: 'grid', gridTemplateRows: `repeat(${rows.length}, 1fr)`, gap: 2, minWidth: 300 }}>
          {rows.map((rowNums, ri) => (
            <div key={ri} style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 2 }}>
              {rowNums.map((n) => {
                const here = tokensAt.get(n) ?? [];
                const isFinish = n === p.size;
                return (
                  <div
                    key={n}
                    style={{
                      position: 'relative',
                      aspectRatio: '1',
                      borderRadius: 4,
                      background: isFinish ? '#111' : (n % 2 === 0 ? 'var(--line, #efeae0)' : 'transparent'),
                      border: '1px solid var(--line, #e6e0d4)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minHeight: 26,
                    }}
                  >
                    <span style={{ position: 'absolute', top: 1, left: 2, fontSize: 8, color: isFinish ? '#fff' : '#999' }}>{n}</span>
                    {jumpBadge(n)}
                    {here.length > 0 && <div style={{ marginTop: 6 }}>{chips(here)}</div>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {startTray.length > 0 && (
          <div className="small muted" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            Start: {chips(startTray)}
          </div>
        )}
      </div>

      {/* Roll control (players only) */}
      {!board && !complete && (
        <div className="card stack">
          {isMyTurn ? (
            <button className="btn orange" onClick={roll}>
              🎲 Roll the dice
            </button>
          ) : (
            <p className="muted center" style={{ margin: 0 }}>
              Waiting for {nameOf(p.activeMemberId)}…
            </p>
          )}
        </div>
      )}

      {/* Recap */}
      {complete && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Final standings</h2>
          {[...p.seatOrder]
            .sort((a, b) => {
              const fa = p.finishedOrder.indexOf(a);
              const fb = p.finishedOrder.indexOf(b);
              if (fa !== -1 && fb !== -1) return fa - fb;
              if (fa !== -1) return -1;
              if (fb !== -1) return 1;
              return (p.positions[b] ?? 0) - (p.positions[a] ?? 0);
            })
            .map((id, i) => (
              <div key={id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>
                  {i + 1}. {nameOf(id)}
                  {id === me ? ' (you)' : ''}
                </span>
                <span className="small muted">{p.finishedOrder.includes(id) ? 'Finished' : `Square ${p.positions[id] ?? 0}`}</span>
              </div>
            ))}
          {projection.awards && projection.awards.filter((a) => a.key !== 'night_champion').length > 0 && (
            <div className="stack" style={{ gap: 4, marginTop: 4 }}>
              {projection.awards
                .filter((a) => a.key !== 'night_champion')
                .map((a) => (
                  <div key={a.key} className="small">
                    <strong>{a.title}:</strong> {a.nickname ?? nameOf(a.memberId)} — {a.detail}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

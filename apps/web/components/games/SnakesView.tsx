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

const SEAT_COLORS = ['#e0564b', '#3d8361', '#4f74c9', '#e0a92e', '#8f5bb1', '#3aa6a0', '#b1563a', '#6b8e23', '#a03d6e', '#4a6fa5'];

export function SnakesView({ projection, send, board }: { projection: RoomProjection; send: Send; board?: boolean }) {
  const game = projection.game!;
  const p = game.prompt as unknown as SnakesPrompt;
  const complete = projection.status === 'complete' || game.phaseKind === 'complete';
  const me = projection.self?.memberId;
  const cols = 10;
  const rows = Math.ceil(p.size / cols);

  const nameOf = useMemo(() => {
    const map = new Map(projection.members.map((m) => [m.memberId, m.nickname]));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? '—') : '—');
  }, [projection.members]);
  const colorOf = useMemo(() => {
    const map = new Map(p.seatOrder.map((id, i) => [id, SEAT_COLORS[i % SEAT_COLORS.length]!]));
    return (id: string) => map.get(id) ?? '#888';
  }, [p.seatOrder]);

  const isMyTurn = !complete && p.activeMemberId === me && !p.turnResolved;
  const roll = () => send({ type: 'roll', gameId: projection.gameId ?? undefined, phaseId: projection.phaseId ?? undefined });

  // Boustrophedon cell centre for a square number (1 at bottom-left).
  const centre = (n: number): [number, number] => {
    const rb = Math.floor((n - 1) / cols); // row from bottom
    const idx = (n - 1) % cols;
    const col = rb % 2 === 0 ? idx : cols - 1 - idx;
    return [col + 0.5, rows - 1 - rb + 0.5];
  };

  // Tokens on the board (position 1..size), spread when they share a square.
  const boardTokens = useMemo(() => {
    const list: { id: string; pos: number; x: number; y: number }[] = [];
    for (const id of p.seatOrder) {
      const pos = p.positions[id] ?? 0;
      if (pos < 1) continue;
      const [x, y] = centre(pos);
      list.push({ id, pos, x, y });
    }
    const byCell = new Map<number, typeof list>();
    for (const t of list) {
      if (!byCell.has(t.pos)) byCell.set(t.pos, []);
      byCell.get(t.pos)!.push(t);
    }
    for (const g of byCell.values()) if (g.length > 1) g.forEach((t, i) => (t.x += (i - (g.length - 1) / 2) * 0.34));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.positions, p.seatOrder, p.size]);

  const startTray = p.seatOrder.filter((id) => (p.positions[id] ?? 0) < 1);

  // Ladder rails + rungs.
  function Ladder({ from, to, k }: { from: number; to: number; k: string }) {
    const [x1, y1] = centre(from);
    const [x2, y2] = centre(to);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 0.14;
    const ny = (dx / len) * 0.14;
    const rungs = Math.max(2, Math.round(len));
    return (
      <g key={k} stroke="#2f9e5f" strokeWidth={0.06} strokeLinecap="round">
        <line x1={x1 + nx} y1={y1 + ny} x2={x2 + nx} y2={y2 + ny} />
        <line x1={x1 - nx} y1={y1 - ny} x2={x2 - nx} y2={y2 - ny} />
        {Array.from({ length: rungs - 1 }, (_, i) => {
          const t = (i + 1) / rungs;
          const cx = x1 + dx * t;
          const cy = y1 + dy * t;
          return <line key={i} x1={cx + nx} y1={cy + ny} x2={cx - nx} y2={cy - ny} strokeWidth={0.045} />;
        })}
      </g>
    );
  }
  // Snake as a wavy body with a head at the origin (top of the snake).
  function Snake({ from, to, k }: { from: number; to: number; k: string }) {
    const [x1, y1] = centre(from);
    const [x2, y2] = centre(to);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 0.5;
    const ny = (dx / len) * 0.5;
    const c1x = x1 + dx * 0.33 + nx;
    const c1y = y1 + dy * 0.33 + ny;
    const c2x = x1 + dx * 0.66 - nx;
    const c2y = y1 + dy * 0.66 - ny;
    return (
      <g key={k}>
        <path d={`M ${x1} ${y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`} fill="none" stroke="#c0392b" strokeWidth={0.28} strokeLinecap="round" opacity={0.85} />
        <circle cx={x1} cy={y1} r={0.26} fill="#c0392b" />
        <circle cx={x1 - 0.09} cy={y1 - 0.05} r={0.05} fill="#fff" />
        <circle cx={x1 + 0.09} cy={y1 - 0.05} r={0.05} fill="#fff" />
      </g>
    );
  }

  return (
    <div className="stack">
      {/* Header */}
      <div className="card stack" style={{ gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <strong>Snakes &amp; Ladders</strong>
          <span className="small muted">{p.preset === 'classic' ? 'Classic · exact 100' : 'Quick · first to 50'}</span>
        </div>
        {complete ? (
          <div className="pill">🏆 {nameOf(p.finishedOrder[0] ?? null)} wins!</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: colorOf(p.activeMemberId ?? '') }} />
            <span className="small">{p.activeMemberId === me ? 'Your turn' : `${nameOf(p.activeMemberId)}’s turn`}</span>
          </div>
        )}
        {p.lastRoll && (
          <div className="small muted">
            {nameOf(p.lastRoll.memberId)} rolled a <strong>{p.lastRoll.die}</strong>
            {p.lastRoll.jumpedTo !== null
              ? p.lastRoll.jumpedTo > (p.lastRoll.jumpedFrom ?? 0)
                ? ` — climbed to ${p.lastRoll.to}! 🪜`
                : ` — snaked to ${p.lastRoll.to} 🐍`
              : ` → ${p.lastRoll.to}`}
            {p.lastRoll.auto ? ' (auto)' : ''}
          </div>
        )}
      </div>

      {/* Board */}
      <div className="card" style={{ padding: 8 }}>
        <svg viewBox={`0 0 ${cols} ${rows}`} style={{ width: '100%', maxWidth: 440, display: 'block', margin: '0 auto' }} role="img" aria-label="Snakes and Ladders board">
          {Array.from({ length: p.size }, (_, i) => {
            const n = i + 1;
            const [cx, cy] = centre(n);
            const dark = (Math.floor((n - 1) / cols) + ((n - 1) % cols)) % 2 === 0;
            const isFinish = n === p.size;
            return (
              <g key={n}>
                <rect x={cx - 0.5} y={cy - 0.5} width={1} height={1} fill={isFinish ? '#26463f' : dark ? '#efe9db' : '#faf7ef'} stroke="#d9d2c2" strokeWidth={0.02} />
                <text x={cx - 0.42} y={cy - 0.28} fontSize={0.24} fill={isFinish ? '#fff' : '#a89e88'}>{n}</text>
              </g>
            );
          })}
          {Object.entries(p.jumps).map(([o, d]) =>
            Number(d) > Number(o) ? <Ladder key={o} k={o} from={Number(o)} to={d} /> : <Snake key={o} k={o} from={Number(o)} to={d} />,
          )}
          {boardTokens.map((t) => (
            <g key={t.id}>
              <circle cx={t.x} cy={t.y} r={0.28} fill={colorOf(t.id)} stroke={t.id === me ? '#111' : '#fff'} strokeWidth={t.id === me ? 0.1 : 0.06} />
              <text x={t.x} y={t.y + 0.11} fontSize={0.3} textAnchor="middle" fill="#fff" fontWeight={700}>{nameOf(t.id).charAt(0).toUpperCase()}</text>
            </g>
          ))}
        </svg>
        {startTray.length > 0 && (
          <div className="small muted" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
            <span>At the start:</span>
            {startTray.map((id) => (
              <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: colorOf(id), color: '#fff', fontSize: 9, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  {nameOf(id).charAt(0).toUpperCase()}
                </span>
                {nameOf(id)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Roll control */}
      {!board && !complete && (
        <div className="card stack">
          {isMyTurn ? (
            <button className="btn orange" onClick={roll}>🎲 Roll the dice</button>
          ) : (
            <p className="muted center" style={{ margin: 0 }}>Waiting for {nameOf(p.activeMemberId)}…</p>
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
                <span>{i + 1}. {nameOf(id)}{id === me ? ' (you)' : ''}</span>
                <span className="small muted">{p.finishedOrder.includes(id) ? 'Finished' : `Square ${p.positions[id] ?? 0}`}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

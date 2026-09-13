'use client';
import { useMemo } from 'react';
import type { RoomProjection, ClientAction, ActionResult } from '@roomriot/contracts';

type Send = (a: Omit<ClientAction, 'actionId'>) => Promise<ActionResult>;

interface LudoPrompt {
  preset: string;
  seatOrder: string[];
  seatColor: Record<string, number>;
  tokensPerColor: number;
  activeMemberId: string | null;
  stage: 'roll' | 'move' | 'done';
  die: number | null;
  legalTokens: number[];
  positions: Record<string, number[]>;
  consecutiveSixes: number;
  finishedOrder: string[];
  lastEvent: { memberId: string; die: number; tokenIndex: number | null; captured: string[]; auto: boolean } | null;
  safeCells: number[];
}

const COLOR_HEX = ['#e0564b', '#3d8361', '#4f74c9', '#e0a92e']; // red, green, blue, yellow
const COLOR_TINT = ['#f7d9d5', '#d5e7de', '#d9e2f4', '#f6e9c9'];
const COLOR_NAME = ['Red', 'Green', 'Blue', 'Yellow'];

// The 52 shared-track cells as [col,row] on a 15×15 grid (see ludoBoard.ts for the
// logical model; this is only the visual layout). Color k's start is PATH[k*13].
const PATH: [number, number][] = [
  [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [0, 7],
  [0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0],
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
  [14, 7],
  [14, 8], [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
  [7, 14],
  [6, 14],
];
const START_OFFSET = [0, 13, 26, 39];
const BASE_ORIGIN: [number, number][] = [[0, 9], [0, 0], [9, 0], [9, 9]]; // color → corner
const YARD_SLOT: [number, number][] = [[1.3, 1.3], [3.7, 1.3], [1.3, 3.7], [3.7, 3.7]];

function homeLaneXY(color: number, step: number): [number, number] {
  if (color === 0) return [7, 13 - step];
  if (color === 1) return [1 + step, 7];
  if (color === 2) return [7, 1 + step];
  return [13 - step, 7];
}
const CENTER_NUDGE: [number, number][] = [[7, 8.1], [5.9, 7], [7, 5.9], [8.1, 7]];

/** Grid cell (col,row) → SVG centre, or a yard/home position, for a token. */
function tokenXY(color: number, progress: number, tokenIndex: number): [number, number] {
  if (progress === -1) {
    const [ox, oy] = BASE_ORIGIN[color]!;
    const [sx, sy] = YARD_SLOT[tokenIndex % 4]!;
    return [ox + sx, oy + sy];
  }
  if (progress >= 0 && progress <= 50) {
    const [c, r] = PATH[(START_OFFSET[color]! + progress) % 52]!;
    return [c + 0.5, r + 0.5];
  }
  if (progress >= 51 && progress <= 55) {
    const [c, r] = homeLaneXY(color, progress - 51);
    return [c + 0.5, r + 0.5];
  }
  return CENTER_NUDGE[color]!; // home (56)
}

export function LudoView({ projection, send, board }: { projection: RoomProjection; send: Send; board?: boolean }) {
  const game = projection.game!;
  const p = game.prompt as unknown as LudoPrompt;
  const me = projection.self?.memberId;
  const complete = p.stage === 'done' || game.phaseKind === 'complete';
  const safe = useMemo(() => new Set(p.safeCells), [p.safeCells]);

  const nameOf = useMemo(() => {
    const map = new Map(projection.members.map((m) => [m.memberId, m.nickname]));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? '—') : '—');
  }, [projection.members]);

  const myTurn = !complete && p.activeMemberId === me;
  const myColor = p.seatColor[me ?? ''] ?? 0;
  const gp = { gameId: projection.gameId ?? undefined, phaseId: projection.phaseId ?? undefined };
  const roll = () => send({ type: 'roll', ...gp });
  const moveToken = (tokenIndex: number) => send({ type: 'move', ...gp, payload: { tokenIndex } });

  const describe = (color: number, progress: number): string => {
    if (progress === -1) return 'yard';
    if (progress === 56) return 'home 🏁';
    if (progress >= 51) return `home lane ${progress - 50}/6`;
    return 'on track';
  };
  const destOf = (progress: number, die: number): number | null => {
    if (progress === -1) return die === 6 ? 0 : null;
    return progress + die <= 56 ? progress + die : null;
  };

  // Gather every token's render position, then spread any that share a cell.
  const tokens = useMemo(() => {
    const list: { color: number; ti: number; owner: string; progress: number; x: number; y: number; legal: boolean }[] = [];
    for (const id of p.seatOrder) {
      const color = p.seatColor[id] ?? 0;
      (p.positions[id] ?? []).forEach((progress, ti) => {
        const [x, y] = tokenXY(color, progress, ti);
        const legal = id === p.activeMemberId && p.stage === 'move' && p.legalTokens.includes(ti);
        list.push({ color, ti, owner: id, progress, x, y, legal });
      });
    }
    const byCell = new Map<string, typeof list>();
    for (const t of list) {
      const key = `${Math.round(t.x * 2)},${Math.round(t.y * 2)}`;
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key)!.push(t);
    }
    for (const group of byCell.values()) {
      if (group.length > 1) group.forEach((t, i) => (t.x += (i - (group.length - 1) / 2) * 0.36));
    }
    return list;
  }, [p.positions, p.seatOrder, p.seatColor, p.activeMemberId, p.stage, p.legalTokens]);

  const cell = (c: number, r: number, fill: string, key: string) => (
    <rect key={key} x={c + 0.06} y={r + 0.06} width={0.88} height={0.88} rx={0.18} fill={fill} stroke="#c8c1b2" strokeWidth={0.03} />
  );

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <strong>Ludo</strong>
          <span className="small muted">{p.preset === 'classic' ? 'Classic' : 'Quick · 2 tokens'}</span>
        </div>
        {complete ? (
          <div className="pill">🏆 {nameOf(p.finishedOrder[0] ?? null) || 'Nobody'} {p.finishedOrder.length ? 'wins!' : '(capped)'}</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: COLOR_HEX[p.seatColor[p.activeMemberId ?? ''] ?? 0] }} />
            <span className="small">{p.activeMemberId === me ? 'Your turn' : `${nameOf(p.activeMemberId)}’s turn`} · {p.stage === 'roll' ? 'roll' : 'move'}</span>
            {p.die != null && (
              <span style={{ display: 'inline-flex', width: 22, height: 22, borderRadius: 5, background: '#fff', border: '1px solid var(--line,#ddd)', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{p.die}</span>
            )}
          </div>
        )}
        {p.lastEvent && (
          <div className="small muted">
            {nameOf(p.lastEvent.memberId)} rolled {p.lastEvent.die}
            {p.lastEvent.captured.length ? ` — captured ${p.lastEvent.captured.length}! 💥` : ''}
            {p.lastEvent.auto ? ' (auto)' : ''}
          </div>
        )}
      </div>

      {/* Board */}
      <div className="card" style={{ padding: 8 }}>
        <svg viewBox="0 0 15 15" style={{ width: '100%', maxWidth: 440, display: 'block', margin: '0 auto' }} role="img" aria-label="Ludo board">
          <rect x={0} y={0} width={15} height={15} fill="#faf7ef" />
          {/* Home bases */}
          {[0, 1, 2, 3].map((c) => {
            const [ox, oy] = BASE_ORIGIN[c]!;
            return (
              <g key={`base${c}`}>
                <rect x={ox + 0.1} y={oy + 0.1} width={5.8} height={5.8} rx={0.5} fill={COLOR_TINT[c]} stroke={COLOR_HEX[c]} strokeWidth={0.12} />
                <rect x={ox + 1} y={oy + 1} width={4} height={4} rx={0.4} fill="#fff" stroke={COLOR_HEX[c]} strokeWidth={0.06} />
                {YARD_SLOT.map((s, i) => (
                  <circle key={i} cx={ox + s[0]} cy={oy + s[1]} r={0.42} fill="none" stroke={COLOR_HEX[c]} strokeWidth={0.05} />
                ))}
              </g>
            );
          })}
          {/* Track cells */}
          {PATH.map(([c, r], i) => {
            const startColor = START_OFFSET.indexOf(i);
            const fill = startColor >= 0 ? COLOR_TINT[startColor]! : '#ffffff';
            return (
              <g key={`t${i}`}>
                {cell(c, r, fill, `cell${i}`)}
                {safe.has(i) && startColor < 0 && (
                  <text x={c + 0.5} y={r + 0.72} fontSize={0.6} textAnchor="middle" fill="#b6ad99">★</text>
                )}
              </g>
            );
          })}
          {/* Coloured home lanes */}
          {[0, 1, 2, 3].map((c) =>
            [0, 1, 2, 3, 4].map((s) => {
              const [x, y] = homeLaneXY(c, s);
              return cell(x, y, COLOR_TINT[c]!, `hl${c}-${s}`);
            }),
          )}
          {/* Centre home */}
          <g>
            <polygon points="6,6 9,6 7.5,7.5" fill={COLOR_HEX[2]} />
            <polygon points="9,6 9,9 7.5,7.5" fill={COLOR_HEX[3]} />
            <polygon points="9,9 6,9 7.5,7.5" fill={COLOR_HEX[0]} />
            <polygon points="6,9 6,6 7.5,7.5" fill={COLOR_HEX[1]} />
          </g>
          {/* Tokens */}
          {tokens.map((t) => (
            <g key={`${t.owner}-${t.ti}`}>
              <circle cx={t.x} cy={t.y} r={0.4} fill={COLOR_HEX[t.color]} stroke={t.legal ? '#111' : '#fff'} strokeWidth={t.legal ? 0.14 : 0.07} />
              <text x={t.x} y={t.y + 0.16} fontSize={0.42} textAnchor="middle" fill="#fff" fontWeight={700}>{t.ti + 1}</text>
            </g>
          ))}
        </svg>
      </div>

      {/* Legend */}
      <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center', padding: 8 }}>
        {p.seatOrder.map((id) => {
          const c = p.seatColor[id] ?? 0;
          const finished = (p.positions[id] ?? []).filter((x) => x === 56).length;
          return (
            <span key={id} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: id === me ? 700 : 400 }}>
              <span style={{ width: 11, height: 11, borderRadius: '50%', background: COLOR_HEX[c] }} />
              {nameOf(id)}{id === me ? ' (you)' : ''} · {finished}/{p.tokensPerColor} home
            </span>
          );
        })}
      </div>

      {/* Controls */}
      {!board && !complete && (
        <div className="card stack">
          {!myTurn ? (
            <p className="muted center" style={{ margin: 0 }}>Waiting for {nameOf(p.activeMemberId)}…</p>
          ) : p.stage === 'roll' ? (
            <button className="btn orange" onClick={roll}>🎲 Roll the dice</button>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              <div className="small muted">You rolled {p.die}. Move which token?</div>
              {p.legalTokens.map((t) => {
                const from = (p.positions[me ?? ''] ?? [])[t] ?? -1;
                const dest = destOf(from, p.die ?? 0);
                return (
                  <button key={t} className="btn" onClick={() => moveToken(t)}>
                    Token {t + 1}: {describe(myColor, from)} → {dest === null ? '—' : dest === 56 ? 'home 🏁' : describe(myColor, dest)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {complete && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Final standings</h2>
          {[...p.seatOrder]
            .map((id) => ({
              id,
              finished: (p.positions[id] ?? []).filter((x) => x === 56).length,
              prog: (p.positions[id] ?? []).reduce((s, x) => s + (x < 0 ? 0 : x === 56 ? 57 : x + 1), 0),
            }))
            .sort((a, b) => b.finished - a.finished || b.prog - a.prog)
            .map((row, i) => (
              <div key={row.id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{i + 1}. {nameOf(row.id)}{row.id === me ? ' (you)' : ''}</span>
                <span className="small muted">{row.finished} home · {row.prog} progress</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

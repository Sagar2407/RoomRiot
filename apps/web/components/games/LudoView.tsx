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

const COLOR_HEX = ['#e07a5f', '#3d8361', '#5b7db1', '#c9a227'];
const COLOR_NAME = ['Red', 'Green', 'Blue', 'Yellow'];

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
  const gp = { gameId: projection.gameId ?? undefined, phaseId: projection.phaseId ?? undefined };
  const roll = () => send({ type: 'roll', ...gp });
  const move = (tokenIndex: number) => send({ type: 'move', ...gp, payload: { tokenIndex } });

  const describe = (color: number, progress: number): string => {
    if (progress === -1) return 'in the yard';
    if (progress === 56) return 'home 🏁';
    if (progress >= 51) return `home lane ${progress - 50}/6`;
    const cell = (color * 13 + progress) % 52;
    return `square ${cell}${safe.has(cell) ? ' ⭐' : ''}`;
  };
  const destOf = (color: number, progress: number, die: number): number | null => {
    if (progress === -1) return die === 6 ? 0 : null;
    return progress + die <= 56 ? progress + die : null;
  };

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <strong>Ludo</strong>
          <span className="small muted">{p.preset === 'classic' ? 'Classic · all tokens' : 'Quick · 2 tokens'}</span>
        </div>
        {complete ? (
          <div className="pill">🏆 {nameOf(p.finishedOrder[0] ?? null) || 'Nobody'} {p.finishedOrder.length ? 'wins!' : '(capped)'}</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: COLOR_HEX[p.seatColor[p.activeMemberId ?? ''] ?? 0] }} />
            <span className="small">{p.activeMemberId === me ? 'Your turn' : `${nameOf(p.activeMemberId)}’s turn`} · {p.stage === 'roll' ? 'roll' : 'move'}</span>
            {p.die != null && <span className="pill grey">🎲 {p.die}</span>}
          </div>
        )}
        {p.lastEvent && (
          <div className="small muted">
            {nameOf(p.lastEvent.memberId)} rolled {p.lastEvent.die}
            {p.lastEvent.captured.length ? ` — captured ${p.lastEvent.captured.length} token(s)!` : ''}
            {p.lastEvent.auto ? ' (auto)' : ''}
          </div>
        )}
      </div>

      {/* Per-seat token positions */}
      <div className="card stack" style={{ gap: 8 }}>
        {p.seatOrder.map((id) => {
          const color = p.seatColor[id] ?? 0;
          return (
            <div key={id} className="stack" style={{ gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: COLOR_HEX[color] }} />
                <strong style={{ fontWeight: id === me ? 700 : 500 }}>
                  {nameOf(id)} {COLOR_NAME[color]}{id === me ? ' (you)' : ''}
                </strong>
              </div>
              <div className="small muted" style={{ paddingLeft: 18 }}>
                {(p.positions[id] ?? []).map((prog, i) => (
                  <span key={i} style={{ marginRight: 10 }}>
                    T{i + 1}: {describe(color, prog)}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Controls */}
      {!board && !complete && (
        <div className="card stack">
          {!myTurn ? (
            <p className="muted center" style={{ margin: 0 }}>Waiting for {nameOf(p.activeMemberId)}…</p>
          ) : p.stage === 'roll' ? (
            <button className="btn orange" onClick={roll}>🎲 Roll</button>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              <div className="small muted">You rolled {p.die}. Move which token?</div>
              {p.legalTokens.map((t) => {
                const color = p.seatColor[me ?? ''] ?? 0;
                const from = (p.positions[me ?? ''] ?? [])[t] ?? -1;
                const dest = destOf(color, from, p.die ?? 0);
                return (
                  <button key={t} className="btn" onClick={() => move(t)}>
                    Token {t + 1}: {describe(color, from)} → {dest === null ? '—' : describe(color, dest)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Recap */}
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

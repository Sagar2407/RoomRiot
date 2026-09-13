'use client';
import { useMemo } from 'react';
import type { RoomProjection, ClientAction, ActionResult } from '@roomriot/contracts';

type Send = (a: Omit<ClientAction, 'actionId'>) => Promise<ActionResult>;

interface TPPrompt {
  stage: 'betting' | 'hand_over' | 'done';
  handIndex: number;
  totalHands: number;
  dealerMemberId: string;
  seatOrder: string[];
  activeMemberId: string | null;
  pot: number;
  base: number;
  circuit: number;
  seen: Record<string, boolean>;
  folded: Record<string, boolean>;
  contributed: Record<string, number>;
  sessionNet: Record<string, number>;
  activeCount: number;
  lastAction: { memberId: string; type: string; amount?: number } | null;
  reveal: { kind: string; hands: Record<string, string[]>; winners: string[]; pot: number } | null;
}
interface TPSecret {
  myHand: string[] | null;
  seen: boolean;
  canSee?: boolean;
  callCost?: number;
  canRaise?: boolean;
  raiseCost?: number | null;
  canShow?: boolean;
  showCost?: number | null;
}

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const isRed = (s: string) => s === 'H' || s === 'D';
const rankLabel = (r: string) => (r === 'T' ? '10' : r);

function Card({ card }: { card: string }) {
  const suit = card[1]!;
  return (
    <span style={{ display: 'inline-flex', minWidth: 30, height: 42, alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line,#ddd)', borderRadius: 6, background: '#fff', padding: '0 4px', color: isRed(suit) ? '#c0392b' : '#1a1a1a', fontWeight: 700 }}>
      {rankLabel(card[0]!)}
      {SUIT_SYMBOL[suit]}
    </span>
  );
}

export function TeenPattiView({ projection, send, board }: { projection: RoomProjection; send: Send; board?: boolean }) {
  const game = projection.game!;
  const p = game.prompt as unknown as TPPrompt;
  const s = (projection.self?.private?.secret ?? {}) as TPSecret;
  const me = projection.self?.memberId;
  const complete = p.stage === 'done' || game.phaseKind === 'complete';

  const nameOf = useMemo(() => {
    const map = new Map(projection.members.map((m) => [m.memberId, m.nickname]));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? '—') : '—');
  }, [projection.members]);

  const myTurn = p.stage === 'betting' && p.activeMemberId === me;
  const gp = { gameId: projection.gameId ?? undefined, phaseId: projection.phaseId ?? undefined };

  const see = () => send({ type: 'see', ...gp });
  const bet = (raise: boolean) => send({ type: 'bet', ...gp, payload: { raise } });
  const fold = () => send({ type: 'fold', ...gp });
  const show = () => send({ type: 'show', ...gp });

  return (
    <div className="stack">
      {/* Header */}
      <div className="card stack" style={{ gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <strong>Teen Patti</strong>
          <span className="small muted">Hand {p.handIndex + 1}/{p.totalHands}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="pill">Pot {p.pot}</span>
          <span className="small muted">Stake base {p.base}</span>
          <span className="small muted">Dealer: {nameOf(p.dealerMemberId)}</span>
        </div>
        {!complete && p.stage === 'betting' && (
          <div className="small">{myTurn ? 'Your turn' : `${nameOf(p.activeMemberId)}’s turn`}{p.lastAction ? ` · last: ${nameOf(p.lastAction.memberId)} ${p.lastAction.type}${p.lastAction.amount ? ` ${p.lastAction.amount}` : ''}` : ''}</div>
        )}
      </div>

      {/* Table */}
      <div className="card stack" style={{ gap: 4 }}>
        <h2 style={{ margin: 0 }}>Table</h2>
        {p.seatOrder.map((id) => (
          <div key={id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: p.folded[id] ? 0.5 : 1 }}>
            <span style={{ fontWeight: id === me ? 700 : 400 }}>
              {nameOf(id)}
              {id === me ? ' (you)' : ''}
              {id === p.dealerMemberId ? ' 🂠' : ''}
              {id === p.activeMemberId && !complete ? ' ⏳' : ''}
            </span>
            <span className="small muted">
              {p.folded[id] ? 'packed' : p.seen[id] ? 'seen' : 'blind'} · net {(p.sessionNet[id] ?? 0) >= 0 ? '+' : ''}{p.sessionNet[id] ?? 0}
            </span>
          </div>
        ))}
      </div>

      {/* Reveal (hand over) */}
      {p.reveal && !complete && (
        <div className="card stack" style={{ gap: 6 }}>
          <h2 style={{ margin: 0 }}>{p.reveal.kind === 'fold' ? 'Hand over' : p.reveal.kind === 'show' ? 'Show!' : 'Showdown'}</h2>
          <div className="small">{p.reveal.winners.map(nameOf).join(' & ')} won {p.reveal.pot} chips.</div>
          {Object.entries(p.reveal.hands).map(([id, cards]) => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="small" style={{ minWidth: 70 }}>{nameOf(id)}</span>
              <div style={{ display: 'flex', gap: 4 }}>{cards.map((c) => <Card key={c} card={c} />)}</div>
            </div>
          ))}
        </div>
      )}

      {/* My cards + controls */}
      {!board && !complete && p.stage === 'betting' && (
        <div className="card stack">
          {s.myHand ? (
            <div style={{ display: 'flex', gap: 6 }}>{s.myHand.map((c) => <Card key={c} card={c} />)}</div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>Your cards are face down (blind). Peek any time on your turn — but you’ll pay double.</p>
          )}
          {myTurn ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="btn-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {s.canSee && (
                  <button className="btn ghost" onClick={see}>See cards</button>
                )}
                <button className="btn orange" onClick={() => bet(false)}>Play {s.callCost}</button>
                {s.canRaise && s.raiseCost != null && (
                  <button className="btn" onClick={() => bet(true)}>Raise {s.raiseCost}</button>
                )}
                <button className="btn ghost" onClick={fold}>Pack</button>
              </div>
              {s.canShow && s.showCost != null && (
                <button className="btn" onClick={show}>Show ({s.showCost}) — reveal both hands</button>
              )}
            </div>
          ) : (
            <p className="muted center" style={{ margin: 0 }}>Waiting for {nameOf(p.activeMemberId)}…</p>
          )}
        </div>
      )}

      {/* Session recap */}
      {complete && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Final chips (net)</h2>
          {[...p.seatOrder]
            .sort((a, b) => (p.sessionNet[b] ?? 0) - (p.sessionNet[a] ?? 0))
            .map((id, i) => (
              <div key={id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{i + 1}. {nameOf(id)}{id === me ? ' (you)' : ''}</span>
                <strong>{(p.sessionNet[id] ?? 0) >= 0 ? '+' : ''}{p.sessionNet[id] ?? 0}</strong>
              </div>
            ))}
          {projection.awards && projection.awards.filter((a) => a.key !== 'night_champion').length > 0 && (
            <div className="stack" style={{ gap: 4, marginTop: 4 }}>
              {projection.awards.filter((a) => a.key !== 'night_champion').map((a) => (
                <div key={a.key} className="small"><strong>{a.title}:</strong> {a.nickname ?? nameOf(a.memberId)} — {a.detail}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

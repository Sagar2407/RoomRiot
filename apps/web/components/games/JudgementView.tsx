'use client';
import { useMemo, useState, useEffect } from 'react';
import type { RoomProjection, ClientAction, ActionResult } from '@roomriot/contracts';

type Send = (a: Omit<ClientAction, 'actionId'>) => Promise<ActionResult>;

interface JudgementPrompt {
  stage: 'bidding' | 'playing' | 'done';
  dealIndex: number;
  totalDeals: number;
  handSize: number;
  trump: string;
  dealerMemberId: string;
  seatOrder: string[];
  activeMemberId: string | null;
  bids: Record<string, number>;
  tricksWon: Record<string, number>;
  scores: Record<string, number>;
  handCounts: Record<string, number>;
  currentTrick: Array<{ memberId: string; card: string }>;
  leadSuit: string | null;
  trickCount: number;
  lastTrick: { plays: Array<{ memberId: string; card: string }>; winner: string } | null;
  dealResults: Array<Record<string, { bid: number; won: number; points: number }>>;
}

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME: Record<string, string> = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const isRed = (suit: string) => suit === 'H' || suit === 'D';
const rankLabel = (r: string) => (r === 'T' ? '10' : r);

function Card({ card, onClick, disabled, selected }: { card: string; onClick?: () => void; disabled?: boolean; selected?: boolean }) {
  const rank = rankLabel(card[0]!);
  const suit = card[1]!;
  const body = (
    <span style={{ color: isRed(suit) ? '#c0392b' : '#1a1a1a', fontWeight: 700 }}>
      {rank}
      {SUIT_SYMBOL[suit]}
    </span>
  );
  if (!onClick) {
    return (
      <span style={{ display: 'inline-flex', minWidth: 34, height: 46, alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line,#ddd)', borderRadius: 6, background: '#fff', padding: '0 4px' }}>
        {body}
      </span>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 40,
        height: 54,
        border: selected ? '2px solid var(--orange,#e07a5f)' : '1px solid var(--line,#ddd)',
        borderRadius: 8,
        background: disabled ? '#f2efe9' : '#fff',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 18,
      }}
    >
      {body}
    </button>
  );
}

export function JudgementView({ projection, send, board }: { projection: RoomProjection; send: Send; board?: boolean }) {
  const game = projection.game!;
  const p = game.prompt as unknown as JudgementPrompt;
  const secret = (projection.self?.private?.secret ?? {}) as { hand?: string[]; legalBids?: number[]; legalCards?: string[] };
  const me = projection.self?.memberId;
  const complete = p.stage === 'done' || game.phaseKind === 'complete';

  const nameOf = useMemo(() => {
    const map = new Map(projection.members.map((m) => [m.memberId, m.nickname]));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? '—') : '—');
  }, [projection.members]);

  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [projection.phaseId]);

  const myTurn = !complete && p.activeMemberId === me;
  const legalCards = new Set(secret.legalCards ?? []);

  async function bid(n: number) {
    await send({ type: 'bid', gameId: projection.gameId ?? undefined, phaseId: projection.phaseId ?? undefined, payload: { bid: n } });
  }
  async function play(card: string) {
    await send({ type: 'play_card', gameId: projection.gameId ?? undefined, phaseId: projection.phaseId ?? undefined, payload: { card } });
    setSelected(null);
  }

  return (
    <div className="stack">
      {/* Header: deal, trump, whose turn */}
      <div className="card stack" style={{ gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <strong>Judgement</strong>
          <span className="small muted">
            Deal {p.dealIndex + 1}/{p.totalDeals} · {p.handSize} card{p.handSize > 1 ? 's' : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="pill grey">
            Trump {SUIT_SYMBOL[p.trump]} {SUIT_NAME[p.trump]}
          </span>
          <span className="small muted">Dealer: {nameOf(p.dealerMemberId)}</span>
        </div>
        {complete ? (
          <div className="pill">Match complete</div>
        ) : (
          <div className="small">
            {p.stage === 'bidding' ? 'Bidding' : 'Playing'} · {myTurn ? 'your turn' : `${nameOf(p.activeMemberId)}’s turn`}
          </div>
        )}
      </div>

      {/* Score sheet */}
      <div className="card stack" style={{ gap: 4 }}>
        <h2 style={{ margin: 0 }}>Table</h2>
        {p.seatOrder.map((id) => (
          <div key={id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: id === me ? 700 : 400 }}>
              {nameOf(id)}
              {id === me ? ' (you)' : ''}
              {id === p.activeMemberId && !complete ? ' ⏳' : ''}
            </span>
            <span className="small muted">
              {p.bids[id] !== undefined ? `bid ${p.bids[id]} · won ${p.tricksWon[id] ?? 0}` : 'bidding…'} · {p.scores[id] ?? 0} pts
            </span>
          </div>
        ))}
      </div>

      {/* Current trick */}
      {p.stage === 'playing' && (p.currentTrick.length > 0 || p.lastTrick) && (
        <div className="card stack" style={{ gap: 6 }}>
          <div className="small muted">{p.currentTrick.length > 0 ? 'This trick' : 'Last trick'}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(p.currentTrick.length > 0 ? p.currentTrick : p.lastTrick?.plays ?? []).map((pl) => (
              <div key={pl.memberId} style={{ textAlign: 'center' }}>
                <Card card={pl.card} />
                <div className="small muted" style={{ marginTop: 2 }}>{nameOf(pl.memberId)}</div>
              </div>
            ))}
          </div>
          {p.currentTrick.length === 0 && p.lastTrick && (
            <div className="small">{nameOf(p.lastTrick.winner)} took it.</div>
          )}
        </div>
      )}

      {/* My controls */}
      {!board && !complete && (
        <div className="card stack">
          {p.stage === 'bidding' ? (
            myTurn ? (
              <>
                <h2 style={{ margin: 0 }}>Your bid — how many tricks?</h2>
                <div className="options" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {(secret.legalBids ?? []).map((n) => (
                    <button key={n} className="btn" style={{ minWidth: 48 }} onClick={() => bid(n)}>
                      {n}
                    </button>
                  ))}
                </div>
                <p className="small muted" style={{ margin: 0 }}>Score 10 + your bid if you win exactly that many.</p>
              </>
            ) : (
              <p className="muted center" style={{ margin: 0 }}>Waiting for {nameOf(p.activeMemberId)} to bid…</p>
            )
          ) : (
            <>
              <div className="small muted">Your hand{myTurn ? ' — tap a card, then Play' : ''}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(secret.hand ?? []).map((card) => {
                  const playable = myTurn && legalCards.has(card);
                  return (
                    <Card
                      key={card}
                      card={card}
                      selected={selected === card}
                      disabled={myTurn ? !playable : true}
                      onClick={myTurn && playable ? () => setSelected(card) : undefined}
                    />
                  );
                })}
              </div>
              {myTurn && (
                <button className="btn orange" disabled={!selected} onClick={() => selected && play(selected)}>
                  Play {selected ? `${rankLabel(selected[0]!)}${SUIT_SYMBOL[selected[1]!]}` : ''}
                </button>
              )}
              {!myTurn && <p className="muted center" style={{ margin: 0 }}>Waiting for {nameOf(p.activeMemberId)}…</p>}
            </>
          )}
        </div>
      )}

      {/* Recap */}
      {complete && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Final scores</h2>
          {[...p.seatOrder]
            .sort((a, b) => (p.scores[b] ?? 0) - (p.scores[a] ?? 0))
            .map((id, i) => (
              <div key={id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>
                  {i + 1}. {nameOf(id)}
                  {id === me ? ' (you)' : ''}
                </span>
                <strong>{p.scores[id] ?? 0}</strong>
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

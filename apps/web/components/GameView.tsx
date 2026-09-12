'use client';
import { useEffect, useMemo, useState } from 'react';
import type { RoomProjection, ClientAction, ActionResult, GameType } from '@roomriot/contracts';
import { Timer } from './Timer';
import { Members } from './Members';

type Send = (a: Omit<ClientAction, 'actionId'>) => Promise<ActionResult>;

const TITLES: Record<GameType, string> = {
  majority_report: 'Majority Report',
  bluff_bureau: 'Bluff Bureau',
  caption_court: 'Caption Court',
  link_up: 'Link Up',
  alibi_club: 'Alibi Club',
  close_call: 'Close Call',
};

export function GameView({ projection, send, board }: { projection: RoomProjection; send: Send; board?: boolean }) {
  const game = projection.game!;
  const priv = projection.self?.private ?? null;
  const secret = (priv?.secret ?? undefined) as Record<string, unknown> | undefined;
  const awaiting = priv?.awaitingInput ?? false;
  const nameOf = useMemo(() => {
    const map = new Map(projection.members.map((m) => [m.memberId, m.nickname]));
    return (id: string | null | undefined) => (id ? (map.get(id) ?? '—') : '—');
  }, [projection.members]);

  const phaseKey = `${game.gameType}:${game.phaseKind}:${game.round}`;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [phaseKey]);

  async function act(type: string, payload: unknown) {
    const res = await send({ type, gameId: undefined, phaseId: undefined, payload });
    if (!res.accepted) setError(res.message ?? res.reason ?? 'Not accepted');
  }

  const gid = (projection.game as unknown as { id?: string })?.id;
  async function actGame(type: string, payload: unknown) {
    const res = await send({ type, phaseId: (game as unknown as { phaseId?: string }).phaseId, gameId: gid, payload });
    if (!res.accepted) setError(res.message ?? res.reason ?? 'Not accepted');
  }

  const header = (
    <div className="card stack" style={{ gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{TITLES[game.gameType]}</strong>
        <span className="small muted">
          Round {game.round}/{game.totalRounds}
        </span>
      </div>
      {!board && <Timer deadlineAt={projection.deadlineAt} />}
    </div>
  );

  const isReveal = game.phaseKind === 'reveal';
  const waiting = !board && !isReveal && !awaiting && game.phaseKind !== 'discussion' && game.phaseKind !== 'roles';

  return (
    <div className="stack">
      {header}
      {error && <div className="error">{error}</div>}

      {/* Reveal is shown to everyone (board + players). */}
      {isReveal ? (
        <Reveal game={game} nameOf={nameOf} selfId={projection.self?.memberId} />
      ) : board ? (
        <BoardPhase game={game} nameOf={nameOf} projection={projection} />
      ) : waiting ? (
        <div className="card stack">
          <div className="pill">Locked in ✓</div>
          <p className="muted">Waiting for the rest of the room…</p>
          <Members projection={projection} />
        </div>
      ) : (
        <Controller game={game} secret={secret} act={act} actGame={actGame} nameOf={nameOf} projection={projection} />
      )}

      {!board && (isReveal || waiting) && <Members projection={projection} />}
    </div>
  );
}

// --------------------------------------------------------------------------
// Player controller — the phone input for the current phase.
// --------------------------------------------------------------------------
function Controller({
  game,
  secret,
  act,
  actGame,
  nameOf,
  projection,
}: {
  game: RoomProjection['game'] & object;
  secret: Record<string, unknown> | undefined;
  act: (t: string, p: unknown) => void;
  actGame: (t: string, p: unknown) => void;
  nameOf: (id: string | null | undefined) => string;
  projection: RoomProjection;
}) {
  const g = game!;
  const options = g.options ?? [];
  const prompt = (g.prompt ?? {}) as Record<string, unknown>;

  // Local per-phase state.
  const [answer, setAnswer] = useState<string | null>(null);
  const [forecast, setForecast] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<string | null>(null);
  const [accused, setAccused] = useState<string | null>(null);
  const [guess, setGuess] = useState<string | null>(null);
  const [num, setNum] = useState('');

  switch (g.gameType) {
    case 'majority_report':
      return (
        <div className="card stack">
          <h2>{String(prompt.question)}</h2>
          <div className="small muted">1 · Pick your own answer</div>
          <OptionGrid options={options} selected={answer} onPick={setAnswer} />
          <div className="small muted">2 · Which will the room pick most?</div>
          <OptionGrid options={options} selected={forecast} onPick={setForecast} />
          <button className="btn orange" disabled={!answer || !forecast} onClick={() => actGame('submit_round', { answer, forecast })}>
            Lock in
          </button>
        </div>
      );

    case 'bluff_bureau':
      if (g.phaseKind === 'writing')
        return (
          <TextCard
            title={String(prompt.question)}
            hint="Write a believable fake answer to fool the room."
            value={text}
            setValue={setText}
            maxLen={120}
            onSubmit={() => actGame('submit_decoy', { text })}
            cta="Submit decoy"
          />
        );
      return (
        <VoteCard
          title="Which is the real answer?"
          options={options}
          ownId={secret?.ownOptionId as string | null | undefined}
          onVote={(id) => actGame('submit_vote', { optionId: id })}
        />
      );

    case 'caption_court':
      if (g.phaseKind === 'writing')
        return (
          <TextCard
            title="Caption this"
            hint={String(prompt.scenario)}
            value={text}
            setValue={setText}
            maxLen={120}
            onSubmit={() => actGame('submit_caption', { text })}
            cta="Submit caption"
          />
        );
      return (
        <VoteCard
          title="Vote for your favourite"
          options={options}
          ownId={secret?.ownOptionId as string | null | undefined}
          onVote={(id) => actGame('submit_vote', { optionId: id })}
        />
      );

    case 'link_up': {
      const partners = ((secret?.partnerMemberIds as string[]) ?? []).map(nameOf).join(' & ');
      return (
        <div className="card stack">
          <h2>{String(prompt.question)}</h2>
          <div className="notice small">
            Match <strong>{partners || 'your partner'}</strong> — pick what you think they’ll choose. No talking!
          </div>
          <OptionGrid options={options} selected={choice} onPick={setChoice} />
          <button className="btn orange" disabled={!choice} onClick={() => actGame('submit_choice', { optionId: choice })}>
            Lock in
          </button>
        </div>
      );
    }

    case 'alibi_club': {
      const role = secret?.role as string | undefined;
      if (g.phaseKind === 'roles' || g.phaseKind === 'clue' || g.phaseKind === 'discussion') {
        return (
          <div className="stack">
            <RoleCard role={role} secret={secret} />
            <ClueList game={g} nameOf={nameOf} />
            {g.phaseKind === 'clue' && (
              <TextCard
                title={`Clue wave ${prompt.wave}`}
                hint="Give an indirect clue about the location — don’t be too obvious."
                value={text}
                setValue={setText}
                maxLen={140}
                onSubmit={() => actGame('submit_clue', { text })}
                cta="Give clue"
              />
            )}
            {g.phaseKind === 'discussion' && <div className="notice">Talk it out — who’s blending in? Accusations open next.</div>}
          </div>
        );
      }
      // accuse
      const targets = options.filter((o) => o.id !== projection.self?.memberId);
      const locOptions = (secret?.locationOptions as string[] | undefined) ?? [];
      return (
        <div className="stack">
          <RoleCard role={role} secret={secret} />
          <div className="card stack">
            <h2>Who is the outsider?</h2>
            <div className="options">
              {targets.map((o) => (
                <button
                  key={o.id}
                  className={`opt ${accused === o.id ? 'selected' : ''}`}
                  onClick={() => setAccused(o.id)}
                >
                  {nameOf(o.id)}
                </button>
              ))}
            </div>
            <button className="btn orange" disabled={!accused} onClick={() => actGame('submit_accusation', { targetMemberId: accused })}>
              Seal accusation
            </button>
          </div>
          {role === 'outsider' && (
            <div className="card stack">
              <h2>Secretly guess the location</h2>
              <div className="options">
                {locOptions.map((loc) => (
                  <button key={loc} className={`opt ${guess === loc ? 'selected' : ''}`} onClick={() => setGuess(loc)}>
                    {loc}
                  </button>
                ))}
              </div>
              <button className="btn" disabled={!guess} onClick={() => actGame('submit_outsider_guess', { location: guess })}>
                Lock guess
              </button>
            </div>
          )}
        </div>
      );
    }

    case 'close_call':
      return (
        <div className="card stack">
          <h2>{String(prompt.text)}</h2>
          <div className="small muted">Counting rule: {String(prompt.countingRule)} · answer is between 0 and {String(prompt.rangeMax)}</div>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={Number(prompt.rangeMax)}
            value={num}
            onChange={(e) => setNum(e.target.value)}
            placeholder="Your estimate"
          />
          <button
            className="btn orange"
            disabled={num === '' || Number.isNaN(Number(num))}
            onClick={() => actGame('submit_estimate', { value: Number(num) })}
          >
            Lock estimate
          </button>
        </div>
      );

    default:
      return null;
  }
}

// --------------------------------------------------------------------------
// Shared building blocks
// --------------------------------------------------------------------------
function OptionGrid({
  options,
  selected,
  onPick,
}: {
  options: Array<{ id: string; label: string }>;
  selected: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="options">
      {options.map((o) => (
        <button key={o.id} className={`opt ${selected === o.id ? 'selected' : ''}`} onClick={() => onPick(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TextCard({
  title,
  hint,
  value,
  setValue,
  maxLen,
  onSubmit,
  cta,
}: {
  title: string;
  hint: string;
  value: string;
  setValue: (v: string) => void;
  maxLen: number;
  onSubmit: () => void;
  cta: string;
}) {
  return (
    <div className="card stack">
      <h2>{title}</h2>
      <p className="muted" style={{ margin: 0 }}>
        {hint}
      </p>
      <textarea rows={3} maxLength={maxLen} value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="small muted" style={{ textAlign: 'right' }}>
        {value.length}/{maxLen}
      </div>
      <button className="btn orange" disabled={value.trim().length === 0} onClick={onSubmit}>
        {cta}
      </button>
    </div>
  );
}

function VoteCard({
  title,
  options,
  ownId,
  onVote,
}: {
  title: string;
  options: Array<{ id: string; label: string }>;
  ownId: string | null | undefined;
  onVote: (id: string) => void;
}) {
  const [sel, setSel] = useState<string | null>(null);
  return (
    <div className="card stack">
      <h2>{title}</h2>
      <div className="options">
        {options.map((o) => {
          const own = o.id === ownId;
          return (
            <button
              key={o.id}
              className={`opt ${sel === o.id ? 'selected' : ''} ${own ? 'disabled' : ''}`}
              disabled={own}
              onClick={() => setSel(o.id)}
            >
              {o.label}
              {own ? ' (yours)' : ''}
            </button>
          );
        })}
      </div>
      <button className="btn orange" disabled={!sel} onClick={() => sel && onVote(sel)}>
        Cast vote
      </button>
    </div>
  );
}

function RoleCard({ role, secret }: { role?: string; secret?: Record<string, unknown> }) {
  if (role === 'outsider')
    return (
      <div className="card" style={{ borderColor: 'var(--orange)' }}>
        <div className="pill" style={{ background: '#ffe1d7', color: '#a3382d' }}>
          You are the OUTSIDER
        </div>
        <p style={{ margin: '8px 0 0' }}>
          You only know the category: <strong>{String(secret?.category)}</strong>. Blend in with vague clues — and secretly work out the real
          location.
        </p>
      </div>
    );
  return (
    <div className="card" style={{ borderColor: 'var(--good)' }}>
      <div className="pill">Insider</div>
      <p style={{ margin: '8px 0 0' }}>
        The location is <strong>{String(secret?.location)}</strong>. Give clues that prove you know it — without making it obvious to the outsider.
      </p>
    </div>
  );
}

function ClueList({ game, nameOf }: { game: NonNullable<RoomProjection['game']>; nameOf: (id: string | null) => string }) {
  const prompt = (game.prompt ?? {}) as { clues?: Array<{ memberId: string; wave: number; text: string }> };
  const clues = prompt.clues ?? [];
  if (clues.length === 0) return null;
  return (
    <div className="card stack" style={{ gap: 6 }}>
      <h2>Clues so far</h2>
      {clues.map((c, i) => (
        <div key={i} className="small">
          <strong>{nameOf(c.memberId)}:</strong> {c.text}
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------
// Shared board (TV) view of an input phase — public info only.
// --------------------------------------------------------------------------
function BoardPhase({
  game,
  nameOf,
  projection,
}: {
  game: NonNullable<RoomProjection['game']>;
  nameOf: (id: string | null) => string;
  projection: RoomProjection;
}) {
  const prompt = (game.prompt ?? {}) as Record<string, unknown>;
  const headline =
    game.gameType === 'caption_court'
      ? String(prompt.scenario)
      : game.gameType === 'close_call'
        ? String(prompt.text)
        : game.gameType === 'alibi_club'
          ? `Category: ${String(prompt.category)}`
          : String(prompt.question ?? 'Get ready…');
  return (
    <div className="stack">
      <div className="card">
        <div className="eyebrow">{game.phaseKind}</div>
        <h2 style={{ fontSize: 26 }}>{headline}</h2>
      </div>
      {game.gameType === 'alibi_club' && <ClueList game={game} nameOf={nameOf} />}
      <div className="card">
        <Members projection={projection} />
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Reveals
// --------------------------------------------------------------------------
function Reveal({
  game,
  nameOf,
  selfId,
}: {
  game: NonNullable<RoomProjection['game']>;
  nameOf: (id: string | null | undefined) => string;
  selfId?: string;
}) {
  const r = (game.reveal ?? {}) as Record<string, unknown>;

  if (game.gameType === 'majority_report') {
    const counts = (r.counts ?? {}) as Record<string, number>;
    const modal = (r.modal ?? []) as string[];
    const options = game.options ?? [];
    const total = Object.values(counts).reduce((s, n) => s + n, 0) || 1;
    const correct = (r.correctMemberIds ?? []) as string[];
    return (
      <div className="card stack">
        <h2>The room said…</h2>
        {r.voided ? (
          <div className="notice">Not enough answers — round voided.</div>
        ) : (
          <>
            {options.map((o) => {
              const c = counts[o.id] ?? 0;
              return (
                <div key={o.id} className={`reveal-item ${modal.includes(o.id) ? 'win' : ''}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{o.label}</span>
                    <strong>{c}</strong>
                  </div>
                  <div className="timer" style={{ marginTop: 6 }}>
                    <i style={{ width: `${(c / total) * 100}%`, background: modal.includes(o.id) ? 'var(--teal)' : '#9db8ae' }} />
                  </div>
                </div>
              );
            })}
            <p className="muted">{correct.length} forecaster(s) read the room correctly (+100 each).</p>
          </>
        )}
      </div>
    );
  }

  if (game.gameType === 'bluff_bureau' || game.gameType === 'caption_court') {
    const options = (r.options ?? []) as Array<{ id: string; text: string; authorMemberId: string | null; isTruth?: boolean; votes: number }>;
    const sorted = [...options].sort((a, b) => b.votes - a.votes);
    return (
      <div className="card stack">
        <h2>{game.gameType === 'bluff_bureau' ? 'The truth revealed' : 'The votes are in'}</h2>
        {(r.voided as boolean) && <div className="notice">Not enough entries — round voided.</div>}
        {sorted.map((o) => (
          <div key={o.id} className={`reveal-item ${o.isTruth ? 'truth' : ''}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{o.text}</span>
              <strong>{o.votes} ▲</strong>
            </div>
            <div className="small muted">
              {o.isTruth ? 'The real answer' : `by ${nameOf(o.authorMemberId)}`}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (game.gameType === 'link_up') {
    const groups = (r.groups ?? []) as Array<{ members: Array<{ memberId: string; choice: string | null }>; score: number }>;
    return (
      <div className="card stack">
        <h2>Did you link up?</h2>
        {groups.map((grp, i) => {
          const mine = grp.members.some((m) => m.memberId === selfId);
          return (
            <div key={i} className={`reveal-item ${grp.score > 0 ? 'win' : ''}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>
                  {grp.members.map((m) => nameOf(m.memberId)).join(' + ')}
                  {mine ? ' (you)' : ''}
                </span>
                <strong>{grp.score}</strong>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (game.gameType === 'alibi_club') {
    const uniqueConvict = r.uniqueConvict as boolean;
    return (
      <div className="card stack">
        <h2>Case closed</h2>
        <p>
          The outsider was <strong>{nameOf(r.outsiderMemberId as string)}</strong>. The location was <strong>{String(r.location)}</strong>.
        </p>
        <div className={`reveal-item ${uniqueConvict ? 'truth' : ''}`}>
          {uniqueConvict ? 'The room convicted the outsider! Insiders +100 each.' : 'The outsider escaped a clear conviction (+50).'}
        </div>
        <div className={`reveal-item ${r.guessedCorrect ? 'truth' : ''}`}>
          Outsider guessed <strong>{String(r.outsiderGuess ?? '—')}</strong> — {r.guessedCorrect ? 'correct! (+50)' : 'wrong.'}
        </div>
      </div>
    );
  }

  if (game.gameType === 'close_call') {
    const answer = r.answer as number;
    const estimates = (r.estimates ?? {}) as Record<string, number>;
    const scores = (r.scores ?? {}) as Record<string, number>;
    return (
      <div className="card stack">
        <h2>The answer was {answer}</h2>
        {Object.entries(estimates)
          .sort((a, b) => (scores[b[0]] ?? 0) - (scores[a[0]] ?? 0))
          .map(([mid, val]) => (
            <div key={mid} className={`reveal-item ${(scores[mid] ?? 0) === 100 ? 'truth' : (scores[mid] ?? 0) > 0 ? 'win' : ''}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>
                  {nameOf(mid)}
                  {mid === selfId ? ' (you)' : ''}: {val}
                </span>
                <strong>+{scores[mid] ?? 0}</strong>
              </div>
            </div>
          ))}
      </div>
    );
  }

  return <div className="card">Revealing…</div>;
}

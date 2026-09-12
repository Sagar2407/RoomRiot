/**
 * The game-module contract (blueprint §9):
 *   manifest, initialState(context), validateAction(state, actor, action),
 *   reduce(state, action, serverTime), projectFor(state, viewer), score(finalState).
 *
 * Rules are deterministic given persisted random choices and accepted actions,
 * so the server can rebuild any game by replaying its action log.
 */
import type { GamePublicView, GamePrivateView, GameType } from '@roomriot/contracts';
import type { RNG } from './rng.js';

/** A reviewed content item (see @roomriot/content). `data` is game-specific. */
export interface ContentItem {
  id: string;
  version: number;
  gameType: GameType;
  locale: string;
  maturity: 'everyone' | 'adult';
  tags: string[];
  author: string;
  reviewState: 'published';
  /** Game-specific payload; typed by each game module. */
  data: unknown;
}

export interface GameManifest {
  type: GameType;
  title: string;
  family: string;
  minPlayers: number;
  maxPlayers: number;
  /** Published maximum raw score M used by Night Points conversion. */
  maxRaw: number;
  summary: string;
  /** One worked example shown on the game card (blueprint §7). */
  example: string;
}

/** The current phase of a game. The server owns the wall-clock deadline. */
export interface PhaseSpec {
  /** Unique within the game instance; used as the persistence key. */
  id: string;
  /** Rendered phase kind, e.g. 'writing' | 'choosing' | 'voting' | 'reveal'. */
  kind: string;
  round: number;
  /** Base duration in ms; the server multiplies by the room's timerScale. */
  durationMs: number;
  /**
   * When true, the server auto-advances the phase as soon as every active member
   * has satisfied its input requirement (module.allInputsIn). Reveal/interstitial
   * phases set this false and simply run down their timer.
   */
  collectsInput: boolean;
}

export interface BaseGameState {
  gameType: GameType;
  status: 'active' | 'complete';
  round: number;
  totalRounds: number;
  phase: PhaseSpec;
}

export interface GameMember {
  memberId: string;
  seat: number;
  nickname: string;
}

export interface InitContext {
  members: GameMember[];
  /** Deterministic RNG seeded from the game instance's stored seed. */
  rng: RNG;
  /** Content already filtered to this game type and selected by the server. */
  content: ContentItem[];
}

/** A validated player command handed to the module. */
export interface GameAction {
  memberId: string;
  type: string;
  payload: unknown;
}

/** Server-issued phase advance (deadline reached or all inputs collected). */
export interface AdvanceAction {
  type: '__advance';
  reason: 'timeout' | 'all_in';
}

export type ReduceAction = GameAction | AdvanceAction;

export interface ReduceContext {
  /** Members currently connected & active (roster locked at game start). */
  activeMemberIds: string[];
  rng: RNG;
}

export type Validation = { ok: true } | { ok: false; code: ValidationCode; message: string };
export type ValidationCode =
  | 'wrong_phase'
  | 'invalid_payload'
  | 'not_permitted'
  | 'duplicate';

export interface GameScoreResult {
  /** Effective maximum raw score for this instance (reduced by voided rounds). */
  max: number;
  entries: Array<{ memberId: string; raw: number }>;
  /** Optional skill awards contributed to the night recap. */
  awards?: Array<{ key: string; title: string; memberId: string | null; detail: string }>;
}

export interface GameModule<S extends BaseGameState = BaseGameState> {
  type: GameType;
  manifest: GameManifest;
  /** Choose the content this instance needs from the published bank. */
  selectContent(all: ContentItem[], rng: RNG, memberCount: number): ContentItem[];
  initialState(ctx: InitContext): S;
  validateAction(state: S, memberId: string, action: GameAction): Validation;
  reduce(state: S, action: ReduceAction, ctx: ReduceContext): S;
  /** True when the current input phase has everything it needs to settle early. */
  allInputsIn(state: S, activeMemberIds: string[]): boolean;
  projectPublic(state: S): GamePublicView;
  projectPrivate(state: S, memberId: string): GamePrivateView;
  score(state: S): GameScoreResult;
}

export function isAdvance(a: ReduceAction): a is AdvanceAction {
  return a.type === '__advance';
}

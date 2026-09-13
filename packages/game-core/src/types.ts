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
  /**
   * Server-authoritative cryptographic shuffle for card games (plan §4.5). The
   * dealt order is baked into the persisted state and never sent to the client.
   * Tests inject a deterministic shuffle.
   */
  shuffle?: <T>(arr: readonly T[]) => T[];
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
  /**
   * Server-authoritative cryptographic d6 (1–6), provided for board/dice games.
   * Call it only when a roll is actually needed; the result is baked into the
   * persisted state snapshot, so a restart loads the applied outcome and never
   * rerolls (see docs/adr/0001-indian-classics.md, plan §4.5).
   */
  rollDie?: () => number;
  /** Server-authoritative cryptographic shuffle for card games (deal / redeal). */
  shuffle?: <T>(arr: readonly T[]) => T[];
}

/** One seat's finishing position in a placement (ranking) game. Ties share a rank. */
export interface PlacementStanding {
  memberId: string;
  /** 1-based finishing rank; tied seats share the same rank. */
  rank: number;
  /** Native metric for display (final board position, token progress, net chips). */
  metric?: number;
}

/**
 * A placement result for ranking games (Snakes, Ludo, Teen Patti, Judgement),
 * converted to Night Points by the room's scoring adapter — never through the
 * performance-based `toNightPoints()` path (plan §9).
 */
export interface PlacementResult {
  standings: PlacementStanding[];
  awards?: Array<{ key: string; title: string; memberId: string | null; detail: string }>;
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
  /**
   * How the module collects input. 'simultaneous' (the default, all six original
   * games) collects from every active seat at once; 'sequential' games (board/card
   * games) expect one actor per phase — the active seat, independent of who else is
   * connected (plan §4.1).
   */
  interactionMode?: 'simultaneous' | 'sequential';
  /**
   * How results convert to Night Points. 'performance' (default) uses raw/max via
   * `toNightPoints()`; 'placement' produces native standings converted by the
   * placement adapter (plan §9). A placement module implements `placement()`.
   */
  resultKind?: 'performance' | 'placement';
  /** Choose the content this instance needs from the published bank. */
  selectContent(all: ContentItem[], rng: RNG, memberCount: number): ContentItem[];
  initialState(ctx: InitContext): S;
  validateAction(state: S, memberId: string, action: GameAction): Validation;
  reduce(state: S, action: ReduceAction, ctx: ReduceContext): S;
  /** True when the current input phase has everything it needs to settle early. */
  allInputsIn(state: S, activeMemberIds: string[]): boolean;
  projectPublic(state: S): GamePublicView;
  projectPrivate(state: S, memberId: string): GamePrivateView;
  /** Performance scoring (raw/max). Placement games may return an empty result. */
  score(state: S): GameScoreResult;
  /** Native standings for placement games; required when resultKind === 'placement'. */
  placement?(state: S): PlacementResult;
}

export function isAdvance(a: ReduceAction): a is AdvanceAction {
  return a.type === '__advance';
}

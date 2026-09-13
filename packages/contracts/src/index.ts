/**
 * @roomriot/contracts
 *
 * Shared, transport-level contracts between the web client and the authoritative
 * game server. These types are intentionally UI- and storage-agnostic so a future
 * native (Expo) client can reuse them unchanged (blueprint §8, §13).
 *
 * Identity is always derived from the verified session on the server — never from
 * a client-supplied member/player id (blueprint §9 "API surface").
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const SCORING_VERSION = 'np-2026-09-1';

/** The six launch games (blueprint §5). */
export const GAME_TYPES = [
  'majority_report',
  'bluff_bureau',
  'caption_court',
  'link_up',
  'alibi_club',
  'close_call',
] as const;
export type GameType = (typeof GAME_TYPES)[number];

export const GAME_FAMILY: Record<GameType, string> = {
  majority_report: 'Predictions',
  bluff_bureau: 'Bluffing',
  caption_court: 'Creative',
  link_up: 'Teamwork',
  alibi_club: 'Deduction',
  close_call: 'Predictions',
};

/** Room lifecycle. */
export type RoomStatus = 'lobby' | 'in_game' | 'intermission' | 'complete';

// ---------------------------------------------------------------------------
// Monetization (blueprint §14). Guests always join free; the host buys the
// experience for the room. The free tier is a complete short night of rotating
// games; the Party Pass unlocks all launch games for 24 hours.
// ---------------------------------------------------------------------------

export type Tier = 'free' | 'party_pass';
export const FREE_NIGHT_GAMES = 3;
export const PARTY_PASS = {
  product: 'party_pass' as const,
  priceUsd: 4.99,
  durationHours: 24,
  label: 'Party Pass',
  unlocks: 'All launch games and host customization for 24 hours from activation.',
};

export interface EntitlementStatus {
  tier: Tier;
  partyPass: { active: boolean; validUntil: number } | null;
  /** The rotating free trio available right now. */
  freeGames: GameType[];
  offer: { product: string; priceUsd: number; durationHours: number; label: string; unlocks: string };
}

/** Membership role. Host controls can be exercised from the same device used to play. */
export type MemberRole = 'host' | 'player';

// ---------------------------------------------------------------------------
// HTTP contracts
// ---------------------------------------------------------------------------

export const RoomSettingsSchema = z.object({
  /** Curated playlist of games for the night; defaults to all six. */
  playlist: z.array(z.enum(GAME_TYPES)).min(1).max(12),
  /** Familiarity affects nothing mechanical yet; recorded for later Party Director. */
  familiarity: z.enum(['new_crowd', 'friends', 'close_circle']).default('friends'),
  vibe: z.enum(['clever', 'chaotic', 'cooperative']).default('clever'),
  /** Accessibility: multiply every phase deadline by this factor (>= 1). */
  timerScale: z.number().min(1).max(4).default(1),
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

export const CreateRoomRequestSchema = z.object({
  nickname: z.string().trim().min(1).max(24),
  settings: RoomSettingsSchema.partial().optional(),
  /** Optional existing guest token to keep the same identity across rooms. */
  guestToken: z.string().optional(),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const JoinRoomRequestSchema = z.object({
  code: z.string().trim().min(4).max(8),
  nickname: z.string().trim().min(1).max(24),
  guestToken: z.string().optional(),
});
export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>;

/** Returned by POST /rooms and /rooms/join — the client's scoped credentials. */
export interface MembershipCredentials {
  guestToken: string;
  memberToken: string;
  roomId: string;
  code: string;
  memberId: string;
  role: MemberRole;
  nickname: string;
  seat: number;
}

// ---------------------------------------------------------------------------
// Socket contracts (blueprint §9 "API surface")
// ---------------------------------------------------------------------------

/** `game.action` — a command from a client. */
export const ClientActionSchema = z.object({
  /** Unique per logical action; reused verbatim on retry for idempotency (§10). */
  actionId: z.string().min(8).max(64),
  type: z.string().min(1).max(48),
  /** Present for game moves; absent for lobby/host lifecycle actions. */
  gameId: z.string().optional(),
  phaseId: z.string().optional(),
  /** Host transitions carry the version they expect to act on. */
  expectedVersion: z.number().int().nonnegative().optional(),
  payload: z.unknown().optional(),
});
export type ClientAction = z.infer<typeof ClientActionSchema>;

export type ActionRejectionCode =
  | 'unauthorized'
  | 'not_found'
  | 'wrong_phase'
  | 'deadline_passed'
  | 'invalid_payload'
  | 'version_conflict'
  | 'duplicate'
  | 'not_permitted'
  | 'internal_error';

/** `action.result` — server's acknowledgement of a command. */
export interface ActionResult {
  actionId: string;
  accepted: boolean;
  reason?: ActionRejectionCode;
  message?: string;
  /** Current stream sequence after applying (or rejecting) the action. */
  sequence: number;
}

// ---------------------------------------------------------------------------
// Projections — what a viewer is authorized to see (blueprint §8).
// The public projection carries only already-revealed information. The private
// overlay adds only the viewer's own secret instructions.
// ---------------------------------------------------------------------------

export interface MemberView {
  memberId: string;
  nickname: string;
  seat: number;
  role: MemberRole;
  connected: boolean;
  active: boolean;
  /** Whether this member has satisfied the current phase's input requirement. */
  submitted: boolean;
}

export interface ScoreLine {
  memberId: string;
  nickname: string;
  /** Night Points earned per counted game, in playlist order. */
  perGame: Array<{ gameType: GameType; points: number | null }>;
  total: number;
  /** True when the member has a valid result in every counted game (§6). */
  official: boolean;
  /** Persistent XP earned this night (20/game + 5/achievement, §6). */
  xp?: number;
}

/**
 * Per-game public view. Shape is game-specific but always JSON-serialisable and
 * free of secrets. The `phase` field drives what the controller renders.
 */
export interface GamePublicView {
  gameType: GameType;
  round: number;
  totalRounds: number;
  /** e.g. 'writing' | 'choosing' | 'voting' | 'reveal' | 'discussion'. */
  phaseKind: string;
  prompt?: unknown;
  /** Options visible during a choose/vote phase (order may vary per viewer). */
  options?: Array<{ id: string; label: string }>;
  /** Populated only during/after a reveal phase. */
  reveal?: unknown;
}

/** Private overlay for one member (their secret role / instruction / assignment). */
export interface GamePrivateView {
  /** e.g. hidden role, partner id, per-viewer option ordering. */
  secret?: unknown;
  /** Whether the current phase still expects input from this member. */
  awaitingInput: boolean;
}

/** `room.state` — the authorized projection for a member or display token. */
export interface RoomProjection {
  protocolVersion: number;
  sequence: number;
  serverTime: number;
  roomId: string;
  code: string;
  status: RoomStatus;
  settings: RoomSettings;
  scoringVersion: string;
  /** Whether this room is a free night or a Party Pass night (blueprint §14). */
  tier: Tier;
  hostMemberId: string;
  members: MemberView[];
  playlist: GameType[];
  /** Index of the current/last game in the playlist. */
  playlistIndex: number;
  /** Absolute server ms deadline for the current phase, if any. */
  deadlineAt: number | null;
  /** Present while a game is running. */
  game: GamePublicView | null;
  /** Only present in a per-member projection (never on the display token). */
  self?: {
    memberId: string;
    role: MemberRole;
    private: GamePrivateView | null;
  };
  scoreboard: ScoreLine[];
  /** Set once the night is complete. */
  awards?: Award[];
}

export interface Award {
  key: string;
  title: string;
  memberId: string | null;
  nickname: string | null;
  detail: string;
}

/** `room.resync` request payload. */
export interface ResyncRequest {
  lastSequence: number;
}

// ---------------------------------------------------------------------------
// Socket.IO event map (typed both ends)
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  'room.state': (projection: RoomProjection) => void;
  'action.result': (result: ActionResult) => void;
  'room.error': (payload: { message: string }) => void;
}

export interface ClientToServerEvents {
  'game.action': (action: ClientAction, ack?: (result: ActionResult) => void) => void;
  'room.resync': (req: ResyncRequest) => void;
}

/** Handshake auth passed in `io(url, { auth })`. */
export interface SocketAuth {
  memberToken?: string;
  displayToken?: string;
}

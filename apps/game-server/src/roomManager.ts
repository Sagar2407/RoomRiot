/**
 * RoomManager — the authoritative game service (blueprint §8).
 *
 * The server is the only writer of core game state. A client sends an
 * authenticated action; the server validates role, membership, phase, payload and
 * deadline, applies the deterministic reducer, persists the new snapshot, then
 * publishes authorised projections. The browser never sends an authoritative
 * score. Timers, room lifecycle and settlement all live here.
 *
 * Determinism/recovery: every game instance stores a seed. Each reduce/init call
 * builds a fresh RNG seeded by `${seed}:${site}` so shuffles and role assignment
 * are reproducible regardless of how many draws preceded them — a restart rehydrates
 * the JSON snapshot and reschedules from the persisted deadline without reshuffling.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import type { Server as IOServer, Socket } from 'socket.io';
import {
  getGameModule,
  createRng,
  toNightPoints,
  placementToNightPoints,
  buildScoreboard,
  SCORING_VERSION,
  type BaseGameState,
  type GameMember,
  type SettledGame,
} from '@roomriot/game-core';
import { getContentFor } from '@roomriot/content';
import {
  RoomSettingsSchema,
  type RoomSettings,
  type RoomProjection,
  type MemberView,
  type Award,
  type GameType,
  type Tier,
  type ClientAction,
  type ActionResult,
  type ActionRejectionCode,
  PROTOCOL_VERSION,
} from '@roomriot/contracts';
import type { DB } from './db.js';
import { config } from './config.js';
import { issueToken } from './tokens.js';
import { botMoves, isBot } from './bots.js';
import { Analytics } from './analytics.js';
import { resolvePlaylist } from './billing.js';
import { rollDie, shuffle } from './randomness.js';

const XP_PER_GAME = 20;
const XP_PER_ACHIEVEMENT = 5;

interface Member {
  id: string;
  guestId: string;
  nickname: string;
  seat: number;
  role: 'host' | 'player';
  active: boolean;
  connected: boolean;
}
interface GameRuntime {
  id: string;
  gameType: GameType;
  seed: string;
  roster: string[]; // memberIds locked at game start
  state: BaseGameState;
  deadlineAt: number | null;
  settled: boolean;
}
interface Room {
  id: string;
  code: string;
  hostMemberId: string;
  status: 'lobby' | 'in_game' | 'intermission' | 'complete';
  settings: RoomSettings;
  playlist: GameType[];
  playlistIndex: number;
  tier: Tier;
  seed: string;
  members: Map<string, Member>;
  game: GameRuntime | null;
  settledGames: SettledGame[];
  awards: Award[];
  xpByMember: Record<string, number>;
  seq: number;
  timer: NodeJS.Timeout | null;
  expiresAt: number;
  /** Set once the night has completed, so settlement/emit happens exactly once. */
  nightCompleted: boolean;
}

const DEFAULT_SETTINGS: RoomSettings = {
  playlist: config.launchPlaylist as GameType[],
  familiarity: 'friends',
  vibe: 'clever',
  timerScale: 1,
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

export class RoomManager {
  private rooms = new Map<string, Room>();
  private socketsByMember = new Map<string, Socket>();
  private displaySockets = new Map<string, Set<Socket>>();
  /** Recent report timestamps per member, for socket-side report rate limiting. */
  private reportTimes = new Map<string, number[]>();

  constructor(
    private db: DB,
    private io: IOServer,
    readonly analytics: Analytics,
  ) {
    this.rehydrate();
  }

  // ---- lookups -----------------------------------------------------------

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }
  private roomByCode(code: string): Room | undefined {
    const c = code.toUpperCase();
    for (const r of this.rooms.values()) if (r.code === c) return r;
    return undefined;
  }

  // ---- room creation / joining ------------------------------------------

  createRoom(nickname: string, settings: Partial<RoomSettings> | undefined, guestId: string) {
    const merged = RoomSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...(settings ?? {}) });
    // Free tier gets a complete short night of rotating games; a Party Pass
    // unlocks the requested playlist. Resolved once, here — never mid-game (§14).
    const { playlist, tier } = resolvePlaylist(this.db, guestId, merged.playlist);
    merged.playlist = playlist;
    const id = randomUUID();
    const code = this.freshCode();
    const now = Date.now();
    const room: Room = {
      id,
      code,
      hostMemberId: '',
      status: 'lobby',
      settings: merged,
      playlist,
      playlistIndex: 0,
      tier,
      seed: randomBytes(12).toString('hex'),
      members: new Map(),
      game: null,
      settledGames: [],
      awards: [],
      xpByMember: {},
      seq: 0,
      timer: null,
      expiresAt: now + config.roomTtlMs,
      nightCompleted: false,
    };
    this.db
      .prepare(
        `INSERT INTO rooms (id, code, host_member_id, status, settings_json, playlist_json, playlist_index, scoring_version, seed, tier, state_version, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, code, '', room.status, JSON.stringify(merged), JSON.stringify(room.playlist), 0, SCORING_VERSION, room.seed, tier, 0, now, room.expiresAt);
    this.rooms.set(id, room);

    const member = this.insertMember(room, guestId, nickname, 'host');
    room.hostMemberId = member.id;
    this.db.prepare(`UPDATE rooms SET host_member_id = ? WHERE id = ?`).run(member.id, id);
    this.analytics.emit('room_created', { roomId: id, memberId: member.id, rosterSize: 1 });
    return this.credentials(room, member, guestId);
  }

  joinRoom(code: string, nickname: string, guestId: string) {
    const room = this.roomByCode(code);
    if (!room) return { error: 'not_found' as const };

    // Reconnect: an identity that already holds an active seat resumes it.
    const existing = [...room.members.values()].find((m) => m.guestId === guestId && m.active);
    if (existing) return this.credentials(room, existing, guestId);

    // A new seat must fit inside the room's capacity (blueprint §5). Reconnecting
    // members are exempt (handled above) so a full room never locks anyone out.
    if (this.activeCount(room) >= this.roomCapacity(room)) return { error: 'room_full' as const };

    if (room.status !== 'lobby' && room.status !== 'intermission') {
      // Roster locks during a game; late arrivals still get a seat and watch,
      // then play from the next game (blueprint §5).
    }
    const member = this.insertMember(room, guestId, nickname, 'player');
    this.analytics.emit('join_succeeded', {
      roomId: room.id,
      memberId: member.id,
      rosterSize: [...room.members.values()].filter((m) => m.active).length,
    });
    this.touch(room);
    this.broadcast(room);
    return this.credentials(room, member, guestId);
  }

  addBots(roomId: string, count: number): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const capacity = this.roomCapacity(room);
    for (let i = 0; i < count; i++) {
      if (this.activeCount(room) >= capacity) break; // never grow past capacity
      this.insertMember(room, `bot:${randomUUID()}`, botName(room.members.size), 'player');
    }
    this.broadcast(room);
  }

  issueDisplayToken(roomId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return issueToken({ typ: 'display', roomId }, config.roomTtlMs);
  }

  private insertMember(room: Room, guestId: string, nickname: string, role: 'host' | 'player'): Member {
    const seat = Math.max(0, ...[...room.members.values()].map((m) => m.seat)) + 1;
    const member: Member = {
      id: randomUUID(),
      guestId,
      nickname: nickname.slice(0, 24),
      seat,
      role,
      active: true,
      connected: false,
    };
    this.db
      .prepare(`INSERT INTO members (id, room_id, guest_id, nickname, seat, role, active, joined_at) VALUES (?,?,?,?,?,?,1,?)`)
      .run(member.id, room.id, guestId, member.nickname, seat, role, Date.now());
    room.members.set(member.id, member);
    return member;
  }

  private credentials(room: Room, member: Member, guestId: string) {
    return {
      credentials: {
        guestToken: issueToken({ typ: 'guest', guestId }),
        memberToken: issueToken({ typ: 'member', guestId, memberId: member.id, roomId: room.id }),
        roomId: room.id,
        code: room.code,
        memberId: member.id,
        role: member.role,
        nickname: member.nickname,
        seat: member.seat,
      },
    };
  }

  private freshCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!this.roomByCode(code) && !this.db.prepare(`SELECT 1 FROM rooms WHERE code = ?`).get(code)) return code;
    }
    return randomBytes(4).toString('hex').toUpperCase();
  }

  // ---- socket registry ---------------------------------------------------

  attachMemberSocket(memberId: string, socket: Socket): Room | null {
    const room = [...this.rooms.values()].find((r) => r.members.has(memberId));
    if (!room) return null;
    this.socketsByMember.set(memberId, socket);
    const m = room.members.get(memberId)!;
    // Re-attaching once a night is underway is a reconnect, not a first join.
    if (room.status !== 'lobby') this.analytics.emit('reconnect_succeeded', { roomId: room.id, memberId });
    m.connected = true;
    this.broadcast(room);
    return room;
  }
  attachDisplaySocket(roomId: string, socket: Socket): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    let set = this.displaySockets.get(roomId);
    if (!set) this.displaySockets.set(roomId, (set = new Set()));
    set.add(socket);
    socket.emit('room.state', this.project(room, { kind: 'display' }));
    return room;
  }
  detachSocket(socket: Socket): void {
    for (const [memberId, s] of this.socketsByMember) {
      if (s === socket) {
        this.socketsByMember.delete(memberId);
        const room = [...this.rooms.values()].find((r) => r.members.has(memberId));
        if (room) {
          const m = room.members.get(memberId)!;
          m.connected = false;
          this.broadcast(room);
        }
      }
    }
    for (const set of this.displaySockets.values()) set.delete(socket);
  }

  // ---- action handling ---------------------------------------------------

  handleAction(memberId: string, roomId: string, action: ClientAction): ActionResult {
    const room = this.rooms.get(roomId);
    if (!room) return this.reject(action, 'not_found', 'Room not found', 0);

    // Idempotency: a retried actionId returns the recorded outcome, never re-applies.
    const prior = this.db.prepare(`SELECT accepted, reason FROM actions WHERE action_id = ?`).get(action.actionId) as
      | { accepted: number; reason: string | null }
      | undefined;
    if (prior) {
      return { actionId: action.actionId, accepted: prior.accepted === 1, reason: (prior.reason as ActionRejectionCode) ?? undefined, sequence: room.seq };
    }

    const member = room.members.get(memberId);
    if (!member || !member.active) return this.recordAndReject(room, action, memberId, 'unauthorized', 'Not a member');

    // Host lifecycle actions.
    if (action.type === 'start_night' || action.type === 'next' || action.type === 'end_night' || action.type === 'add_bot') {
      if (member.role !== 'host') return this.recordAndReject(room, action, memberId, 'not_permitted', 'Host only');
      return this.hostAction(room, action, memberId);
    }

    // Reporting is available to any active member at any time (blueprint §7, §12).
    if (action.type === 'report_content') {
      return this.reportContent(room, action, memberId);
    }

    // Game moves must name the exact game + phase they target, so a tap that
    // lands after the timer closes or the phase advances is rejected — never
    // silently applied to the next round (blueprint §8, §10).
    const g = room.game;
    if (!g || room.status !== 'in_game') return this.recordAndReject(room, action, memberId, 'wrong_phase', 'No active game');
    if (!action.phaseId || action.phaseId !== g.state.phase.id)
      return this.recordAndReject(room, action, memberId, 'wrong_phase', 'This round has already moved on');
    if (action.gameId && action.gameId !== g.id)
      return this.recordAndReject(room, action, memberId, 'wrong_phase', 'This game has already moved on');
    if (!g.roster.includes(memberId))
      return this.recordAndReject(room, action, memberId, 'not_permitted', 'Not seated in this game');
    if (g.deadlineAt && Date.now() > g.deadlineAt)
      return this.recordAndReject(room, action, memberId, 'deadline_passed', 'The timer has closed this phase');

    const mod = getGameModule(g.gameType);
    const gameAction = { memberId, type: action.type, payload: action.payload };
    const v = mod.validateAction(g.state, memberId, gameAction);
    if (!v.ok) return this.recordAndReject(room, action, memberId, mapCode(v.code), v.message);

    const rng = createRng(`${g.seed}:${g.state.phase.id}:move`);
    g.state = mod.reduce(g.state, gameAction, { activeMemberIds: this.activeRoster(room, g), rng, rollDie, shuffle });
    this.persistGame(room, g);
    this.recordAction(room, action, memberId, true, null);

    // Early settle when every active roster member has satisfied the phase.
    if (g.state.phase.collectsInput && mod.allInputsIn(g.state, this.activeRoster(room, g))) {
      this.advancePhase(room, 'all_in');
    } else {
      this.touch(room);
      this.broadcast(room);
    }
    return { actionId: action.actionId, accepted: true, sequence: room.seq };
  }

  private hostAction(room: Room, action: ClientAction, memberId: string): ActionResult {
    if (action.type === 'start_night') {
      if (room.status === 'lobby') {
        const idx = this.nextPlayableIndex(room, 0);
        if (idx < 0) {
          const need = Math.min(...room.playlist.map((t) => getGameModule(t).manifest.minPlayers));
          return this.recordAndReject(room, action, memberId, 'not_permitted', `Need at least ${need} players to start — add more players or a fictional player.`);
        }
        room.playlistIndex = idx;
        this.startGame(room);
      }
    } else if (action.type === 'next') {
      if (room.status === 'intermission') {
        const idx = this.nextPlayableIndex(room, room.playlistIndex + 1);
        if (idx < 0) {
          this.completeNight(room);
        } else {
          room.playlistIndex = idx;
          this.startGame(room);
        }
      }
    } else if (action.type === 'end_night') {
      this.completeNight(room);
    } else if (action.type === 'add_bot') {
      if (room.status === 'lobby' || room.status === 'intermission') this.addBots(room.id, 1);
    }
    this.recordAction(room, action, memberId, true, null);
    this.touch(room);
    this.broadcast(room);
    return { actionId: action.actionId, accepted: true, sequence: room.seq };
  }

  // ---- game lifecycle ----------------------------------------------------

  private startGame(room: Room): void {
    const gameType = room.playlist[room.playlistIndex]!;
    const mod = getGameModule(gameType);
    const roster: Member[] = [...room.members.values()].filter((m) => m.active).sort((a, b) => a.seat - b.seat);
    const members: GameMember[] = roster.map((m) => ({ memberId: m.id, seat: m.seat, nickname: m.nickname }));
    const seed = `${room.seed}:${room.playlistIndex}:${gameType}`;
    const content = mod.selectContent(getContentFor(gameType), createRng(`${seed}:select`), members.length);
    const state = mod.initialState({ members, rng: createRng(`${seed}:init`), content, shuffle });

    const g: GameRuntime = {
      id: randomUUID(),
      gameType,
      seed,
      roster: members.map((m) => m.memberId),
      state,
      deadlineAt: null,
      settled: false,
    };
    room.game = g;
    room.status = 'in_game';
    this.db
      .prepare(
        `INSERT INTO game_instances (id, room_id, playlist_index, game_type, rules_version, seed, state_json, phase_id, roster_json, deadline_at, status, settled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      )
      .run(g.id, room.id, room.playlistIndex, gameType, SCORING_VERSION, seed, JSON.stringify(state), state.phase.id, JSON.stringify(g.roster), null, 'active', Date.now());
    this.db.prepare(`UPDATE rooms SET status = ?, playlist_index = ? WHERE id = ?`).run(room.status, room.playlistIndex, room.id);
    this.analytics.emit('game_started', {
      roomId: room.id,
      gameType,
      rulesVersion: SCORING_VERSION,
      rosterSize: members.length,
    });
    this.schedulePhase(room);
    this.broadcast(room);
  }

  private schedulePhase(room: Room): void {
    const g = room.game;
    if (!g) return;
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
    const durationMs = Math.round(g.state.phase.durationMs * room.settings.timerScale);
    g.deadlineAt = Date.now() + durationMs;
    this.persistGame(room, g);

    room.timer = setTimeout(() => {
      const cur = this.rooms.get(room.id);
      if (cur && cur.game && cur.game.id === g.id && cur.game.state.phase.id === g.state.phase.id) {
        this.advancePhase(cur, 'timeout');
      }
    }, Math.max(0, durationMs));
    if (typeof room.timer.unref === 'function') room.timer.unref();

    // Fictional practice/testing players act as soon as an input phase opens.
    this.runBots(room);
  }

  private advancePhase(room: Room, reason: 'timeout' | 'all_in'): void {
    const g = room.game;
    if (!g) return;
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
    const mod = getGameModule(g.gameType);
    const endingPhase = g.state.phase;
    this.analytics.emit('phase_completed', {
      roomId: room.id,
      gameType: g.gameType,
      reason,
      durationMs: Math.round(endingPhase.durationMs * room.settings.timerScale),
      meta: { phaseKind: endingPhase.kind, round: endingPhase.round },
    });
    const rng = createRng(`${g.seed}:${g.state.phase.id}:advance`);
    g.state = mod.reduce(g.state, { type: '__advance', reason }, { activeMemberIds: this.activeRoster(room, g), rng, rollDie, shuffle });
    this.persistGame(room, g);

    if (g.state.status === 'complete') {
      this.settleGame(room);
      room.status = room.playlistIndex + 1 < room.playlist.length ? 'intermission' : 'complete';
      if (room.status === 'complete') this.completeNight(room);
      this.db.prepare(`UPDATE rooms SET status = ? WHERE id = ?`).run(room.status, room.id);
      this.touch(room);
      this.broadcast(room);
    } else {
      this.schedulePhase(room);
      this.broadcast(room);
    }
  }

  private settleGame(room: Room): void {
    const g = room.game;
    if (!g || g.settled) return;
    const mod = getGameModule(g.gameType);
    // Placement games (board/card) convert native standings through the pure
    // placement adapter; performance games use raw/max (plan §9).
    let np: Array<{ memberId: string; raw: number; nightPoints: number }>;
    let awards: Array<{ key: string; title: string; memberId: string | null; detail: string }>;
    if (mod.resultKind === 'placement' && mod.placement) {
      const pr = mod.placement(g.state);
      np = placementToNightPoints(pr.standings);
      awards = pr.awards ?? [];
    } else {
      const result = mod.score(g.state);
      np = toNightPoints(result.entries, result.max);
      awards = result.awards ?? [];
    }

    const insertLedger = this.db.prepare(
      `INSERT OR IGNORE INTO score_ledger (settlement_key, room_id, game_instance_id, member_id, game_type, raw, night_points, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const insertAward = this.db.prepare(
      `INSERT OR IGNORE INTO awards (id, room_id, game_instance_id, award_key, title, member_id, detail) VALUES (?,?,?,?,?,?,?)`,
    );
    const insertXp = this.db.prepare(
      `INSERT OR IGNORE INTO xp_ledger (award_key, room_id, guest_id, member_id, source, amount, created_at) VALUES (?,?,?,?,?,?,?)`,
    );
    const now = Date.now();
    const txn = this.db.transaction(() => {
      for (const e of np) {
        insertLedger.run(`${room.id}:${g.id}:${e.memberId}:game`, room.id, g.id, e.memberId, g.gameType, e.raw, e.nightPoints, now);
        // XP: 20 for completing an eligible game (idempotent by award key). §6
        const guestId = room.members.get(e.memberId)?.guestId ?? e.memberId;
        insertXp.run(`${room.id}:${g.id}:${e.memberId}:xp_game`, room.id, guestId, e.memberId, 'game_completed', XP_PER_GAME, now);
      }
      for (const a of awards) {
        insertAward.run(randomUUID(), room.id, g.id, a.key, a.title, a.memberId, a.detail);
        // XP: one 5-point achievement bonus per member per game (capped by key). §6
        if (a.memberId) {
          const guestId = room.members.get(a.memberId)?.guestId ?? a.memberId;
          insertXp.run(`${room.id}:${g.id}:${a.memberId}:xp_ach`, room.id, guestId, a.memberId, 'achievement', XP_PER_ACHIEVEMENT, now);
        }
      }
      this.db.prepare(`UPDATE game_instances SET settled = 1, status = 'complete', state_json = ? WHERE id = ?`).run(JSON.stringify(g.state), g.id);
    });
    txn();
    g.settled = true;
    this.analytics.emit('game_completed', { roomId: room.id, gameType: g.gameType, rulesVersion: SCORING_VERSION, rosterSize: g.roster.length });
    this.reloadScores(room);
  }

  private completeNight(room: Room): void {
    // Exactly once: a second end_night (or one racing the auto-complete of the
    // final game) must not re-emit session_completed or rebuild awards (§10, §16).
    if (room.nightCompleted) return;
    room.nightCompleted = true;
    room.status = 'complete';
    room.game = null;
    this.reloadScores(room);
    const board = buildScoreboard([...room.members.values()].map((m) => ({ memberId: m.id, nickname: m.nickname })), room.playlist, room.settledGames);
    const champion = board.find((l) => l.official) ?? board[0];
    const nightAward: Award = {
      key: 'night_champion',
      title: 'Night Champion',
      memberId: champion?.memberId ?? null,
      nickname: champion?.nickname ?? null,
      detail: champion ? `${champion.total} Night Points` : 'No scores yet',
    };
    room.awards = [nightAward, ...room.awards.filter((a) => a.key !== 'night_champion')];
    this.db.prepare(`UPDATE rooms SET status = 'complete' WHERE id = ?`).run(room.id);
    this.analytics.emit('session_completed', {
      roomId: room.id,
      rosterSize: [...room.members.values()].filter((m) => m.active).length,
      meta: { gamesPlayed: room.settledGames.length },
    });
  }

  private reportContent(room: Room, action: ClientAction, memberId: string): ActionResult {
    // Socket actions bypass the HTTP rate limiter, so guard reports here: a
    // member may file a handful in a short window, no more (blueprint §12).
    if (!this.allowReport(memberId)) {
      return this.recordAndReject(room, action, memberId, 'rate_limited', 'Too many reports — please wait a moment.');
    }
    const p = (action.payload ?? {}) as { reason?: unknown; note?: unknown };
    const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim().slice(0, 64) : 'unspecified';
    const g = room.game;
    const scope = g ? `${g.gameType}:${g.state.phase.kind}:r${g.state.phase.round}` : room.status;
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO reports (id, room_id, reporter_ref, scope, reason, status, created_at, retention_deadline) VALUES (?,?,?,?,?, 'open', ?, ?)`)
      .run(randomUUID(), room.id, this.analytics.ref(memberId), scope, reason, now, now + 30 * 24 * 60 * 60 * 1000);
    this.analytics.emit('content_reported', { roomId: room.id, memberId, gameType: g?.gameType ?? null, reason, meta: { scope } });
    this.recordAction(room, action, memberId, true, null);
    // No broadcast: reports are private to moderation, not surfaced to the room.
    return { actionId: action.actionId, accepted: true, sequence: room.seq };
  }

  // ---- projections -------------------------------------------------------

  project(room: Room, viewer: { kind: 'member'; memberId: string } | { kind: 'display' }): RoomProjection {
    const g = room.game;
    const mod = g ? getGameModule(g.gameType) : null;
    const inRoster = (id: string) => !!g && g.roster.includes(id);

    const members: MemberView[] = [...room.members.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((m) => {
        let submitted = false;
        if (g && mod && g.state.phase.collectsInput && inRoster(m.id)) {
          submitted = mod.projectPrivate(g.state, m.id).awaitingInput === false;
        }
        return {
          memberId: m.id,
          nickname: m.nickname,
          seat: m.seat,
          role: m.role,
          connected: m.connected || isBot(m.guestId),
          active: m.active,
          submitted,
        };
      });

    const scoreboard = buildScoreboard(members.map((m) => ({ memberId: m.memberId, nickname: m.nickname })), room.playlist, room.settledGames);
    for (const line of scoreboard) line.xp = room.xpByMember[line.memberId] ?? 0;

    const projection: RoomProjection = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: room.seq,
      serverTime: Date.now(),
      roomId: room.id,
      code: room.code,
      status: room.status,
      settings: room.settings,
      scoringVersion: SCORING_VERSION,
      tier: room.tier,
      billingEnabled: config.billingEnabled,
      hostMemberId: room.hostMemberId,
      members,
      playlist: room.playlist,
      playlistIndex: room.playlistIndex,
      deadlineAt: g?.deadlineAt ?? null,
      gameId: g?.id ?? null,
      phaseId: g?.state.phase.id ?? null,
      game: g && mod ? mod.projectPublic(g.state) : null,
      scoreboard,
      awards: room.status === 'complete' ? room.awards : undefined,
    };

    if (viewer.kind === 'member') {
      const priv = g && mod && inRoster(viewer.memberId) ? mod.projectPrivate(g.state, viewer.memberId) : null;
      const me = room.members.get(viewer.memberId);
      projection.self = { memberId: viewer.memberId, role: me?.role ?? 'player', private: priv };
    }
    return projection;
  }

  broadcast(room: Room): void {
    room.seq += 1;
    for (const m of room.members.values()) {
      const socket = this.socketsByMember.get(m.id);
      if (socket) socket.emit('room.state', this.project(room, { kind: 'member', memberId: m.id }));
    }
    const displays = this.displaySockets.get(room.id);
    if (displays) {
      const pub = this.project(room, { kind: 'display' });
      for (const s of displays) s.emit('room.state', pub);
    }
  }

  resync(memberId: string | null, roomId: string): RoomProjection | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return this.project(room, memberId ? { kind: 'member', memberId } : { kind: 'display' });
  }

  // ---- helpers -----------------------------------------------------------

  private activeRoster(room: Room, g: GameRuntime): string[] {
    return g.roster.filter((id) => {
      const m = room.members.get(id);
      return !!m && m.active && (m.connected || isBot(m.guestId));
    });
  }

  /** Sliding-window guard: at most 5 reports per member per 5 minutes. */
  private allowReport(memberId: string): boolean {
    const WINDOW_MS = 5 * 60 * 1000;
    const MAX = 5;
    const now = Date.now();
    const times = (this.reportTimes.get(memberId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (times.length >= MAX) {
      this.reportTimes.set(memberId, times);
      return false;
    }
    times.push(now);
    this.reportTimes.set(memberId, times);
    return true;
  }

  /** Active members currently in the room (the seating that will lock at start). */
  private activeCount(room: Room): number {
    let n = 0;
    for (const m of room.members.values()) if (m.active) n++;
    return n;
  }

  /**
   * Effective seat cap: the smaller of the global ceiling and the largest table
   * any game in the playlist supports, so the room never grows past what its
   * games can seat (blueprint §5).
   */
  private roomCapacity(room: Room): number {
    const playlistMax = Math.max(...room.playlist.map((t) => getGameModule(t).manifest.maxPlayers));
    return Math.min(config.roomMaxPlayers, playlistMax);
  }

  /**
   * The first playlist index at or after `from` whose game can actually run with
   * the current roster (respecting each game's minPlayers), or -1 if none can.
   * Games needing more players than are present are skipped rather than started
   * into a broken round (blueprint §5).
   */
  private nextPlayableIndex(room: Room, from: number): number {
    const present = this.activeCount(room);
    for (let i = Math.max(0, from); i < room.playlist.length; i++) {
      if (present >= getGameModule(room.playlist[i]!).manifest.minPlayers) return i;
    }
    return -1;
  }

  private runBots(room: Room): void {
    const g = room.game;
    if (!g || !g.state.phase.collectsInput) return;
    const mod = getGameModule(g.gameType);
    for (const id of g.roster) {
      const m = room.members.get(id);
      if (!m || !isBot(m.guestId)) continue;
      const pub = mod.projectPublic(g.state);
      const priv = mod.projectPrivate(g.state, id);
      if (!priv.awaitingInput) continue;
      const moves = botMoves(g.gameType, pub, priv, id);
      moves.forEach((move, i) => {
        const delay = 400 + Math.floor(Math.random() * 1500) + i * 250;
        const t = setTimeout(() => {
          const cur = this.rooms.get(room.id);
          if (!cur || !cur.game || cur.game.id !== g.id || cur.game.state.phase.id !== g.state.phase.id) return;
          this.handleAction(id, room.id, { actionId: randomUUID(), type: move.type, gameId: g.id, phaseId: g.state.phase.id, payload: move.payload });
        }, delay);
        t.unref?.();
      });
    }
  }

  private reject(action: ClientAction, reason: ActionRejectionCode, message: string, seq: number): ActionResult {
    return { actionId: action.actionId, accepted: false, reason, message, sequence: seq };
  }
  private recordAndReject(room: Room, action: ClientAction, memberId: string, reason: ActionRejectionCode, message: string): ActionResult {
    this.recordAction(room, action, memberId, false, reason);
    return this.reject(action, reason, message, room.seq);
  }
  private recordAction(room: Room, action: ClientAction, memberId: string, accepted: boolean, reason: string | null): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO actions (action_id, room_id, member_id, accepted, reason, created_at) VALUES (?,?,?,?,?,?)`)
      .run(action.actionId, room.id, memberId, accepted ? 1 : 0, reason, Date.now());
  }
  private persistGame(room: Room, g: GameRuntime): void {
    this.db
      .prepare(`UPDATE game_instances SET state_json = ?, phase_id = ?, deadline_at = ?, status = ? WHERE id = ?`)
      .run(JSON.stringify(g.state), g.state.phase.id, g.deadlineAt, g.state.status, g.id);
  }
  private touch(room: Room): void {
    room.expiresAt = Date.now() + config.roomTtlMs;
    this.db.prepare(`UPDATE rooms SET expires_at = ? WHERE id = ?`).run(room.expiresAt, room.id);
  }

  private reloadScores(room: Room): void {
    const rows = this.db
      .prepare(`SELECT game_type, member_id, night_points FROM score_ledger WHERE room_id = ? ORDER BY created_at`)
      .all(room.id) as Array<{ game_type: GameType; member_id: string; night_points: number }>;
    const byType = new Map<GameType, SettledGame>();
    for (const r of rows) {
      let g = byType.get(r.game_type);
      if (!g) byType.set(r.game_type, (g = { gameType: r.game_type, points: {} }));
      g.points[r.member_id] = r.night_points;
    }
    room.settledGames = room.playlist.filter((t) => byType.has(t)).map((t) => byType.get(t)!);

    const awards = this.db
      .prepare(`SELECT award_key, title, member_id, detail FROM awards WHERE room_id = ?`)
      .all(room.id) as Array<{ award_key: string; title: string; member_id: string | null; detail: string }>;
    room.awards = awards.map((a) => ({
      key: a.award_key,
      title: a.title,
      memberId: a.member_id,
      nickname: a.member_id ? (room.members.get(a.member_id)?.nickname ?? null) : null,
      detail: a.detail,
    }));

    const xpRows = this.db
      .prepare(`SELECT member_id, SUM(amount) AS xp FROM xp_ledger WHERE room_id = ? GROUP BY member_id`)
      .all(room.id) as Array<{ member_id: string; xp: number }>;
    room.xpByMember = {};
    for (const r of xpRows) room.xpByMember[r.member_id] = r.xp;
  }

  // ---- startup recovery (blueprint §10) ---------------------------------

  private rehydrate(): void {
    const rooms = this.db.prepare(`SELECT * FROM rooms WHERE expires_at > ?`).all(Date.now()) as Array<Record<string, unknown>>;
    for (const r of rooms) {
      const room: Room = {
        id: r.id as string,
        code: r.code as string,
        hostMemberId: r.host_member_id as string,
        status: r.status as Room['status'],
        settings: JSON.parse(r.settings_json as string),
        playlist: JSON.parse(r.playlist_json as string),
        playlistIndex: r.playlist_index as number,
        tier: ((r.tier as Tier) ?? 'free'),
        seed: r.seed as string,
        members: new Map(),
        game: null,
        settledGames: [],
        awards: [],
        xpByMember: {},
        seq: 0,
        timer: null,
        expiresAt: r.expires_at as number,
        nightCompleted: (r.status as string) === 'complete',
      };
      const members = this.db.prepare(`SELECT * FROM members WHERE room_id = ? ORDER BY seat`).all(room.id) as Array<Record<string, unknown>>;
      for (const m of members) {
        room.members.set(m.id as string, {
          id: m.id as string,
          guestId: m.guest_id as string,
          nickname: m.nickname as string,
          seat: m.seat as number,
          role: m.role as 'host' | 'player',
          active: (m.active as number) === 1,
          connected: false,
        });
      }
      const gi = this.db
        .prepare(`SELECT * FROM game_instances WHERE room_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(room.id) as Record<string, unknown> | undefined;
      if (gi && (gi.status as string) === 'active') {
        const state = JSON.parse(gi.state_json as string) as BaseGameState;
        room.game = {
          id: gi.id as string,
          gameType: gi.game_type as GameType,
          seed: gi.seed as string,
          // The roster locked at game start, restored verbatim — not recomputed
          // from whoever happens to be active now (blueprint §10). Older rows
          // without a stored roster fall back to the active members.
          roster: gi.roster_json
            ? (JSON.parse(gi.roster_json as string) as string[])
            : [...room.members.values()].filter((m) => m.active).map((m) => m.id),
          state,
          deadlineAt: (gi.deadline_at as number | null) ?? null,
          settled: false,
        };
        // An expired phase settles at most once under the same guard as live play.
        const durationLeft = (room.game.deadlineAt ?? Date.now()) - Date.now();
        if (durationLeft <= 0) {
          this.advancePhase(room, 'timeout');
        } else {
          room.timer = setTimeout(() => this.advancePhase(room, 'timeout'), durationLeft);
          room.timer.unref?.();
        }
      }
      this.reloadScores(room);
      this.rooms.set(room.id, room);
    }
  }
}

function mapCode(code: string): ActionRejectionCode {
  switch (code) {
    case 'wrong_phase':
      return 'wrong_phase';
    case 'invalid_payload':
      return 'invalid_payload';
    case 'duplicate':
      return 'duplicate';
    case 'not_permitted':
      return 'not_permitted';
    default:
      return 'invalid_payload';
  }
}

function botName(i: number): string {
  const names = ['Robo Riley', 'Botly', 'Circuit Sam', 'Auto Ana', 'Chip', 'Widget', 'Pixel', 'Data Dan', 'Nib'];
  return names[i % names.length] ?? `Bot ${i}`;
}

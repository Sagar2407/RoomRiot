/**
 * Analytics event stream (blueprint §16).
 *
 * The exact event taxonomy from the blueprint, emitted from the authoritative
 * server at each lifecycle point. Rows carry opaque IDs, versions, roster size,
 * platform, durations and reason codes — and deliberately never carry prompt
 * answers, drinking data, or nicknames. The main success measure is completed
 * group nights whose hosts return, so the funnel below tracks join → activation →
 * completion, not raw minutes.
 */
import { randomUUID, createHmac } from 'node:crypto';
import type { DB } from './db.js';

export const ANALYTICS_EVENTS = [
  'room_created',
  'join_started',
  'join_succeeded',
  'game_started',
  'phase_completed',
  'game_completed',
  'prompt_skipped',
  'reconnect_started',
  'reconnect_succeeded',
  'session_completed',
  'guest_claimed',
  'offer_viewed',
  'purchase_verified',
  'content_reported',
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export interface EventFields {
  roomId?: string | null;
  memberId?: string | null;
  gameType?: string | null;
  rulesVersion?: string | null;
  rosterSize?: number | null;
  platform?: string | null;
  durationMs?: number | null;
  reason?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Proposed initial targets (blueprint §16) — directional, not benchmarks. */
export const METRIC_TARGETS = {
  join_success: '≥ 95%',
  time_to_join: 'median < 30s',
  room_activation: '≥ 70%',
  night_completion: '≥ 60%',
  voluntary_continuation: '≥ 40%',
  host_repeat_30d: '~25% (report cohort counts)',
  severe_reliability_failures: '0 in required recovery scenarios',
} as const;

export class Analytics {
  private insert;
  constructor(
    private db: DB,
    private salt: string,
  ) {
    this.insert = db.prepare(
      `INSERT INTO analytics_events (id, ts, event, room_ref, member_ref, game_type, rules_version, roster_size, platform, duration_ms, reason, meta_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
  }

  /** Stable pseudonym for an id — lets us follow a member through a funnel without storing who they are. */
  ref(id: string | null | undefined): string | null {
    if (!id) return null;
    return createHmac('sha256', this.salt).update(id).digest('hex').slice(0, 16);
  }

  emit(event: AnalyticsEvent, fields: EventFields = {}): void {
    try {
      this.insert.run(
        randomUUID(),
        Date.now(),
        event,
        fields.roomId ? this.ref(fields.roomId) : null,
        fields.memberId ? this.ref(fields.memberId) : null,
        fields.gameType ?? null,
        fields.rulesVersion ?? null,
        fields.rosterSize ?? null,
        fields.platform ?? null,
        fields.durationMs ?? null,
        fields.reason ?? null,
        fields.meta ? JSON.stringify(fields.meta) : null,
      );
    } catch {
      // Analytics must never break gameplay.
    }
  }

  /** The §16 funnel over all recorded rooms. */
  funnel() {
    const count = (event: AnalyticsEvent) =>
      (this.db.prepare(`SELECT COUNT(*) AS c FROM analytics_events WHERE event = ?`).get(event) as { c: number }).c;
    const distinctRooms = (event: AnalyticsEvent) =>
      (this.db.prepare(`SELECT COUNT(DISTINCT room_ref) AS c FROM analytics_events WHERE event = ? AND room_ref IS NOT NULL`).get(event) as {
        c: number;
      }).c;

    const roomsCreated = distinctRooms('room_created');
    const joinStarted = count('join_started');
    const joinSucceeded = count('join_succeeded');
    const roomsActivated = distinctRooms('game_completed'); // reached ≥1 scored reveal
    const nightsCompleted = distinctRooms('session_completed');

    const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

    return {
      generatedAt: new Date().toISOString(),
      counts: {
        rooms_created: roomsCreated,
        join_started: joinStarted,
        join_succeeded: joinSucceeded,
        games_completed: count('game_completed'),
        rooms_activated: roomsActivated,
        nights_completed: nightsCompleted,
        reconnects_succeeded: count('reconnect_succeeded'),
        content_reported: count('content_reported'),
      },
      rates_pct: {
        join_success: rate(joinSucceeded, joinStarted),
        room_activation: rate(roomsActivated, roomsCreated),
        night_completion: rate(nightsCompleted, roomsActivated),
      },
      targets: METRIC_TARGETS,
    };
  }
}

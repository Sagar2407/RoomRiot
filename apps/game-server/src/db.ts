/**
 * SQLite persistence (better-sqlite3), synchronous and transactional.
 *
 * This mirrors the blueprint §9 data model at slice scale: rooms, members,
 * game instances (with a JSON state snapshot + server-owned deadline), an action
 * log for idempotency, and an immutable score ledger with a unique settlement key
 * so a restart mid-settlement can never double-count (blueprint §10). The schema
 * is intentionally close to the Postgres target so migrating to Supabase is a
 * translation, not a redesign.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export type DB = Database.Database;

export function openDb(path = config.dbPath): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  // Backfill columns added after a DB was first created (dev convenience).
  try {
    db.exec(`ALTER TABLE rooms ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'`);
  } catch {
    /* column already exists */
  }
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id            TEXT PRIMARY KEY,
      code          TEXT NOT NULL UNIQUE,
      host_member_id TEXT,
      status        TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      playlist_json TEXT NOT NULL,
      playlist_index INTEGER NOT NULL DEFAULT 0,
      scoring_version TEXT NOT NULL,
      seed          TEXT NOT NULL,
      tier          TEXT NOT NULL DEFAULT 'free',
      state_version INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      id         TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      guest_id   TEXT NOT NULL,
      nickname   TEXT NOT NULL,
      seat       INTEGER NOT NULL,
      role       TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      joined_at  INTEGER NOT NULL,
      UNIQUE (room_id, seat)
    );
    -- One active seat per identity per room (blueprint §6 anti-farming).
    CREATE UNIQUE INDEX IF NOT EXISTS members_room_guest_active
      ON members(room_id, guest_id) WHERE active = 1;

    CREATE TABLE IF NOT EXISTS game_instances (
      id             TEXT PRIMARY KEY,
      room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      playlist_index INTEGER NOT NULL,
      game_type      TEXT NOT NULL,
      rules_version  TEXT NOT NULL,
      seed           TEXT NOT NULL,
      state_json     TEXT NOT NULL,
      phase_id       TEXT NOT NULL,
      deadline_at    INTEGER,
      status         TEXT NOT NULL,
      settled        INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS actions (
      action_id  TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL,
      member_id  TEXT NOT NULL,
      accepted   INTEGER NOT NULL,
      reason     TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS score_ledger (
      settlement_key   TEXT PRIMARY KEY,
      room_id          TEXT NOT NULL,
      game_instance_id TEXT NOT NULL,
      member_id        TEXT NOT NULL,
      game_type        TEXT NOT NULL,
      raw              REAL NOT NULL,
      night_points     INTEGER NOT NULL,
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS awards (
      id               TEXT PRIMARY KEY,
      room_id          TEXT NOT NULL,
      game_instance_id TEXT NOT NULL,
      award_key        TEXT NOT NULL,
      title            TEXT NOT NULL,
      member_id        TEXT,
      detail           TEXT NOT NULL,
      UNIQUE (game_instance_id, award_key)
    );

    -- Persistent XP (blueprint §6). Unique award key makes awards idempotent and
    -- summaries rebuildable; keyed by pseudonymous guest identity, not nickname.
    CREATE TABLE IF NOT EXISTS xp_ledger (
      award_key  TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL,
      guest_id   TEXT NOT NULL,
      member_id  TEXT NOT NULL,
      source     TEXT NOT NULL,
      amount     INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS xp_ledger_guest ON xp_ledger(guest_id);

    -- Reports for moderation (blueprint §12). Narrowly scoped evidence, retained
    -- for review then purged; reporter stored pseudonymously.
    CREATE TABLE IF NOT EXISTS reports (
      id                TEXT PRIMARY KEY,
      room_id           TEXT NOT NULL,
      reporter_ref      TEXT NOT NULL,
      scope             TEXT NOT NULL,
      reason            TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'open',
      created_at        INTEGER NOT NULL,
      retention_deadline INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_room ON reports(room_id);

    -- Analytics event stream (blueprint §16). Opaque refs only; no answer text,
    -- no drinking data, no unnecessary personal identifiers.
    CREATE TABLE IF NOT EXISTS analytics_events (
      id            TEXT PRIMARY KEY,
      ts            INTEGER NOT NULL,
      event         TEXT NOT NULL,
      room_ref      TEXT,
      member_ref    TEXT,
      game_type     TEXT,
      rules_version TEXT,
      roster_size   INTEGER,
      platform      TEXT,
      duration_ms   INTEGER,
      reason        TEXT,
      meta_json     TEXT
    );
    CREATE INDEX IF NOT EXISTS analytics_event ON analytics_events(event);
    CREATE INDEX IF NOT EXISTS analytics_room ON analytics_events(room_ref);

    -- Entitlements (blueprint §9, §14). One row per verified purchase; state and
    -- validity interval drive access. Keyed by the buyer's identity (guest now,
    -- account later).
    CREATE TABLE IF NOT EXISTS entitlements (
      id           TEXT PRIMARY KEY,
      guest_id     TEXT NOT NULL,
      product      TEXT NOT NULL,
      platform     TEXT NOT NULL,
      source_event TEXT NOT NULL,
      state        TEXT NOT NULL,
      valid_from   INTEGER NOT NULL,
      valid_until  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entitlements_guest ON entitlements(guest_id);

    -- Verified billing events, for idempotent entitlement changes (§14).
    CREATE TABLE IF NOT EXISTS billing_events (
      event_id   TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      guest_id   TEXT,
      created_at INTEGER NOT NULL
    );

    -- Support requests (§15 support flow).
    CREATE TABLE IF NOT EXISTS support_requests (
      id         TEXT PRIMARY KEY,
      email      TEXT,
      message    TEXT NOT NULL,
      room_ref   TEXT,
      status     TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL
    );
  `);
}

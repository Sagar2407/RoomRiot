# ADR 0001 — Indian Classics: foundation & adopted rule defaults

Status: accepted (defaults adopted from the execution plan §19; Sagar may override any
before the affected reducer is finalized). Date: 2026-09-13.

## Context

We're adding four Indian classic games — Snakes & Ladders, Judgement, Teen Patti, Ludo —
to Room Riot, in the plan's build order: **shared foundation → Snakes & Ladders →
Judgement → Teen Patti → Ludo → integrated beta**. Snakes is the sequential-engine
proving ground.

## Decisions

### Catalog & rollout
- New games are **known but disabled**: they appear in `GAME_TYPES`/registry once their
  module exists, but are gated by an **enabled-games** allowlist and hidden from the host
  catalog until they pass their gates. Adding a game ID never inserts it into the default
  playlist or free rotation.
- **Continuous deployment**: each tested slice merges to `main` (Render deploys it), but
  new games stay flagged off in production until ready. `ROOM_RIOT_ENABLE_CLASSICS` (and
  per-game flags) flip them on in a preview for playtesting.
- Chips/points have **no cash value**: no purchase, redemption, transfer, or wager-funded
  access. Session chips reset each hand. XP is never a betting balance.

### Foundation (built as Snakes needs it; heavier pieces deferred to the card games)
- **Server-authoritative crypto randomness** for dice/decks (`crypto.randomInt`,
  crypto Fisher–Yates). Outcomes are baked into the persisted state snapshot at the moment
  they resolve, so a restart loads the applied outcome and never rerolls. Seeds, unused
  deck order, and opponent hands are never sent to the browser.
- **Sequential turns** via the existing phase/advance machinery: each seat's turn is a
  phase; the active seat acts (or the deadline fires and the server resolves the documented
  fallback), then `__advance` moves to the next seat and reschedules the deadline.
- **Idempotency**: retries reuse the `actionId`; the server short-circuits to the recorded
  outcome before re-reducing, so a duplicate roll never produces a second outcome.
- Deferred to Judgement/Teen Patti (when first needed, per the plan): a full canonical
  receipt/`game_events` store, protocol-v2 command envelope, pause budgets, and durable
  Postgres persistence. Ephemeral SQLite remains fine for short Snakes tables.

### Adopted rule defaults (§19)
- **Teen Patti**: Capped Party, six hands, three circuits; ace ordering **A23_HIGH**
  (AKQ_HIGH offered later as a named house option); tied hands split the pot; no side
  show/jokers/all-in in v1.
- **Judgement**: exact-trick (Kachuful/Oh Hell) family; deals `1,2,3,3,2,1`; trump
  rotation **S→D→C→H**; dealer hook on; score `10+bid` exact, `0` missed.
- **Ludo**: enter from yard on a 6; no blockades; six-only bonus; three consecutive sixes
  voids the third; Quick (2 tokens, 24-circuit cap, progress ranking) + Classic (4 tokens).
- **Snakes & Ladders**: Quick (Room Riot 50-square board, reach-or-exceed 50, 20-circuit
  cap) + Classic (100-square, exact finish, overshoot leaves token in place); one fair d6;
  no extra turn on 6 in these presets.
- **Mixed-night scoring**: placement-based **`np-classics-v2`** applied to *every* counted
  game in such a night; existing rooms keep `np-2026-09-1` unchanged.

## Consequences
- The six existing simultaneous games are preserved via an adapter; their reducers are not
  rewritten.
- Boards are original Room Riot fixtures with explicit version hashes; no commercial
  artwork is copied.

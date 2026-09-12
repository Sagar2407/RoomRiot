# Room Riot 🎉

> Turn a gathering into a great story. Private rooms, unexpected games, friendly rivalries — a web‑first party game for adults (4–10 players), drinks optional.

This repository implements the product described in the **Room Riot Product & Development Blueprint**. It is a working, self‑contained **six‑game MVP vertical slice**: one host starts a room, friends join on their phones with a code, and the app runs an authoritative sequence of short games with private answers, shared reveals, fair scoring, a tournament, and a recap.

Everything here runs with `npm install` — no external accounts required. Identity and persistence sit behind clean seams so **Supabase Auth + Postgres** (the blueprint's production target) drop in later without a redesign.

---

## What's in the box

| Area | Status |
| --- | --- |
| **6 launch games** — Majority Report, Bluff Bureau, Caption Court, Link Up, Alibi Club, Close Call | ✅ implemented to the §5 specs |
| **Authoritative game server** — Fastify + Socket.IO, server‑owned timers, phases, settlement | ✅ |
| **Fair scoring** — Night Points (75% performance + 25% placement), ties, per‑game breakdown | ✅ versioned (`np-2026-09-1`) |
| **Room system** — guest identity, join codes, lobby, roster lock, host controls, reconnect/resync | ✅ |
| **Reliability** — idempotent actions, idempotent settlement, restart recovery, at‑most‑once‑safe transport | ✅ |
| **Web client** — home/host/join, phone controller per game, shared TV board, tournament & recap | ✅ Next.js |
| **Fictional players** — practice round + full unattended self‑test | ✅ |
| **Reviewed content bank** — starter prompts for all six games (server‑only answers) | ✅ 37 items |
| Payments, runtime AI, PWA/service worker, native iOS | ⛔ deferred (see roadmap) |

---

## Quick start

```bash
npm install

# Terminal 1 — the authoritative game server (http://localhost:4000)
npm run dev:server

# Terminal 2 — the web client (http://localhost:3000)
npm run dev:web
```

Then open <http://localhost:3000>:

- **Host a night** → you get a room code → **Add a fictional player** a few times → **Start the night** to play solo against bots, or share the code with friends on the same network.
- **Try a 1‑minute practice round** spins up a room pre‑filled with fictional players.
- **Create TV / laptop board** (host, in lobby) gives a read‑only display link for a shared screen.

> Both apps can also run together with `npm run dev` (needs the `concurrently` dev dep).
> Set `NEXT_PUBLIC_SERVER_URL` (web) and `WEB_ORIGIN` (server) when they're not on localhost. See the `.env.example` files.

### Tests

```bash
npm test
```

Covers the scoring formula (including the blueprint's worked example and tie handling), every game driven to completion within score bounds, Close Call boundary bands, Link Up pairing (no self‑pairs, odd‑roster trio), Alibi Club secrecy, action idempotency, projection authorization, and a **full six‑game night that settles exactly once and survives a simulated restart**.

---

## The plan of execution, phase by phase

The blueprint's roadmap (§15) sequences the work in eight phases. Here is the plan, with what this repository already delivers.

### Phase 0 — Prove the fun *(blueprint week 1)*
Paper/slide prototypes of Majority Report, Bluff Bureau, Alibi Club; a clickable joining flow; a scoring draft.
**Exit gate:** ≥3 independent groups of 4–8 adults understand the rules and voluntarily ask for another game.
→ *Design activity, not code. The scoring model and game rules here make good playtest scripts.*

### Phase 1 — One complete room *(weeks 2–3)* — **DONE, and extended**
Guest auth, host controls, join code, **Majority Report**, settlement, reconnect.
**Exit gate:** four physical devices complete a game; duplicate actions and restart recovery preserve scores.
→ *Delivered as the §18 "production‑shaped Majority Report vertical slice" — then extended to all six games (Phase 2) at the user's request.*

### Phase 2 — Variety *(weeks 4–6)* — **DONE**
The remaining five games on a **shared game‑module contract** (`manifest / selectContent / initialState / validateAction / reduce / projectPublic / projectPrivate / score`), private projections, and reviewed content import.
**Exit gate:** every game completes across supported rosters; hidden information never reaches other clients.
→ *All six modules implemented; Alibi Club's hidden role/location is asserted absent from public projections in tests.*

### Phase 3 — A complete night *(weeks 7–8)* — **DONE for the slice**
Playlist, Night Points, profiles/XP claim, recap, display mode, reporting, accessibility pass.
**Exit gate:** a 35‑minute night runs without developer intervention on mixed devices.
→ *Playlist, Night Points tournament, per‑game breakdown, awards, Midnight‑Edition recap, and the read‑only TV board are in. **Still to add:** persistent XP + account claim, in‑room report/block controls, and a full accessibility audit (reduced‑motion and slower‑timer settings are wired via `timerScale`).*

### Phase 4 — Private beta *(weeks 9–10)* — next
≥30 observed/instrumented rooms, content revisions, recovery and burst‑load work.
**To build:** the event taxonomy (§16: `room_created`, `join_*`, `game_*`, `reconnect_*`, `session_completed`, …), a dashboard, and a 50‑room × 8‑player load gate.

### Phase 5 — Paid soft launch *(weeks 11–12)* — next
Party Pass, verified Stripe webhooks, support flow, production monitoring, content cadence.
**To build:** `entitlements` + `/billing/webhook`, the free‑tier gate (3 rotating games), and a genuine CMS before the 10th game (§11).

### Phase 6 — Expansion — later
Crew Lore, Secret Sidequests, selected "Next" games, stronger content tooling.

### Phase 7 — Native iOS — later
Expo client over the **same** contracts, scoring service, and entitlements; `packages/game-core` and `packages/contracts` are already framework‑free for exactly this reuse.

---

## Architecture

A TypeScript web frontend, one authoritative game service, and a database — with the rules kept independent of the browser so a native client can reuse them (blueprint §8).

```
apps/
  web/          Next.js (App Router) — home, lobby, phone controller, TV board, recap
  game-server/  Fastify + Socket.IO + SQLite — the only writer of core game state
packages/
  contracts/    transport types + Zod schemas (actions, events, projections)  [framework-free]
  game-core/    game-module contract, six games, seeded RNG, scoring, tournament  [framework-free]
  content/      reviewed prompt bank (server-only answers)
tests/          vitest — scoring, games, and full-night server integration
```

**Authoritative flow.** A client sends an authenticated action → the server validates role, membership, phase, payload and deadline → applies the deterministic reducer → persists the snapshot and any score‑ledger entries in a transaction → *then* acknowledges and publishes authorized projections. The browser never sends an authoritative score.

**Projections.** The public projection carries only already‑revealed information (safe for the TV board). A per‑member projection adds only *that* member's private instruction (their hidden role, their partner, their own option). Hidden roles and answers never leave the server for the wrong viewer.

**Determinism & recovery.** Every game instance stores a seed; each reduce/init builds a fresh RNG seeded by `${seed}:${site}`, so shuffles and role assignment are reproducible regardless of draw order. A restart rehydrates the JSON snapshot and reschedules from the persisted `deadline_at`; an expired phase settles **at most once** under the same guard as live play. Settlement writes to an immutable `score_ledger` keyed by a unique settlement key (`INSERT OR IGNORE`), so retries and restarts never double‑count. Retried `actionId`s return the recorded result and are never re‑applied.

**Reconnect.** Socket.IO is at‑most‑once; on reconnect the client asks for a fresh snapshot (`room.resync`) rather than trusting event replay (§10).

## Scoring (blueprint §6)

Each game reports a raw score `R` out of a published maximum `M` (reduced consistently by any voided round). Night Points:

```
performance = 100 × R / M
placement   = 100 × (b + (t − 1)/2) / (n − 1)      # b: players below you, t: players tied with you (incl. self)
NightPoints = round(0.75 × performance + 0.25 × placement)
```

Worked example (raw 240/180/180/60 out of 300) → **85 / 58 / 58 / 15**, verified in `tests/scoring.test.ts`. Official standings include only players with a valid result in every counted game; others still see earned points, labelled *partial*. There are no purchasable multipliers, no global leaderboard, and consumption never earns points.

## The six games at a glance

| Game | Family | Raw scoring |
| --- | --- | --- |
| **Majority Report** | Predictions | 100 for forecasting a modal option; 5 rounds → max 500 |
| **Bluff Bureau** | Bluffing | 60 for the truth + 10 per fooled voter (cap 40); 3 rounds → max 300 |
| **Caption Court** | Creative | 100 × votes ÷ eligible non‑author voters; 3 rounds → max 300 |
| **Link Up** | Teamwork | 100 for a matching pair (trio: 100 × matching pairs ÷ 3); max 300 |
| **Alibi Club** | Deduction | insiders 100 for convicting the outsider; outsider 50 (uncaught) + 50 (right location); max 100 |
| **Close Call** | Predictions | 100 exact / 70 (≤10%) / 40 (≤25%); 5 rounds → max 500 |

## Data model (SQLite → Postgres)

`rooms`, `members` (one active seat per identity), `game_instances` (JSON snapshot + `deadline_at`), `actions` (idempotency), `score_ledger` (immutable, unique settlement key), `awards`. The schema is kept close to the §9 Postgres target so migrating to Supabase is a translation, not a redesign.

## Known simplifications in this slice

Honest notes for the next contributor — none change the game math, all are called out where the blueprint anticipates them:

- **Identity/persistence:** signed HMAC guest tokens + SQLite instead of Supabase Auth + Postgres (swappable at `tokens.ts` / `db.ts`).
- **Content:** a 37‑item starter bank, not the ~240 reviewed items (§11), and no editorial CMS yet.
- **Bluff Bureau** duplicate/answer‑matching decoys are dropped (author earns no decoy points) rather than re‑requested with a staff fallback.
- **Link Up** a disconnected partner scores the round as no‑match rather than the per‑member void variant.
- **Alibi Club** enforces its ≥5 recommendation softly (it still runs with 4 for testing).
- Option ordering is a single deterministic server shuffle (stable IDs decide scoring), not per‑viewer.
- No PWA/service worker, payments, runtime AI, uploads, or account deletion yet — all deferred by design (§7, §12–14).

---

*Working name; brand and domain not checked. All estimates and targets in the blueprint are planning proposals, not validated market findings.*

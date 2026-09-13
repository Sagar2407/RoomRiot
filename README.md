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
| **Persistent XP** — 20/game + 5/achievement, shown on the scoreboard | ✅ (Phase 3) |
| **Reporting & moderation** — in‑room report control, scoped private reports | ✅ (Phase 3/4) |
| **Analytics funnel** — §16 event taxonomy + `/metrics` endpoint + ops page | ✅ (Phase 4) |
| **Burst‑load harness** — 50 rooms × 8 players, ack‑latency + reconnect gate | ✅ (Phase 4) |
| **Party Pass + free tier** — 3 rotating free games, 24h pass, tier gate | ✅ (Phase 5) |
| **Billing webhook** — HMAC‑verified, idempotent, refund/expiry (Stripe‑swappable) | ✅ (Phase 5) |
| **Support flow** — `/support` capture + page | ✅ (Phase 5) |
| Real Stripe account, runtime AI, PWA/service worker, native iOS | ⛔ deferred (see roadmap) |

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

Covers the scoring formula (including the blueprint's worked example and tie handling), every game driven to completion within score bounds, Close Call boundary bands, Link Up pairing (no self‑pairs, odd‑roster trio), Alibi Club secrecy, action idempotency, projection authorization, reporting + analytics privacy, XP awards, and a **full six‑game night that settles exactly once and survives a simulated restart**.

### Beta instrumentation & load (Phase 4)

```bash
# Funnel (aggregate only — no per-user data)
curl http://localhost:4000/metrics
# …or open the ops page
open http://localhost:3000/metrics

# Burst-load gate: start the server, then
ROOMS=50 PLAYERS=8 SERVER=http://localhost:4000 npm run loadtest --workspace @roomriot/game-server
```

The server emits the §16 event taxonomy at each lifecycle point, storing only opaque refs, versions, roster sizes, durations and reason codes — never answers, drinking data, or nicknames. Players can report the current prompt at any time; reports are scoped, stored pseudonymously with a 30‑day retention window, and never surfaced to the room.

### Monetization (Phase 5)

Guests always join free. A free night is three rotating games; the **Party Pass** ($4.99 / 24h) unlocks all six. The tier is resolved once at room creation — never mid‑game.

```bash
# What the host sees (also records the offer impression)
curl http://localhost:4000/entitlements

# Simulate a completed purchase without Stripe (dev only)
curl -X POST http://localhost:4000/billing/dev-checkout \
  -H 'content-type: application/json' -d '{"guestToken":"<token>"}'
```

`POST /billing/webhook` verifies an HMAC signature (`x-roomriot-signature: t=…,v1=…` over `${t}.${body}`) and applies entitlement changes idempotently by event id, including refund→expiry. To go live, replace `verifySignature` in `apps/game-server/src/billing.ts` with `stripe.webhooks.constructEvent` and map Stripe's event types — the entitlement logic is unchanged.

---

## Deploy it (go live)

Room Riot also ships as **one container** that serves the web app and the game
server together on a single URL — the fastest way to get real people playing.
The default launch config is **payments off** with a **free 3‑game night**
(Majority Report → Caption Court → Close Call).

```bash
# Build the single-service image and run it anywhere
docker build -t room-riot .
docker run -p 8080:8080 -e ROOM_RIOT_SECRET=$(openssl rand -hex 32) room-riot
# → http://localhost:8080
```

One‑click‑ish hosts: this repo includes a **`render.yaml`** Blueprint (Render),
and the same image runs on Railway, Fly.io, or any VPS. Full instructions —
including how to turn payments back on for new games later — are in
**[DEPLOY.md](./DEPLOY.md)**.

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

### Phase 3 — A complete night *(weeks 7–8)* — **DONE**
Playlist, Night Points, profiles/XP claim, recap, display mode, reporting, accessibility pass.
**Exit gate:** a 35‑minute night runs without developer intervention on mixed devices.
→ *Playlist, Night Points tournament, per‑game breakdown, awards, Midnight‑Edition recap, read‑only TV board, **persistent XP** (20/game + 5/achievement, shown on the scoreboard), and an **in‑room report control** are all in. Reduced‑motion and slower‑timer accessibility are wired via `timerScale`. **Still to add:** guest→account claim + a full screen‑reader audit.*

### Phase 4 — Private beta *(weeks 9–10)* — **IN PROGRESS (instrumentation + load done)**
≥30 observed/instrumented rooms, content revisions, recovery and burst‑load work.
→ *Delivered: the full §16 **event taxonomy** (`room_created`, `join_started`/`join_succeeded`, `game_started`, `phase_completed`, `game_completed`, `session_completed`, `reconnect_succeeded`, `content_reported`), a `GET /metrics` **funnel** with the §16 targets, an ops page at `/metrics`, and the **burst‑load harness** below. **Still to add:** run ≥30 real rooms, content revisions from skip/report data, and a scheduler‑backed outage pause.*

**Measured on the §10 load gate** (50 rooms × 8 players = 400 connections, synchronized answer burst, in‑memory DB, single dev instance): **400/400 acks accepted, p95 ack ≈ 268 ms** (target < 500 ms), **40/40 reconnects resynced**, zero lost acknowledged actions. Reproduce with `npm run loadtest` (see below). Numbers are a local dev measurement, not a capacity guarantee.

### Phase 5 — Paid soft launch *(weeks 11–12)* — **IN PROGRESS (entitlements + webhook + support done)**
Party Pass, verified webhooks, support flow, production monitoring, content cadence.
→ *Delivered: a free tier (three **rotating** games, a complete short night) and a **Party Pass** (all six games, 24h from activation); a **provider‑agnostic billing webhook** — HMAC‑signature verified, idempotent by event id, with refund→expiry — plus a dev‑checkout that runs the whole flow without a Stripe account; entitlement lookup; a **support** endpoint + page; and purchase metrics (`offers_viewed`, `purchases_verified`, `purchase_conversion`) in `/metrics`. The tier is resolved once at room creation, so **no payment screen ever interrupts a started night** (§14). **Still to add:** a real Stripe account + `stripe.webhooks.constructEvent` (a one‑function swap at `verifySignature`), theme packs / Host Club, and cohort repeat‑purchase analysis.*

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

`rooms`, `members` (one active seat per identity), `game_instances` (JSON snapshot + `deadline_at`), `actions` (idempotency), `score_ledger` (immutable, unique settlement key), `awards`, `xp_ledger` (idempotent by award key), `reports` (scoped, retention‑dated), `analytics_events` (opaque refs), `entitlements` + `billing_events` (idempotent purchases), and `support_requests`. The schema is kept close to the §9 Postgres target so migrating to Supabase is a translation, not a redesign.

## Known simplifications in this slice

Honest notes for the next contributor — none change the game math, all are called out where the blueprint anticipates them:

- **Identity/persistence:** signed HMAC guest tokens + SQLite instead of Supabase Auth + Postgres (swappable at `tokens.ts` / `db.ts`).
- **Content:** a 37‑item starter bank, not the ~240 reviewed items (§11), and no editorial CMS yet.
- **Bluff Bureau** duplicate/answer‑matching decoys are dropped (author earns no decoy points) rather than re‑requested with a staff fallback.
- **Link Up** a disconnected partner scores the round as no‑match rather than the per‑member void variant.
- **Alibi Club** enforces its ≥5 recommendation softly (it still runs with 4 for testing).
- Option ordering is a single deterministic server shuffle (stable IDs decide scoring), not per‑viewer.
- **Reporting** captures scoped reports + emits the event; a moderator queue UI, block, and per‑item kill‑switch are the next moderation step.
- **Analytics** is first‑party SQLite with a simple funnel; no external analytics vendor.
- **Billing** is provider‑agnostic with an HMAC‑signed webhook + dev‑checkout; wiring a real Stripe account is a one‑function swap at `verifySignature` (no live payments taken here).
- No PWA/service worker, runtime AI, uploads, guest→account claim, or account deletion yet — all deferred by design (§7, §12–14).

---

*Working name; brand and domain not checked. All estimates and targets in the blueprint are planning proposals, not validated market findings.*

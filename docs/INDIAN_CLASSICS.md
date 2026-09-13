# Indian Classics — beta guide

Four classic games added on a shared sequential-game engine, all **shipped dark**
(hidden until you enable them). See `docs/adr/0001-indian-classics.md` for the
adopted rule defaults.

| Game | Seats | Preset shipped | Notes |
| --- | --- | --- | --- |
| **Snakes & Ladders** | 2–10 | Quick (50) | Placement scoring; first home wins. |
| **Judgement** | 3–6 | Quick (6 deals) | Exact-trick bidding, dealer hook, private hands. |
| **Teen Patti** | 3–6 | Capped Party (6 hands) | Free non-redeemable chips; blind/seen; show/split. |
| **Ludo** | 2–4 | Quick (2 tokens) | Captures, safe cells, exact home, progress ranking. |

Each is a **standalone table** offered under a **Beta** card on the host page, with
a **Rematch** ("play again with this crew") at the end that starts a fresh night in
the same room (new deals, per-night scoreboard; XP carries over).

## Enabling for a playtest

Set in the environment (Render → the service → Environment):

- `ROOM_RIOT_ENABLE_CLASSICS=true` — turns on all four (they show as Beta).
- or `ROOM_RIOT_ENABLED_GAMES=snakes_and_ladders,judgement` — an explicit allowlist.

Leaving it unset keeps the classics completely hidden; the existing party app is
unchanged. A classic never enters the free rotation or the default night — you have
to pick it explicitly.

## Design guarantees (already enforced + tested)

- **Server-authoritative randomness** — dice (`crypto.randomInt`) and card shuffles
  are resolved on the server and baked into the persisted snapshot; a restart never
  rerolls, and a retried action reuses its id so a lost ack can't double-apply.
- **Privacy** — card hands live only in their owner's projection; a blind Teen Patti
  seat doesn't even receive its own cards until it sees; folded/uncontested hands are
  never revealed; Ludo/Snakes are fully public.
- **Fairness** — chip conservation in Teen Patti (net sums to zero); exact home in
  Ludo; placement scoring (`np-classics-v2`) for games with positional/negative
  native scores. Chips are free and non-redeemable (no purchase, cash-out, transfer).
- **Recovery** — a timed-out seat gets the documented fallback (Teen Patti packs,
  Judgement plays the lowest legal bid/card, Ludo/Snakes auto-roll and auto-move);
  the game never wagers on a player's behalf.

Every game has bot players and an end-to-end automated test that plays a full match.

## Release gates before enabling in production (plan §13)

These are the launch gate, and the ones that matter most are **not code**:

- [ ] **Observed playtests** — 6–8 real sessions across ≥ 3 groups (mixed 3/4/6-seat
      card tables; 2- and 4-player Ludo; a large Snakes room). *This is the real gate
      and can't be automated.*
- [ ] Measured durations match the displayed estimates (adjust presets if not).
- [ ] Browser journeys on real devices (iPhone Safari, Android Chrome, a shared
      display), reduced-motion / keyboard paths.
- [ ] Persistence decision — SQLite is **ephemeral** on the free plan; for XP/history
      that survives redeploys, mount a disk or move to Postgres.
- [ ] Terms / privacy / age policy reviewed for the launch territories (a browser
      21+ checkbox is a stated boundary, not verification or a compliance system).

## Deliberately deferred (per the plan)

- Full-length presets (Classic Ludo 4-token, longer Judgement schedules) — the
  engines support them; only the Quick presets are exposed.
- Mixed party+classics nights under a single all-placement conversion (each game
  currently scores with its own conversion), and repeat-game playlists beyond the
  per-night scoping already in place.
- A hosted shareable recap page (the recap can be **copied as text** today), guest→
  account claiming, co-pilot Ludo, and the creative expansions in plan §17.

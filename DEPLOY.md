# Deploying Room Riot

Room Riot ships as **one container** that serves both the web app and the
authoritative game server (Fastify + Socket.IO + SQLite) on a single URL. Deploy
it once and share the URL — friends open it, tap **Host a night** or **Join a
room**, and play. No separate frontend/backend, no CORS to configure.

The default launch config is **payments OFF** and a **free 5‑game night**
(Majority Report → Link Up → Bluff Bureau → Caption Court → Close Call).
Everything is set in `Dockerfile` / `render.yaml`; override with env vars (table
at the bottom). It also ships with an **adults‑only (21+) confirmation** and
**per‑IP rate limiting** on room create/join/support.

> Validated: the single‑service runtime (static web served by the game server on
> one origin, billing off, launch trio, a live WebSocket game with fictional
> players) was smoke‑tested locally. The image build runs on your host.

---

## Option A — Render (recommended, one Blueprint)

This repo includes `render.yaml`, so Render can provision everything.

1. Make sure this branch is pushed to GitHub (it is: `claude/confident-cray-7lvvpa`).
   Either merge it to your default branch, or point Render at this branch.
2. In the **Render dashboard → New + → Blueprint**.
3. Connect this GitHub repo and select the branch. Render reads `render.yaml`,
   builds the `Dockerfile`, and creates a **web service**.
4. Click **Apply**. When the build finishes, open the service's
   `https://<name>.onrender.com` URL. That's your live game.

Render notes:
- **WebSockets** work on Render web services — no extra config.
- `render.yaml` sets `ROOM_RIOT_BILLING_ENABLED=false`, the launch playlist, and
  auto‑generates `ROOM_RIOT_SECRET`. Health check is `/health`.
- **Free plan** spins the service down after ~15 min idle, so the first visitor
  after a quiet spell waits for a cold start (up to ~1 min). A paid instance
  stays warm.
- SQLite is on **ephemeral** storage on the free plan; rooms are short‑lived so
  that's fine. To keep XP/analytics across redeploys, uncomment the `disk:` block
  in `render.yaml` (needs a paid plan) and set `ROOM_RIOT_DB` to the mount path.

_Manual alternative (no Blueprint):_ **New + → Web Service → Docker**, pick the
repo, set the env vars from the table below, and deploy.

---

## Option B — Railway

1. **New Project → Deploy from GitHub repo** → pick this repo/branch. Railway
   detects the `Dockerfile`.
2. Add the env vars from the table below (at minimum `ROOM_RIOT_SECRET`).
3. **Settings → Networking → Generate Domain** to get a public URL.

## Option C — Fly.io

```bash
fly launch --dockerfile Dockerfile   # accept the detected settings, pick a region
fly secrets set ROOM_RIOT_SECRET=$(openssl rand -hex 32)
fly deploy
```

## Option D — Any VPS / your own machine (Docker)

```bash
docker build -t room-riot .
docker run -p 8080:8080 \
  -e ROOM_RIOT_SECRET=$(openssl rand -hex 32) \
  room-riot
# open http://localhost:8080  (or your server's IP/domain behind HTTPS)
```

Put it behind a reverse proxy (Caddy/Nginx) for TLS + WebSocket upgrade, or use
the platform's built‑in HTTPS.

---

## Configuration

| Env var | Default | What it does |
| --- | --- | --- |
| `ROOM_RIOT_SECRET` | random per boot | HMAC secret for guest/member tokens. **Set a stable value in prod** so tokens survive restarts. |
| `ROOM_RIOT_BILLING_ENABLED` | `false` (in Docker) | `false` = whole app is free, no paywall. `true` = Party Pass gate. |
| `ROOM_RIOT_PLAYLIST` | `majority_report,link_up,bluff_bureau,caption_court,close_call` | The games a night runs. Comma‑separated from: `majority_report, bluff_bureau, caption_court, link_up, alibi_club, close_call` (Alibi Club needs 5+ players). |
| `PORT` | `8080` | Port to listen on. Render/Railway/Fly set this for you. |
| `SERVE_WEB_DIR` | `/app/apps/web/out` | Where the built web app lives (single‑service). |
| `ROOM_RIOT_DB` | `/app/data/room-riot.sqlite` | SQLite path. Use a mounted volume to persist. |
| `ROOM_TTL_MS` | `7200000` | Abandoned‑room expiry (2h). |

## Adding paid games later

When you're ready to charge for more games (blueprint §14):

1. Add the extra games to `ROOM_RIOT_PLAYLIST` (they become the Party Pass set).
2. Set `ROOM_RIOT_BILLING_ENABLED=true` and a strong `BILLING_WEBHOOK_SECRET`.
3. Wire real Stripe: replace `verifySignature` in
   `apps/game-server/src/billing.ts` with `stripe.webhooks.constructEvent` and
   map Stripe's event types to `payment.succeeded` / `charge.refunded`. The
   entitlement logic and the free/paid split are unchanged.

The free tier then shows a rotating trio and a "$4.99 / 24h Party Pass" offer,
already built and tested — no new UI needed.

## Operating it

- `GET /health` — liveness (used by Render's health check).
- `GET /metrics` — the §16 funnel (join → activation → completion, plus purchase
  metrics). Also viewable at `/metrics` in the app.
- Reports land in the `reports` table; support messages in `support_requests`.

## Launch hardening (already on)

- **Adults‑only gate** — a one‑time 21+ confirmation before hosting/joining
  (stated boundary, not verification — blueprint §12), remembered per browser.
- **Rate limiting** (per client IP, via `trustProxy`): room create ≤ 20 / 5 min,
  join ≤ 60 / min (generous so a whole party on one Wi‑Fi is never throttled,
  while slowing room‑code guessing), guest ≤ 60 / 5 min, support ≤ 5 / 5 min.
  Static assets and gameplay sockets are never rate limited.

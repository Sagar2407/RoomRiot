# Room Riot — single-container deploy.
# One image serves BOTH the web app (static export) and the authoritative game
# server (Fastify + Socket.IO + SQLite) on one origin. Deploy to Render, Railway,
# Fly.io, or any host that runs a container and forwards $PORT.

FROM node:22-bookworm-slim

# Build tools for the native better-sqlite3 module.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Install dependencies first (cache-friendly): copy the lockfile + every manifest.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/game-server/package.json apps/game-server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/game-core/package.json packages/game-core/package.json
COPY packages/content/package.json packages/content/package.json
RUN npm ci

# App source.
COPY . .

# Build the web app as a static export that talks to the same origin.
ENV BUILD_STATIC=1
ENV NEXT_PUBLIC_SERVER_URL=""
RUN npm run build --workspace @roomriot/web

# Runtime defaults (override any of these in your host's env settings).
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV ROOM_RIOT_BILLING_ENABLED=false
ENV ROOM_RIOT_PLAYLIST=majority_report,caption_court,close_call
ENV SERVE_WEB_DIR=/app/apps/web/out
ENV ROOM_RIOT_DB=/app/data/room-riot.sqlite

EXPOSE 8080
CMD ["npx", "tsx", "apps/game-server/src/index.ts"]

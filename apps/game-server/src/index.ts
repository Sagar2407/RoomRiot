/**
 * Room Riot game server entrypoint — Fastify (HTTP) + Socket.IO (live), backed by
 * SQLite. See src/roomManager.ts for the authoritative game logic.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Server as IOServer } from 'socket.io';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { openDb, type DB } from './db.js';
import { RoomManager } from './roomManager.js';
import { registerRoutes } from './routes.js';
import { registerSocket } from './socket.js';
import { Analytics } from './analytics.js';

export interface BuiltServer {
  app: FastifyInstance;
  io: IOServer;
  db: DB;
  rm: RoomManager;
  analytics: Analytics;
}

export async function buildServer(dbPath?: string): Promise<BuiltServer> {
  const db = openDb(dbPath);
  // trustProxy so req.ip is the real client IP behind Render's proxy (needed for
  // per-IP rate limiting, not the shared proxy address).
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

  await app.register(cors, {
    origin: config.webOrigin === '*' ? true : [config.webOrigin],
    credentials: true,
  });

  // Rate limiting is opt-in per route (global:false), so it protects the mutating
  // API endpoints without ever throttling static assets or a whole party joining
  // from one Wi-Fi (blueprint §9).
  await app.register(rateLimit, { global: false });

  // Keep the raw JSON body available for billing webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = typeof body === 'string' ? body : String(body);
    try {
      done(null, body && (body as string).length ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const io = new IOServer(app.server, {
    cors: { origin: config.webOrigin === '*' ? true : [config.webOrigin], credentials: true },
  });

  const analytics = new Analytics(db, config.secret);
  const rm = new RoomManager(db, io, analytics);
  registerRoutes(app, rm, analytics, db);
  registerSocket(io, rm);

  // Single-service mode: also serve the built web app from one origin, so the
  // whole game deploys as one container behind one URL.
  const webDir = config.serveWebDir ? resolve(config.serveWebDir) : '';
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false });
    // Serve the exported HTML for client routes that aren't a file on disk.
    app.setNotFoundHandler((req, reply) => {
      const urlPath = (req.raw.url ?? '/').split('?')[0] ?? '/';
      if (req.method !== 'GET' || urlPath.includes('..')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const candidates = [join(webDir, urlPath, 'index.html'), join(webDir, `${urlPath}.html`), join(webDir, 'index.html')];
      for (const file of candidates) {
        if (existsSync(file)) return reply.type('text/html').send(readFileSync(file));
      }
      return reply.code(404).send({ error: 'not_found' });
    });
    app.log.info(`Serving web app from ${webDir}`);
  }

  return { app, io, db, rm, analytics };
}

// Only auto-listen when run directly (tests import buildServer instead).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  buildServer()
    .then(async ({ app }) => {
      await app.listen({ port: config.port, host: config.host });
      app.log.info(`Room Riot game server on http://${config.host}:${config.port}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

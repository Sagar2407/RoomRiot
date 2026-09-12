/**
 * Room Riot game server entrypoint — Fastify (HTTP) + Socket.IO (live), backed by
 * SQLite. See src/roomManager.ts for the authoritative game logic.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Server as IOServer } from 'socket.io';
import { config } from './config.js';
import { openDb, type DB } from './db.js';
import { RoomManager } from './roomManager.js';
import { registerRoutes } from './routes.js';
import { registerSocket } from './socket.js';

export interface BuiltServer {
  app: FastifyInstance;
  io: IOServer;
  db: DB;
  rm: RoomManager;
}

export async function buildServer(dbPath?: string): Promise<BuiltServer> {
  const db = openDb(dbPath);
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cors, {
    origin: config.webOrigin === '*' ? true : [config.webOrigin],
    credentials: true,
  });

  const io = new IOServer(app.server, {
    cors: { origin: config.webOrigin === '*' ? true : [config.webOrigin], credentials: true },
  });

  const rm = new RoomManager(db, io);
  registerRoutes(app, rm);
  registerSocket(io, rm);

  return { app, io, db, rm };
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

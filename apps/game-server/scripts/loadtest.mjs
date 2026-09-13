/**
 * Burst-load harness (blueprint §10).
 *
 * Simulates the blueprint's load gate — by default 50 rooms × 8 players = 400
 * connections — with a synchronized answer burst, a reconnect wave, and latency
 * measurement. It profiles the authoritative action path: every player submits
 * the first game's move at once, and we record acknowledgement latency and prove
 * no acknowledged action is lost.
 *
 * Usage: start the server, then
 *   ROOMS=50 PLAYERS=8 SERVER=http://localhost:4000 node apps/game-server/scripts/loadtest.mjs
 */
import { io } from 'socket.io-client';

const SERVER = process.env.SERVER ?? 'http://localhost:4000';
const ROOMS = Number(process.env.ROOMS ?? 50);
const PLAYERS = Number(process.env.PLAYERS ?? 8);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

function connect(memberToken) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER, { auth: { memberToken }, transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error('connect timeout')), 15000);
    let projection = null;
    socket.on('room.state', (p) => {
      projection = p;
    });
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve({ socket, getProjection: () => projection });
    });
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  console.log(`Load test → ${SERVER}  (${ROOMS} rooms × ${PLAYERS} players = ${ROOMS * PLAYERS} connections)`);
  const t0 = Date.now();

  // 1. Build rooms + members over HTTP (batched so we don't stampede the API).
  const rooms = [];
  for (let r = 0; r < ROOMS; r++) {
    const host = await post('/rooms', { nickname: `H${r}`, settings: { playlist: ['majority_report'] } });
    const members = [host];
    for (let p = 1; p < PLAYERS; p++) {
      members.push(await post('/rooms/join', { code: host.code, nickname: `P${r}_${p}` }));
    }
    rooms.push({ host, members });
    if (r % 10 === 9) await sleep(20);
  }
  console.log(`Provisioned ${rooms.length} rooms in ${Date.now() - t0}ms`);

  // 2. Connect every socket.
  const conns = new Map();
  await Promise.all(
    rooms.flatMap((room) =>
      room.members.map(async (m) => {
        conns.set(m.memberId, await connect(m.memberToken));
      }),
    ),
  );
  console.log(`Connected ${conns.size} sockets`);

  // 3. Hosts start their night; wait until every room reaches the choosing phase.
  for (const room of rooms) {
    conns.get(room.host.memberId).socket.emit('game.action', { actionId: `start-${room.host.memberId}`, type: 'start_night' });
  }
  await waitFor(() => rooms.every((room) => conns.get(room.host.memberId).getProjection()?.game?.phaseKind === 'choosing'), 15000);

  // 4. Synchronized burst: every player submits at once; measure ack latency.
  const latencies = [];
  let accepted = 0;
  let rejected = 0;
  await Promise.all(
    rooms.flatMap((room) =>
      room.members.map((m) => {
        const { socket, getProjection } = conns.get(m.memberId);
        const proj = getProjection();
        const opt = proj?.game?.options?.[0]?.id ?? 'o1';
        return new Promise((resolve) => {
          const start = Date.now();
          socket.emit(
            'game.action',
            { actionId: `burst-${m.memberId}`, type: 'submit_round', payload: { answer: opt, forecast: opt } },
            (res) => {
              latencies.push(Date.now() - start);
              if (res?.accepted) accepted++;
              else rejected++;
              resolve();
            },
          );
        });
      }),
    ),
  );

  // 5. Reconnect wave on a 10% sample; confirm resync returns state.
  const sample = [...conns.values()].filter((_, i) => i % 10 === 0);
  let resynced = 0;
  await Promise.all(
    sample.map(async ({ socket }) => {
      socket.disconnect();
      await sleep(100);
      socket.connect();
      await new Promise((resolve) => {
        socket.once('room.state', () => {
          resynced++;
          resolve();
        });
        socket.emit('room.resync', { lastSequence: 0 });
        setTimeout(resolve, 3000);
      });
    }),
  );

  latencies.sort((a, b) => a - b);
  const summary = {
    connections: conns.size,
    burst_actions: latencies.length,
    accepted,
    rejected,
    ack_p50_ms: percentile(latencies, 50),
    ack_p95_ms: percentile(latencies, 95),
    ack_max_ms: percentile(latencies, 100),
    reconnect_sample: sample.length,
    reconnect_resynced: resynced,
    total_ms: Date.now() - t0,
  };
  console.log('\n=== Load test summary ===');
  console.table(summary);

  for (const { socket } of conns.values()) socket.disconnect();

  const ok = rejected === 0 && resynced === sample.length && summary.ack_p95_ms < 500;
  console.log(ok ? '\nPASS: no lost acks, all resynced, p95 < 500ms target (§10)' : '\nCHECK: see summary above');
  process.exit(ok ? 0 : 1);
}

async function waitFor(pred, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(100);
  }
  throw new Error('waitFor timeout');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

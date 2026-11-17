// Regression tests for the remote relay socket lifecycle.
//
// These pin the two behaviours the old 29-line relay got wrong:
//   1. a client that half-closes after its request still receives the whole stream
//      (the FIN grace deadline must restart on every byte, not fire once);
//   2. abruptly aborted connections are reclaimed — accepted == closed and live == 0 —
//      instead of leaving CLOSED sockets behind until the fd table runs out.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";

const RELAY =
  process.env.RELAY_PATH ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "remote-proxy", "relay.mjs");
const FIN_GRACE_MS = 700;
const CHUNKS = 20;
const CHUNK_GAP_MS = 120; // total stream ≈ 2.4s, far beyond FIN_GRACE_MS
const ABORTS = 60;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let upstream;
let upstreamPort;
let relayPort;
let relay;
const statsLines = [];
const errors = [];

// Upstream streams CHUNKS frames spaced CHUNK_GAP_MS apart, then ends.
function startUpstream(port) {
  return new Promise((resolve) => {
    upstream = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      socket.once("data", async () => {
        for (let i = 0; i < CHUNKS; i++) {
          if (socket.destroyed) return;
          socket.write(`chunk-${i}\n`);
          await wait(CHUNK_GAP_MS);
        }
        socket.end();
      });
    });
    upstream.on("error", () => {});
    upstream.listen(port, "127.0.0.1", resolve);
  });
}

before(async () => {
  upstreamPort = await freePort();
  relayPort = await freePort();
  await startUpstream(upstreamPort);

  relay = spawn(process.execPath, [RELAY], {
    env: {
      ...process.env,
      TARGET_HOST: "127.0.0.1",
      TARGET_PORT: String(upstreamPort),
      LISTEN_HOST: "127.0.0.1",
      LISTEN_PORT: String(relayPort),
      DISABLE_TAILNET: "1",
      FIN_GRACE_MS: String(FIN_GRACE_MS),
      WATCHDOG_INTERVAL_MS: "200",
      STATS_EVERY_TICKS: "1",
      CONNECT_TIMEOUT_MS: "3000",
      FD_MAX: "65536",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stderr.on("data", (b) => errors.push(b.toString()));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay never reported listening")), 10000);
    let buffered = "";
    relay.stdout.on("data", (buf) => {
      buffered += buf.toString();
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line.includes("stats ")) statsLines.push(line);
        if (line.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    relay.once("exit", (code) => reject(new Error(`relay exited early code=${code}`)));
  });
});

after(async () => {
  relay?.kill("SIGKILL");
  await new Promise((resolve) => upstream?.close(resolve));
  if (errors.length) console.error("relay stderr:", errors.join("").slice(0, 500));
});

// Waits for a stats line whose counters satisfy the predicate. The relay prints
// "stats uptime=.. live=.. accepted=.. closed=..", so counters are read by name.
function parseStats(line) {
  const read = (key) => {
    const match = line.match(new RegExp(`\\b${key}=(-?\\d+)`));
    return match ? Number(match[1]) : null;
  };
  const parsed = { live: read("live"), accepted: read("accepted"), closed: read("closed") };
  return Object.values(parsed).every((v) => v !== null) ? parsed : null;
}

async function awaitStats(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of statsLines) {
      const parsed = parseStats(line);
      if (parsed && predicate(parsed)) return parsed;
    }
    await wait(25);
  }
  throw new Error(`${label}: no matching stats line within ${timeoutMs}ms (last: ${statsLines.at(-1) ?? "none"})`);
}

function openClient() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: relayPort });
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

test("client half-close keeps the stream alive past the FIN grace window", async () => {
  const socket = await openClient();
  const received = [];
  let finished;
  const completed = new Promise((resolve) => {
    finished = resolve;
  });

  // Subscribe before triggering, so no frame can be missed.
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    for (const line of chunk.split("\n")) if (line.startsWith("chunk-")) received.push(line);
  });
  socket.on("end", () => finished("end"));
  socket.on("close", () => finished("close"));

  socket.write("GET /stream\n");
  socket.end(); // half-close immediately, legal for a request/response client

  assert.equal(await completed, "end", "relay must deliver the full stream, then FIN");
  assert.equal(received.length, CHUNKS, `expected ${CHUNKS} chunks, got ${received.length}`);
  assert.deepEqual(received, Array.from({ length: CHUNKS }, (_, i) => `chunk-${i}`));
});

test("abrupt client aborts are reclaimed instead of lingering", async () => {
  const baseline = await awaitStats((s) => s.live === 0, 5000, "baseline idle");
  const clients = [];
  for (let i = 0; i < ABORTS; i++) clients.push(await openClient());
  for (const socket of clients) {
    socket.on("error", () => {});
    socket.resetAndDestroy();
  }

  const settled = await awaitStats(
    (s) => s.accepted - baseline.accepted >= ABORTS && s.live === 0,
    10000,
    "aborts reclaimed",
  );
  assert.equal(settled.live, 0, "no connection may stay live after abrupt aborts");
  assert.equal(
    settled.accepted - settled.closed,
    0,
    `accepted=${settled.accepted} closed=${settled.closed} — every accepted pair must be closed`,
  );
});

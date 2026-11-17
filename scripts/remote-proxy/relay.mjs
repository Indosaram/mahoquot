#!/usr/bin/env bun
// mahoquot-remote-proxy — single-process TCP relay for the remote mahoquot gateway.
//
// Topology:
//   127.0.0.1:18801          (local clients: mhc / desktop app / MAHOQUOT_URL)
//   <tailnet 100.64/10>:18801 (other tailnet devices; replaces mahoquot-tailscale-proxy)
//        -> 100.91.254.71:18801  (remote gateway)
//
// Why this exists: `ssh -L 18801` wedged after ~10s of traffic over Tailscale SSH and
// left every localhost:18801 request hanging. A raw TCP pipe replaced it.
//
// Socket lifecycle contract (the part the old 29-line version got wrong):
//   - every pair is torn down on close/error of EITHER side, so fds return immediately
//   - half-close is propagated (pipe ends the peer) and bounded by FIN_GRACE_MS,
//     which restarts on every byte so a client that half-closes keeps its stream
//   - upstream connect is bounded by CONNECT_TIMEOUT_MS
//   - TCP keepalive detects dead peers that never send FIN/RST
//   - a watchdog exits the process for a clean launchd restart if fds run away
import net from "node:net";
import os from "node:os";
import fs from "node:fs";

const TARGET_HOST = process.env.TARGET_HOST || "100.91.254.71";
const TARGET_PORT = Number(process.env.TARGET_PORT || "18801");
const LISTEN_PORT = Number(process.env.LISTEN_PORT || "18801");
const LOOPBACK_HOST = process.env.LISTEN_HOST || "127.0.0.1";

const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || "10000");
const FIN_GRACE_MS = Number(process.env.FIN_GRACE_MS || "60000");
const STATS_EVERY_TICKS = Number(process.env.STATS_EVERY_TICKS || "20");
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS || "30000");
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || "30000");
const FD_MAX = Number(process.env.FD_MAX || "65536");
const FD_WARN_RATIO = Number(process.env.FD_WARN_RATIO || "0.8");
const TAILNET_REDISCOVER_MS = Number(process.env.TAILNET_REDISCOVER_MS || "5000");
const ENABLE_TAILNET = process.env.DISABLE_TAILNET !== "1";

const startedAt = Date.now();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const stats = {
  accepted: 0,
  closed: 0,
  clientFin: 0,
  upstreamFin: 0,
  clientErr: 0,
  upstreamErr: 0,
  connectFail: 0,
  connectTimeout: 0,
  finGrace: 0,
};
const live = new Set();

function describe(err) {
  return err && err.code ? err.code : String(err);
}

function handleConnection(kind, client) {
  stats.accepted++;
  const pair = { kind, openedAt: Date.now() };
  live.add(pair);

  client.setNoDelay(true);
  try {
    client.setKeepAlive(true, KEEPALIVE_MS);
  } catch {}

  const upstream = net.connect({ host: TARGET_HOST, port: TARGET_PORT });
  upstream.setNoDelay(true);
  try {
    upstream.setKeepAlive(true, KEEPALIVE_MS);
  } catch {}

  let done = false;
  let grace = null;

  const connectTimer = setTimeout(() => {
    stats.connectTimeout++;
    finish("connect-timeout");
  }, CONNECT_TIMEOUT_MS);

  // One side sent FIN. The peer may still be streaming a response (a client that
  // half-closes after its request is legal), so the deadline restarts on every byte
  // and only reclaims pairs that have truly gone quiet.
  const graceAfterFin = () => {
    if (done) return;
    if (grace) clearTimeout(grace);
    grace = setTimeout(() => finish("fin-grace"), FIN_GRACE_MS);
  };
  const onData = () => {
    if (grace) graceAfterFin();
  };
  client.on("data", onData);
  upstream.on("data", onData);

  function finish(reason) {
    if (done) return;
    done = true;
    pair.reason = reason;
    clearTimeout(connectTimer);
    if (grace) clearTimeout(grace);
    stats.closed++;
    live.delete(pair);
    // destroy (not end) so the fd is released on both sides immediately
    client.destroy();
    upstream.destroy();
  }
  pair.finish = finish;

  upstream.once("connect", () => clearTimeout(connectTimer));

  upstream.on("error", (err) => {
    if (!done && upstream.bytesRead === 0) stats.connectFail++;
    stats.upstreamErr++;
    finish(`upstream-error:${describe(err)}`);
  });
  client.on("error", (err) => {
    stats.clientErr++;
    finish(`client-error:${describe(err)}`);
  });

  // pipe() propagates FIN; we only need to bound the lingering half-closed window.
  client.on("end", () => {
    stats.clientFin++;
    graceAfterFin();
  });
  upstream.on("end", () => {
    stats.upstreamFin++;
    graceAfterFin();
  });

  client.on("close", () => finish("client-close"));
  upstream.on("close", () => finish("upstream-close"));

  client.pipe(upstream);
  upstream.pipe(client);
}

function makeServer(kind, host) {
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    handleConnection(kind, client);
  });
  server.on("error", (err) => {
    log(`listen-error kind=${kind} host=${host} err=${describe(err)}`);
    // A tailnet rebind can fail transiently (address dropped); loopback is fatal.
    if (kind === "loopback") process.exit(1);
  });
  server.listen(LISTEN_PORT, host, () => {
    log(`listening kind=${kind} ${host}:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
  });
  return server;
}

// --- loopback listener: keeps localhost:18801 stable for every local consumer ---
makeServer("loopback", LOOPBACK_HOST);

// --- tailnet listener: replaces the separate mahoquot-tailscale-proxy process ---
function tailnetAddresses() {
  const found = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const [a, b] = addr.address.split(".").map(Number);
      if (a === 100 && b >= 64 && b <= 127) found.push(addr.address); // 100.64.0.0/10
    }
  }
  return found;
}

const tailnetServers = new Map();
function syncTailnetListeners() {
  if (!ENABLE_TAILNET) return;
  const present = new Set(tailnetAddresses());
  for (const [addr, server] of tailnetServers) {
    if (present.has(addr)) continue;
    log(`tailnet-address-gone ${addr}`);
    server.close();
    tailnetServers.delete(addr);
  }
  for (const addr of present) {
    if (tailnetServers.has(addr)) continue;
    tailnetServers.set(addr, makeServer("tailnet", addr));
  }
}

syncTailnetListeners();
setInterval(syncTailnetListeners, TAILNET_REDISCOVER_MS).unref();

// --- watchdog: exit for a clean launchd restart if fds run away ---
function fdCount() {
  try {
    return fs.readdirSync("/dev/fd").length;
  } catch {
    return -1;
  }
}

let ticks = 0;
setInterval(() => {
  ticks++;
  const fds = fdCount();
  const uptimeMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  if (fds > 0 && fds > FD_MAX * FD_WARN_RATIO) {
    log(`fd-watchdog tripped fds=${fds} limit=${FD_MAX}; exiting for clean restart`);
    process.exit(1);
  }
  if (ticks % STATS_EVERY_TICKS === 0) {
    log(
      `stats uptime=${uptimeMin}m live=${live.size} accepted=${stats.accepted} closed=${stats.closed}` +
        ` fin=${stats.clientFin}/${stats.upstreamFin} err=${stats.clientErr}/${stats.upstreamErr}` +
        ` connectFail=${stats.connectFail} connectTimeout=${stats.connectTimeout} fds=${fds}`,
    );
  }
}, WATCHDOG_INTERVAL_MS);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log(`signal ${signal}; draining ${live.size} connection(s)`);
    for (const pair of [...live]) {
      try {
        pair.finish?.(`signal-${signal}`);
      } catch {}
    }
    process.exit(0);
  });
}

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { snapshotGuestProfiles, requireAbsentGuestProfiles } from "./desktop-guest-profiles.mjs";
import { observeGatewayLifecycle } from "./desktop-lifecycle-events.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gatewayDir = join(root, "mahoquot-proxy");
const monitorUiDir = join(root, "crates/monitor-ui");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function bounded(promise, label, timeout = 30000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function collectCommand(child, label) {
  const observations = [
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ];
  const settled = Promise.allSettled(observations);
  try {
    return await bounded(Promise.all(observations), label);
  } catch (error) {
    const errors = [error];
    try { child.kill("SIGKILL"); } catch (killError) { errors.push(killError); }
    try {
      const results = await bounded(settled, `${label} termination and pipe drain`, 15000);
      for (const result of results) {
        if (result.status === "rejected" && !errors.includes(result.reason)) errors.push(result.reason);
      }
    } catch (cleanupError) { errors.push(cleanupError); }
    throw new AggregateError(errors, `${label} failed`);
  }
}

async function git(directory, ...args) {
  const child = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, error, code] = await collectCommand(child, "git " + args.join(" "));
  assert(code === 0, error);
  return text.trim();
}

async function releasedPort(port) {
  const probe = createNetServer();
  await bounded(
    new Promise((done, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", done);
    }),
    `port rebind ${port}`
  );
  await new Promise((done, reject) =>
    probe.close((error) => (error ? reject(error) : done()))
  );
  return { port, rebound: true };
}

// Caller-authored receipts and alternate HOME do not establish isolation.
export const DESKTOP_ADMISSION_BLOCKER = "K1: root/orchestrator must verify an actual disposable guest and obtain separate screen authorization";

async function securityCommand(args) {
  const proc = Bun.spawn(["/usr/bin/security", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await collectCommand(proc, `security ${args[0]}`);
  assert(code === 0, `security ${args[0]} failed (${code}): ${stderr || stdout}`);
  return stdout;
}

export function parseKeychainPaths(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    assert(/^"\/[^"\r\n]+"$/.test(line), "unrecognized security keychain path output");
    return line.slice(1, -1);
  });
}

// Snapshot the real guest login domain before any mutation, not an alternate HOME.
export async function keychainTransaction(run) {
  const originalDefault = parseKeychainPaths(await run(["default-keychain", "-d", "user"]));
  const originalSearch = parseKeychainPaths(await run(["list-keychains", "-d", "user"]));
  assert(originalDefault.length === 1, "cannot restore absent/ambiguous default keychain");
  const owned = new Set();
  return {
    async create(path, password) {
      assert(!owned.has(path) && !originalSearch.includes(path) && !originalDefault.includes(path), "keychain path is not newly owned");
      await run(["create-keychain", "-p", password, path]);
      owned.add(path);
      await run(["unlock-keychain", "-p", password, path]);
      await run(["set-keychain-settings", path]);
      await run(["list-keychains", "-d", "user", "-s", path]);
      await run(["default-keychain", "-d", "user", "-s", path]);
    },
    async restore() {
      const errors = [];
      const attempt = async (action) => { try { await action(); } catch (error) { errors.push(error); } };
      await attempt(() => run(["list-keychains", "-d", "user", "-s", ...originalSearch]));
      await attempt(() => run(["default-keychain", "-d", "user", "-s", ...originalDefault]));
      await attempt(async () => {
        const currentDefault = parseKeychainPaths(await run(["default-keychain", "-d", "user"]));
        const currentSearch = parseKeychainPaths(await run(["list-keychains", "-d", "user"]));
        assert(JSON.stringify(currentDefault) === JSON.stringify(originalDefault) &&
          JSON.stringify(currentSearch) === JSON.stringify(originalSearch), "keychain restoration mismatch");
      });
      // Never delete a keychain while preference restoration is uncertain.
      if (errors.length === 0) {
        for (const path of owned) await attempt(async () => {
          await run(["delete-keychain", path]);
          owned.delete(path);
        });
      }
      if (errors.length) throw new AggregateError(errors, "keychain cleanup failed; preserve guest for inspection");
    },
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    return response.status === 200;
  } catch (_) {
    return false;
  }
}

async function findDesktopBinary() {
  const candidates = [join(root, ".omo/shared-target-desktop/debug/mahoquot")];
  for (const candidate of candidates) {
    const bytes = await readFile(candidate).catch(() => null);
    if (bytes && bytes.length > 0) {
      return { path: candidate, sha256: hash(bytes) };
    }
  }
  throw new Error(`Real desktop binary not found (${candidates.join(", ")}); build it with --features custom-protocol first`);
}

async function createIsolatedKeychain(home, events, keychains) {
  const keychainDir = join(home, "Library/Keychains");
  await mkdir(keychainDir, { recursive: true });
  await mkdir(join(home, "Library/Preferences"), { recursive: true });
  const path = join(keychainDir, "desktop-qa.keychain-db");
  await keychains.create(path, `desktop-qa-${randomUUID()}`);
  events.push({ type: "guest-keychain-created", path });
}

/** One isolated HOME with config, optional credential fixture and keychain. */
async function prepareHome(work, name, { port, upstreamPort, credential, inferenceKey, mgmtSecret, events, keychains }) {
  const home = join(work, name);
  const auth = join(home, ".mahoquot/auth");
  await mkdir(auth, { recursive: true });
  await createIsolatedKeychain(home, events, keychains);
  await writeFile(join(home, ".mahoquot/connection.json"), JSON.stringify({ base_url: `http://127.0.0.1:${port}` }));
  if (credential) {
    await writeFile(
      join(auth, `${credential}.json`),
      JSON.stringify({
        type: "plus",
        identity_slug: credential,
        account_id: credential,
        access_token: `token-${credential}`,
        refresh_token: "fixture-refresh",
        id_token: "fixture-id",
        email: `${credential}@fixture.invalid`,
        expired: "2099-01-01T00:00:00Z",
        last_refresh: "2098-01-01T00:00:00Z",
        upstream_override: `http://127.0.0.1:${upstreamPort}`,
        usage_override: `http://127.0.0.1:${upstreamPort}`,
      })
    );
  }
  await writeFile(
    join(auth, "config.yaml"),
    [
      `api-keys: [${inferenceKey}]`,
      "model-catalog:",
      "  refresh-enabled: false",
      "remote-management:",
      "  allow-remote: false",
      `  secret-key: ${JSON.stringify(mgmtSecret)}`,
      "routing:",
      "  strategy: fill-first",
      "",
    ].join("\n")
  );
  return home;
}

/**
 * Launches the real Tauri app with the opt-in native QA driver. The driver
 * waits for "start" on stdin, performs the scenario through AppKit and prints
 * one `MAHOQUOT_NATIVE_QA <json>` report; "quit" makes it use the tray menu's
 * Quit item, so the process exits through the product's own quit path.
 */
export function observeNativeReport(child, prefix = "MAHOQUOT_NATIVE_QA ", accept = (report) => Array.isArray(report.steps)) {
  let pending = "";
  return new Promise((resolveReport, rejectReport) => {
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error) => { cleanup(); rejectReport(error); };
    const onExit = (code, signal) => onError(new Error(`native app exited before report (${code}, ${signal})`));
    const onData = (data) => {
      pending += data.toString();
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.startsWith(prefix)) continue;
        try {
          const report = JSON.parse(line.slice(prefix.length));
          if (prefix !== "MAHOQUOT_NATIVE_QA " && !accept(report)) continue;
          assert(accept(report), "native report missing steps");
          cleanup();
          resolveReport(report);
        } catch (error) { onError(error); }
        return;
      }
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function launchNativeApp(binary, { home, port, gatewayBin, scenario, artifacts, account, model, keychainService, inferenceKey }) {
  const child = spawn("/usr/bin/python3", [join(root, "scripts/qa/cases/desktop-process-supervisor.py"), "--supervise", binary], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MAHOQUOT_GATEWAY_BIN: gatewayBin,
      MAHOQUOT_URL: `http://127.0.0.1:${port}`,
      MAHOQUOT_QA_LOOPBACK_ONLY: "1",
      MAHOQUOT_API_KEY: inferenceKey,
      MAHOQUOT_KEYCHAIN_SERVICE: keychainService,
      MAHOQUOT_NATIVE_QA: scenario,
      MAHOQUOT_NATIVE_QA_ARTIFACTS: artifacts,
      MAHOQUOT_NATIVE_QA_ACCOUNT: account ?? "",
      MAHOQUOT_NATIVE_QA_MODEL: model ?? "",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const app = { child, stdout: "", stderr: "", lifecycle: observeGatewayLifecycle(child) };
  // Subscribe before start/quit can be sent; only newline-complete reports parse.
  app.reportPromise = observeNativeReport(child);
  // A launch/early-exit error can arrive before runScenario awaits the promise.
  app.reportPromise.catch(() => {});
  child.stdout.on("data", (data) => {
    app.stdout = (app.stdout + data.toString()).slice(-20000);
  });
  child.stderr.on("data", (data) => {
    app.stderr = (app.stderr + data.toString()).slice(-20000);
  });
  app.started = observeNativeReport(child, "MAHOQUOT_QA_SUPERVISOR ", (event) => event.event === "app-spawned");
  app.started.catch(() => {});
  app.exited = observeNativeReport(child, "MAHOQUOT_QA_SUPERVISOR ", (event) => event.event === "app-exited");
  app.exited.catch(() => {});
  app.stopped = observeNativeReport(child, "MAHOQUOT_QA_SUPERVISOR ", (event) => event.event === "group-terminated");
  app.stopped.catch(() => {});
  app.supervisorClosed = new Promise((done) => child.once("close", (code, signal) => done({ code, signal })));
  app.inputFailure = null;
  child.stdin.on("error", (error) => { app.inputFailure = error; });
  app.send = (command) => {
    if (app.inputFailure) throw app.inputFailure;
    child.stdin.write(`${command}\n`);
  };
  return app;
}

async function runScenario(app, label) {
  app.send("start");
  const report = await bounded(
    Promise.race([app.reportPromise, app.exited.then((exit) => Promise.reject(new Error(`app exited before ${label} report: ${JSON.stringify(exit)}\n${app.stderr}`)))]),
    `${label} native report`,
    180000
  );
  assert(!report.error, `${label} native driver failed: ${report.error}\n${app.stderr.slice(-4000)}`);
  return report;
}

/** Quits through the tray menu and returns the observed exit. */
async function quitThroughTray(app, label) {
  app.send("quit");
  const exit = await bounded(app.exited, `${label} tray Quit exit`, 20000);
  return exit; // Supervisor cleanup is separate: it must not make Quit pass.
}

export async function forceStop(app) {
  if (!app) return null;
  const errors = [];
  if (!app.stopRequested) {
    app.stopRequested = true;
    // Delivery failure must not bypass observation of the EOF cleanup path.
    try { app.send("supervisor-stop"); }
    catch (error) { errors.push(error); }
    try { app.child.stdin.end(); }
    catch (error) { errors.push(error); }
  }
  // Subscribe to both deadlines even if either observation rejects first.
  const [stopped, closed] = await Promise.allSettled([
    bounded(app.stopped, "owned process group termination", 15000),
    bounded(app.supervisorClosed, "supervisor reap and pipe closure", 15000),
  ]);
  if (stopped.status === "rejected") errors.push(stopped.reason);
  if (closed.status === "rejected") errors.push(closed.reason);
  else if (closed.value.code !== 0) errors.push(new Error(`supervisor failed: ${JSON.stringify(closed.value)}`));
  if (errors.length) throw new AggregateError(errors, "supervisor delivery or cleanup failed");
  return closed.value;
}

const step = (report, name) => report.steps.find((entry) => entry.step === name)?.detail;

export async function runCase(variant, evidencePath, context) {
  throw new Error(DESKTOP_ADMISSION_BLOCKER);
}

// Retained for repair in a disposable user/VM; deliberately not exported or dispatched.
async function runUncertifiedCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "unknown desktop-parity variant");
  assert(process.platform === "darwin", "desktop-parity drives native AppKit surfaces and requires macOS");
  const ports = context.ports;
  assert(
    ports?.length === 2 &&
      ports[0] !== ports[1] &&
      ports.every((port) => Number.isInteger(port) && port >= 18840 && port <= 18899),
    "desktop-parity requires two leased test ports"
  );

  const closure = await context.getSourceClosure();
  const revision = await git(gatewayDir, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const binding = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingBytes = await readFile(binding);
  const bindingLines = bindingBytes.toString().trim().split("\n");
  assert(
    bindingLines[0] === revision &&
      bindingLines[1] === binaryHash &&
      bindingLines[2] === closure.sourceHash &&
      bindingLines[3] === context.buildCommand,
    "desktop-parity requires a current source-bound binary; no build is performed here"
  );
  const desktop = await findDesktopBinary();

  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "desktop-parity-"));
  // Native screenshots are retained next to the receipt as supplementary evidence.
  const artifacts = join(dirname(evidencePath), "task-38-native", variant);
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });

  const events = [];
  const wireRequests = [];
  const assertions = [];
  const record = (id, expected, actual) =>
    assertions.push({ id, expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual) });

  const sentinel = "cliproxy-desktop-parity-sentinel";
  const mgmtSecret = "desktop-dedicated-secret-2026";
  const inferenceKey = "desktop-inference-key-fixture";
  const model = "gpt-5.6-sol";
  const keychainService = `desktop-qa-${randomUUID().replace(/[^a-zA-Z0-9-]/g, "")}`;
  assert(keychainService !== "mahoquot.desktop" && keychainService.startsWith("desktop-qa-"), "Keychain safety invariant violated");

  let processesStopped = false;
  let profiles = null;
  let keychains = null;
  let keychainsRestored = false;
  let mock = null;
  let app = null;
  let failure = null;
  let exit = null;
  let externalDials = 0;
  const ownedPids = new Set();

  const startMock = (usedPercent) => {
    mock = Bun.serve({
      hostname: "127.0.0.1",
      port: ports[1],
      async fetch(request) {
        const url = new URL(request.url);
        if (!["127.0.0.1", "localhost"].includes(url.hostname)) externalDials += 1;
        const body = await request.text();
        if (request.method === "POST") {
          wireRequests.push({
            method: request.method,
            path: url.pathname,
            headers: Object.fromEntries(request.headers),
            body,
            body_bytes_base64: Buffer.from(body).toString("base64"),
            body_sha256: hash(body),
          });
          events.push({ type: "mock-inference-request", path: url.pathname });
          return Response.json({ id: "chatcmpl-desktop-parity", object: "response", status: "completed", output: [], marker: sentinel });
        }
        return Response.json({ rate_limits: { primary: { window_minutes: 300, reset_after_seconds: 3600, used_percent: usedPercent } } });
      },
    });
  };

  const observeGatewayChild = async (current) => {
    const spawned = await bounded(current.lifecycle.wait("spawned"), "owned gateway spawn", 45000);
    await bounded(current.lifecycle.wait("ready", spawned.generation), "owned listener readiness", 45000);
    current.gatewayGeneration = spawned.generation;
    ownedPids.add(spawned.pid);
    events.push({ type: "native-gateway-ready", ...spawned });
    return { gatewayPid: spawned.pid, command: context.binary };
  };

  try {
    // Supplied only by the root-verified guest invocation, never HOME-derived.
    await requireAbsentGuestProfiles(context.guestHome);
    profiles = await snapshotGuestProfiles(context.guestHome);
    keychains = await keychainTransaction(securityCommand);
    await releasedPort(ports[0]);
    await releasedPort(ports[1]);

    if (variant === "happy") {
      startMock(42);
      const credential = "codex-desktop-primary";
      const account = "desktop-primary";
      const home = await prepareHome(work, "home-happy", { port: ports[0], upstreamPort: ports[1], credential, inferenceKey, mgmtSecret, events, keychains });
      app = launchNativeApp(desktop.path, { home, port: ports[0], gatewayBin: context.binary, scenario: "happy", artifacts, account, model, keychainService, inferenceKey });
      const appPid = (await bounded(app.started, "native app spawn")).pid;
      ownedPids.add(appPid);
      const { gatewayPid, command } = await observeGatewayChild(app);
      const mgmt = await fetch(`http://127.0.0.1:${ports[0]}/v0/management/auth-files`, {
        headers: { authorization: `Bearer ${mgmtSecret}` },
        signal: AbortSignal.timeout(10000),
      });
      events.push({ type: "real-app-bootstrap-observed", app_pid: appPid, gateway_child_pid: gatewayPid, gateway_command: command, desktop_binary: desktop.path, desktop_sha256: desktop.sha256, management_status: mgmt.status, namespaced_keychain_service: keychainService });
      record("real-app-bootstrap", true, appPid > 0 && gatewayPid > 0 && mgmt.status === 200);

      const inference = await fetch(`http://127.0.0.1:${ports[0]}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${inferenceKey}` },
        body: JSON.stringify({ model, input: "desktop parity history probe", stream: false }),
        signal: AbortSignal.timeout(15000),
      });
      const inferenceBody = await inference.text();
      const reachedMock = wireRequests.some((entry) => entry.path === "/backend-api/codex/responses");
      events.push({ type: "app-gateway-inference", status: inference.status, reached_mock: reachedMock, sentinel_echoed: inferenceBody.includes(sentinel) });

      const report = await runScenario(app, "happy");
      const accounts = step(report, "accounts");
      const history = step(report, "history");
      const settings = step(report, "settings");
      const notch = step(report, "notch-hover");
      const tray = step(report, "tray-panel");
      const shot = step(report, "console-screenshot");
      events.push({ type: "native-console-navigation", input: "AppKit NSEvent left click on Primary navigation", accounts, history, settings, console_screenshot: shot });
      events.push({ type: "native-notch-hover", input: "CGWarpMouseCursorPosition + NSMouseMoved through product hover monitor", ...notch });
      events.push({ type: "native-tray-panel", input: "AppKit NSEvent left click on NSStatusItem button", ...tray });
      record(
        "settings-and-history",
        true,
        inference.status === 200 &&
          reachedMock &&
          accounts?.rendered === true &&
          typeof history?.row === "string" &&
          history.row.includes(model) &&
          settings?.gateway_url_field === true &&
          notch?.right_edge_stable === true &&
          notch?.dom_expanded_then_collapsed === true &&
          tray?.shown === true &&
          tray?.account_rendered === true &&
          tray?.hidden_on_second_click === true &&
          shot?.exit === 0 &&
          shot?.bytes > 0
      );

      // Window close (red button semantics) hides the console; app and child keep running.
      const closed = step(report, "console-close");
      const afterClose = {
        app_alive: processAlive(appPid),
        gateway_alive: processAlive(gatewayPid),
        gateway_healthz: await healthy(ports[0]),
        reported_gateway_pid: closed?.gateway_pid,
      };
      events.push({ type: "native-window-close", input: "NSWindow performClose:", ...afterClose });

      // Quit through the tray menu: the app exits and takes the gateway child with it.
      exit = await quitThroughTray(app, "happy");
      const gatewayGone = (await bounded(app.lifecycle.wait("reaped", app.gatewayGeneration), "gateway reap after Quit", 10000)).pid === gatewayPid;
      await forceStop(app);
      app = null;
      const portFreed = (await releasedPort(ports[0]).catch(() => ({ rebound: false }))).rebound;
      events.push({ type: "native-tray-quit", input: "tray menu 'Quit Mahoquot' performActionForItemAtIndex:", exit, gateway_exited: gatewayGone, port_released: portFreed });
      record(
        "child-exit",
        true,
        afterClose.app_alive &&
          afterClose.gateway_alive &&
          afterClose.gateway_healthz &&
          afterClose.reported_gateway_pid === gatewayPid &&
          exit.code === 0 &&
          exit.signal === null &&
          gatewayGone === true &&
          portFreed
      );
    } else {
      // Unreachable gateway: the owned gateway binary cannot start, so the real
      // console must surface the native shell's actionable failure.
      const unreachableHome = await prepareHome(work, "home-unreachable", { port: ports[0], upstreamPort: ports[1], credential: null, inferenceKey, mgmtSecret, events, keychains });
      const missingGateway = join(work, "missing-gateway-binary");
      app = launchNativeApp(desktop.path, { home: unreachableHome, port: ports[0], gatewayBin: missingGateway, scenario: "unreachable", artifacts, keychainService, inferenceKey });
      ownedPids.add((await bounded(app.started, "native app spawn")).pid);
      const unreachable = await runScenario(app, "unreachable");
      const banner = step(unreachable, "gateway-failure-banner")?.text ?? "";
      const healthzWhileUp = await healthy(ports[0]);
      const unreachableExit = await quitThroughTray(app, "unreachable");
      await forceStop(app);
      app = null;
      events.push({ type: "native-unreachable-gateway", banner, gateway_healthz: healthzWhileUp, screenshot: step(unreachable, "console-screenshot"), exit: unreachableExit });
      record(
        "unreachable-gateway-actionable",
        true,
        !healthzWhileUp &&
          banner.includes("The gateway is not running") &&
          banner.includes(missingGateway) &&
          unreachableExit.code === 0
      );

      // Unknown quota: provider reports no percentage; the real app must not fabricate 0%.
      startMock(null);
      const credential = "codex-desktop-unknown";
      const account = "desktop-unknown";
      const quotaHome = await prepareHome(work, "home-unknown-quota", { port: ports[0], upstreamPort: ports[1], credential, inferenceKey, mgmtSecret, events, keychains });
      app = launchNativeApp(desktop.path, { home: quotaHome, port: ports[0], gatewayBin: context.binary, scenario: "unknown-quota", artifacts, account, keychainService, inferenceKey });
      const appPid = (await bounded(app.started, "native app spawn")).pid;
      ownedPids.add(appPid);
      const { gatewayPid } = await observeGatewayChild(app);
      const quotaReport = await runScenario(app, "unknown-quota");
      const quota = step(quotaReport, "accounts-quota");
      exit = await quitThroughTray(app, "unknown-quota");
      const gatewayGone = (await bounded(app.lifecycle.wait("reaped", app.gatewayGeneration), "gateway reap after Quit", 10000)).pid === gatewayPid;
      await forceStop(app);
      app = null;
      events.push({ type: "native-unknown-quota", quota, screenshot: step(quotaReport, "console-screenshot"), exit, gateway_exited: gatewayGone });
      record("unknown-quota-preserved", true, quota?.unmeasured === true && quota?.fabricated_zero === false && exit.code === 0 && gatewayGone === true);
    }
    assert(assertions.every((entry) => entry.pass), `desktop-parity assertions failed: ${JSON.stringify(assertions.filter((entry) => !entry.pass))}`);
  } catch (error) {
    failure = error;
  } finally {
    try {
      const forced = await forceStop(app);
      if (forced) {
        exit = forced;
        events.push({ type: "forced-app-stop", ...forced });
      }
      processesStopped = true;
    } catch (error) {
      failure = new AggregateError([failure, error].filter(Boolean), "app cleanup failed");
    }
    if (mock) {
      try { await Promise.resolve(mock.stop(true)); }
      catch (error) { failure = new AggregateError([failure, error].filter(Boolean), "mock cleanup failed"); }
      mock = null;
    }
    try {
      assert(processesStopped, "retain keychains until supervised process cleanup succeeds");
      if (keychains) {
        await keychains.restore();
        events.push({ type: "keychain-preferences-restored" });
      }
      keychainsRestored = true;
    } catch (error) {
      failure = new AggregateError([failure, error].filter(Boolean), "desktop cleanup failed");
      events.push({ type: "keychain-cleanup-failed", error: String(error), retained_work: work });
    }
    const survivors = [...ownedPids].filter(processAlive);
    // Historical PID observations do not confer signal authority: a PID can
    // have been recycled. A guest supervisor must own/reap the complete tree.
    if (survivors.length) failure = new AggregateError(
      [failure, new Error(`unresolved process ownership at teardown: ${survivors.join(",")}`)].filter(Boolean),
      "guest supervisor cleanup required"
    );
    try {
      const probes = await Promise.all(ports.map(releasedPort));
      events.push({ type: "port-release-observations", probes, surviving_owned_processes: survivors });
    } catch (error) {
      failure ??= error;
    }
    try {
      assert(processesStopped, "retain profiles until supervised process cleanup succeeds");
      if (profiles) await profiles.restore();
    } catch (error) {
      failure = new AggregateError([failure, error].filter(Boolean), "profile cleanup failed");
    }
    if (keychainsRestored && !failure) {
      try { await rm(work, { recursive: true, force: true }); }
      catch (error) { failure = new AggregateError([failure, error].filter(Boolean), "scratch cleanup failed"); }
    }
  }

  const required =
    variant === "happy"
      ? ["real-app-bootstrap", "settings-and-history", "child-exit"]
      : ["unreachable-gateway-actionable", "unknown-quota-preserved"];
  const receipt = context.createReceipt({
    caseName: "desktop-parity",
    variant,
    assertions,
    requiredAssertionIds: required,
    events,
    wireRequests,
    externalDialCount: externalDials,
    provenance: {
      gateway_binary: context.binary,
      gateway_sha256: binaryHash,
      desktop_binary: desktop.path,
      desktop_sha256: desktop.sha256,
      desktop_revision: await git(root, "rev-parse", "HEAD"),
      gateway_revision: revision,
      gateway_source_sha256: closure.sourceHash,
      source_root: gatewayDir,
      source_manifest: { files: closure.files },
      build_command: context.buildCommand,
      build_receipt: { path: binding, sha256: hash(bindingBytes) },
      binary_source_revision: revision,
      dirty: Boolean(await git(gatewayDir, "status", "--porcelain")),
    },
    teardown: {
      exit,
      termination: "creation-owned-process-group; detached descendants not covered",
      listeners: failure ? null : 0,
      ownedProcesses: null,
      listener_inventory: [],
      process_inventory: [],
      external_dials: externalDials,
      failure: failure ? String(failure) : null,
    },
  });
  await writeFile(evidencePath, JSON.stringify(receipt, null, 2) + "\n");
  if (failure) throw failure;
  return receipt;
}

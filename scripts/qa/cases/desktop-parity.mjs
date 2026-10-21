import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";

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

async function git(directory, ...args) {
  const child = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  try {
    const [text, error, code] = await bounded(
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      "git " + args.join(" ")
    );
    assert(code === 0, error);
    return text.trim();
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  }
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

let isolatedKeychainPath = null;
const isolatedKeychainPassword = `desktop-qa-${randomUUID()}`;

async function deleteNamespacedKeychainEntries(serviceName) {
  assert(
    serviceName && serviceName !== "mahoquot.desktop" && serviceName.startsWith("desktop-qa-"),
    `Refusing to delete keychain entries for non-namespaced service: ${serviceName}`
  );
  // macOS security CLI deletes one matching entry per invocation;
  // loop until security reports that no matching item was found (exit code 44 / errSecItemNotFound).
  for (let attempt = 0; attempt < 20; attempt++) {
    const proc = Bun.spawn(
      ["security", "delete-generic-password", "-s", serviceName],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      // Exit code 44 or stderr containing "could not be found" / "SecKeychainSearchCopyNext" indicates no more entries exist
      break;
    }
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function childPids(parentPid) {
  const proc = Bun.spawn(["pgrep", "-P", String(parentPid)], { stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return stdout.split("\n").map((line) => Number(line.trim())).filter((pid) => pid > 0);
}

async function processCommand(pid) {
  const ps = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
  const [stdout, , code] = await Promise.all([
    new Response(ps.stdout).text(),
    new Response(ps.stderr).text(),
    ps.exited,
  ]);
  return code === 0 ? stdout.trim() : "";
}

/** Bounded wait for an observable condition; resolves with its value or throws. */
async function waitFor(label, probe, timeout = 30000, interval = 150) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${label} not observed within ${timeout}ms`);
    await new Promise((done) => setTimeout(done, interval));
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

async function createIsolatedKeychain(home, events) {
  const keychainDir = join(home, "Library/Keychains");
  await mkdir(keychainDir, { recursive: true });
  await mkdir(join(home, "Library/Preferences"), { recursive: true });
  const path = join(keychainDir, "desktop-qa.keychain-db");
  const env = { ...process.env, HOME: home };
  const run = async (args) => {
    const proc = Bun.spawn(["security", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    assert(code === 0, `security ${args[0]} failed (${code}): ${err || out}`);
    return out;
  };
  await run(["create-keychain", "-p", isolatedKeychainPassword, path]);
  isolatedKeychainPaths.push({ path, home });
  await run(["unlock-keychain", "-p", isolatedKeychainPassword, path]);
  await run(["set-keychain-settings", path]);
  await run(["list-keychains", "-d", "user", "-s", path]);
  await run(["default-keychain", "-d", "user", "-s", path]);
  const current = (await run(["default-keychain", "-d", "user"])).trim();
  assert(current.includes(path), `isolated HOME default keychain is not the QA keychain: ${current}`);
  events.push({ type: "isolated-keychain-created", path, default_keychain: current });
}

const isolatedKeychainPaths = [];

/** One isolated HOME with config, optional credential fixture and keychain. */
async function prepareHome(work, name, { port, upstreamPort, credential, inferenceKey, mgmtSecret, events }) {
  const home = join(work, name);
  const auth = join(home, ".mahoquot/auth");
  await mkdir(auth, { recursive: true });
  await createIsolatedKeychain(home, events);
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
function launchNativeApp(binary, { home, port, gatewayBin, scenario, artifacts, account, model, keychainService, inferenceKey }) {
  const child = spawn(binary, [], {
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
  const app = { child, stdout: "", stderr: "", report: null };
  let resolveReport;
  app.reportPromise = new Promise((done) => (resolveReport = done));
  child.stdout.on("data", (data) => {
    app.stdout += data.toString();
    const line = app.stdout.split("\n").find((entry) => entry.startsWith("MAHOQUOT_NATIVE_QA "));
    if (line && !app.report) {
      app.report = JSON.parse(line.slice("MAHOQUOT_NATIVE_QA ".length));
      resolveReport(app.report);
    }
  });
  child.stderr.on("data", (data) => {
    app.stderr = (app.stderr + data.toString()).slice(-20000);
  });
  app.exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  app.send = (command) => child.stdin.write(`${command}\n`);
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
  return await bounded(app.exited, `${label} tray Quit exit`, 20000);
}

async function forceStop(app) {
  if (!app || app.child.exitCode !== null || app.child.signalCode !== null) return null;
  app.child.kill("SIGKILL");
  return await bounded(app.exited, "forced app exit", 5000).catch(() => null);
}

const step = (report, name) => report.steps.find((entry) => entry.step === name)?.detail;

export async function runCase(variant, evidencePath, context) {
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

  const observeGatewayChild = async (appPid) => {
    const gatewayPid = await waitFor("gateway child process", async () => {
      for (const pid of await childPids(appPid)) {
        if ((await processCommand(pid)).includes(context.binary)) return pid;
      }
      return null;
    });
    ownedPids.add(gatewayPid);
    return { gatewayPid, command: await processCommand(gatewayPid) };
  };

  try {
    await releasedPort(ports[0]);
    await releasedPort(ports[1]);

    if (variant === "happy") {
      startMock(42);
      const credential = "codex-desktop-primary";
      const account = "desktop-primary";
      const home = await prepareHome(work, "home-happy", { port: ports[0], upstreamPort: ports[1], credential, inferenceKey, mgmtSecret, events });
      app = launchNativeApp(desktop.path, { home, port: ports[0], gatewayBin: context.binary, scenario: "happy", artifacts, account, model, keychainService, inferenceKey });
      const appPid = app.child.pid;
      ownedPids.add(appPid);
      await waitFor("gateway /healthz via real app", () => healthy(ports[0]), 45000);
      const { gatewayPid, command } = await observeGatewayChild(appPid);
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
      app = null;
      const gatewayGone = await waitFor("gateway child exit after Quit", async () => !processAlive(gatewayPid), 10000).catch(() => false);
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
      const unreachableHome = await prepareHome(work, "home-unreachable", { port: ports[0], upstreamPort: ports[1], credential: null, inferenceKey, mgmtSecret, events });
      const missingGateway = join(work, "missing-gateway-binary");
      app = launchNativeApp(desktop.path, { home: unreachableHome, port: ports[0], gatewayBin: missingGateway, scenario: "unreachable", artifacts, keychainService, inferenceKey });
      ownedPids.add(app.child.pid);
      const unreachable = await runScenario(app, "unreachable");
      const banner = step(unreachable, "gateway-failure-banner")?.text ?? "";
      const healthzWhileUp = await healthy(ports[0]);
      const unreachableExit = await quitThroughTray(app, "unreachable");
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
      const quotaHome = await prepareHome(work, "home-unknown-quota", { port: ports[0], upstreamPort: ports[1], credential, inferenceKey, mgmtSecret, events });
      app = launchNativeApp(desktop.path, { home: quotaHome, port: ports[0], gatewayBin: context.binary, scenario: "unknown-quota", artifacts, account, keychainService, inferenceKey });
      const appPid = app.child.pid;
      ownedPids.add(appPid);
      await waitFor("gateway /healthz via real app", () => healthy(ports[0]), 45000);
      const { gatewayPid } = await observeGatewayChild(appPid);
      const quotaReport = await runScenario(app, "unknown-quota");
      const quota = step(quotaReport, "accounts-quota");
      exit = await quitThroughTray(app, "unknown-quota");
      app = null;
      const gatewayGone = await waitFor("gateway child exit after Quit", async () => !processAlive(gatewayPid), 10000).catch(() => false);
      events.push({ type: "native-unknown-quota", quota, screenshot: step(quotaReport, "console-screenshot"), exit, gateway_exited: gatewayGone });
      record("unknown-quota-preserved", true, quota?.unmeasured === true && quota?.fabricated_zero === false && exit.code === 0 && gatewayGone === true);
    }
    assert(assertions.every((entry) => entry.pass), `desktop-parity assertions failed: ${JSON.stringify(assertions.filter((entry) => !entry.pass))}`);
  } catch (error) {
    failure = error;
  } finally {
    const forced = await forceStop(app);
    if (forced) {
      exit = forced;
      events.push({ type: "forced-app-stop", ...forced });
    }
    if (mock) {
      await Promise.resolve(mock.stop(true)).catch(() => {});
      mock = null;
    }
    for (const { path, home } of isolatedKeychainPaths.splice(0)) {
      const proc = Bun.spawn(["security", "delete-keychain", path], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      events.push({ type: "isolated-keychain-deleted", path, exit_code: proc.exitCode });
    }
    try {
      await deleteNamespacedKeychainEntries(keychainService);
      events.push({ type: "keychain-cleanup-observed", service: keychainService });
    } catch (error) {
      failure ??= error;
    }
    const survivors = [...ownedPids].filter(processAlive);
    for (const pid of survivors) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (_) {}
    }
    if (survivors.length) failure ??= new Error(`owned processes survived teardown: ${survivors.join(",")}`);
    try {
      const probes = await Promise.all(ports.map(releasedPort));
      events.push({ type: "port-release-observations", probes, surviving_owned_processes: survivors });
    } catch (error) {
      failure ??= error;
    }
    await rm(work, { recursive: true, force: true }).catch(() => {});
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
      termination: "controlled",
      listeners: failure ? null : 0,
      ownedProcesses: failure ? null : 0,
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

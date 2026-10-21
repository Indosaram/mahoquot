import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gateway = join(root, "mahoquot-proxy");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assert(value, message) { if (!value) throw new Error(message); }
async function bounded(promise, label, timeout = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out")), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function git(directory, ...args) {
  const child = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  try {
    const [text, error, code] = await bounded(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), "git " + args.join(" "));
    assert(code === 0, error);
    return text.trim();
  } catch (error) { child.kill("SIGKILL"); await child.exited; throw error; }
}
async function releasedPort(port) {
  const probe = createServer();
  await bounded(new Promise((done, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", done);
  }), "port rebind");
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
  return { port, rebound: true };
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "unknown settings variant");
  const ports = context.ports;
  assert(ports?.length === 2 && ports[0] !== ports[1] && ports.every((port) =>
    Number.isInteger(port) && port >= 18840 && port <= 18899), "settings requires two leased test ports");
  const closure = await context.getSourceClosure();
  const revision = await git(gateway, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const binding = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingBytes = await readFile(binding);
  const lines = bindingBytes.toString().trim().split("\n");
  assert(lines[0] === revision && lines[1] === binaryHash && lines[2] === closure.sourceHash &&
    lines[3] === context.buildCommand, "settings requires a current source-bound binary; no build is performed here");
  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "settings-"));
  const auth = join(work, "auth"), config = join(work, "config.yaml");
  const events = [], wireRequests = [], assertions = [], sequence = [];
  let child, mock, exitPromise, pipePromise, exit, failure;
  const record = (id, expected, actual) => assertions.push({ id, expected, actual,
    pass: JSON.stringify(expected) === JSON.stringify(actual) });
  try {
    await releasedPort(ports[0]);
    await releasedPort(ports[1]);
    await mkdir(auth);
    for (const id of ["A", "B"]) {
      await writeFile(join(auth, "codex-" + id + ".json"), JSON.stringify({
        type: "plus", identity_slug: id, account_id: id, access_token: "token-" + id,
        refresh_token: "fixture", id_token: "fixture", email: id + "@fixture.invalid",
        expired: "2099-01-01T00:00:00Z", last_refresh: "2098-01-01T00:00:00Z",
        upstream_override: "http://127.0.0.1:" + ports[1], usage_override: "http://127.0.0.1:" + ports[1],
      }));
    }
    const yaml = (strategy) => "api-keys: [task7-fixture]\nrequest-retry: 0\nmax-retry-interval: 0\nremote-management:\n  secret-key: task7-management-secret\nrouting:\n  strategy: " + strategy + "\n";
    await writeFile(config, yaml("fill-first"));
    mock = Bun.serve({ hostname: "127.0.0.1", port: ports[1], async fetch(request) {
      const body = await request.text(), path = new URL(request.url).pathname;
      if (request.method !== "POST") return Response.json({ rate_limits: {} });
      const headers = Object.fromEntries(request.headers);
      const account = headers.authorization?.replace("Bearer token-", "");
      assert(["A", "B"].includes(account), "unknown upstream account");
      assert(!headers["x-session-id"] && !headers["x-client-request-id"], "routing headers leaked upstream");
      sequence.push(account);
      wireRequests.push({ method: request.method, path, headers, account, body,
        body_bytes_base64: Buffer.from(body).toString("base64"), body_sha256: hash(body) });
      events.push({ type: "upstream-selection", account });
      return Response.json({ id: "settings-" + account, object: "response", status: "completed",
        output: [], marker: "settings-wire-sentinel" });
    } });
    let readyResolve;
    const ready = new Promise((done) => { readyResolve = done; });
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(ports[0]),
      "--auth-dir", auth, "--strategy", "fill-first", "--auth-refresh", "false",
      "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: gateway, env: { ...process.env, AUTH_DIR: auth, CONFIG_PATH: config,
        MAHOQUOT_QA_LOOPBACK_ONLY: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
        http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exitPromise = new Promise((done, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal }));
    });
    pipePromise = Promise.all([child.stdout, child.stderr].map((stream) => new Promise((done, reject) => {
      let log = "";
      stream.on("data", (chunk) => {
        log += chunk.toString();
        if (log.includes("listening") && log.includes(String(ports[0]))) readyResolve();
      });
      stream.once("end", done); stream.once("error", reject);
    })));
    await bounded(Promise.race([ready, exitPromise.then((value) => {
      throw new Error("early gateway exit " + JSON.stringify(value));
    })]), "gateway readiness");
    events.push({ type: "gateway-ready", pid: child.pid });
    const base = "http://127.0.0.1:" + ports[0];
    async function request(path, options = {}) {
      const authHeader = (path.startsWith("/v0/management") || path.startsWith("/admin"))
        ? "Bearer task7-management-secret"
        : "Bearer task7-fixture";
      const response = await bounded(fetch(base + path, { ...options, proxy: "", redirect: "error",
        headers: { authorization: authHeader, ...options.headers },
        signal: AbortSignal.timeout(10000) }), path);
      return { status: response.status, body: await bounded(response.text(), path + " body") };
    }
    async function inference() {
      const response = await request("/backend-api/codex/responses", { method: "POST",
        headers: { "content-type": "application/json", "x-client-request-id": "task7-request-" + sequence.length },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "settings fixture", stream: false }) });
      assert(response.status === 200 && response.body.includes("settings-wire-sentinel"), "inference was not served by mock");
      return sequence.at(-1);
    }
    const health = await request("/healthz");
    assert(health.status === 200, "health failed");
    const before = await request("/v0/management/config");
    const diskBefore = await readFile(config);
    const first = await inference();
    assert(await inference() === first, "fill-first default not preserved");
    if (variant === "happy") {
      const put = await request("/v0/management/config.yaml", { method: "PUT", body: yaml("round-robin") });
      events.push({ type: "yaml-publication", status: put.status, body: put.body });
      const next = await inference();
      const back = await request("/v0/management/config.yaml", { method: "PUT", body: yaml("fill-first") });
      const restored = await inference();
      record("yaml-setting-applied", true, put.status === 200 && next !== first && back.status === 200 && restored === first);
      assert(!(await readFile(config, "utf8")).includes("auth-dir:"), "runtime auth-dir overlay persisted");
    } else {
      const invalid = await request("/v0/management/config.yaml", { method: "PUT", body: yaml("invalid") });
      assert(invalid.status >= 400 && Buffer.compare(await readFile(config), diskBefore) === 0, "validation published or changed disk");
      await rename(config, config + ".saved");
      await mkdir(config);
      const refused = await request("/v0/management/config.yaml", { method: "PUT", body: yaml("round-robin") });
      const after = await request("/v0/management/config");
      const selected = await inference();
      record("failed-persist-not-published", true, refused.status === 500 && before.body === after.body && selected === first);
      events.push({ type: "failed-persist-observation", status: refused.status, before, after, selected });
    }
    assert(assertions.every((entry) => entry.pass), "settings assertions failed");
  } catch (error) { failure = error; }
  finally {
    try {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
        try { exit = await bounded(exitPromise, "gateway exit"); }
        catch (error) {
          child.kill("SIGKILL"); exit = await bounded(exitPromise, "forced exit"); throw error;
        }
        await bounded(pipePromise, "gateway pipes closed");
        events.push({ type: "kernel-exit-observation", pid: child.pid, ...exit, pipes_closed: true });
      }
    } catch (error) { failure ??= error; }
    try {
      await mock?.stop(true);
      const probes = await Promise.all(ports.map(releasedPort));
      events.push({ type: "port-release-observations", probes });
    } catch (error) { failure ??= error; }
    await rm(work, { recursive: true, force: true });
  }
  const required = variant === "happy" ? ["yaml-setting-applied"] : ["failed-persist-not-published"];
  if (!assertions.length) record(required[0], true, false);
  const receipt = context.createReceipt({ caseName: "settings", variant, assertions,
    requiredAssertionIds: required, events, wireRequests,
    provenance: { gateway_binary: context.binary, gateway_sha256: binaryHash,
      desktop_revision: await git(root, "rev-parse", "HEAD"), gateway_revision: revision,
      gateway_source_sha256: closure.sourceHash, source_root: gateway, source_manifest: { files: closure.files },
      build_command: context.buildCommand, build_receipt: { path: binding, sha256: hash(bindingBytes) },
      binary_source_revision: revision, dirty: Boolean(await git(gateway, "status", "--porcelain")) },
    teardown: { exit, termination: "controlled-signal", listeners: failure ? null : 0,
      ownedProcesses: failure ? null : 0, listener_inventory: [], process_inventory: [] },
  });
  delete receipt.wire_capture.external_dials;
  receipt.status = failure ? "FAIL" : "PASS";
  receipt.failure = failure ? String(failure) : null;
  await writeFile(evidencePath, JSON.stringify(receipt, null, 2), { flag: "wx" });
  assert(!failure, "settings case failed: " + failure);
  return receipt;
}

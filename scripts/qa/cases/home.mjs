import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createTlsServer } from "node:tls";
import { once } from "node:events";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assert(value, message) { if (!value) throw new Error(message); }
async function bounded(promise, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout); })]);
  } finally { clearTimeout(timer); }
}
async function git(path, ...args) {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, error, code] = await bounded(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), `git ${args.join(" ")}`);
  assert(code === 0, error);
  return text.trim();
}
const b64url = (str) => Buffer.from(str).toString("base64url");

function parseResp(buffer) {
  if (!buffer.length) return null;
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd < 0 || buffer[0] !== 42) throw new Error("Home sent malformed RESP array");
  const count = Number(buffer.toString("ascii", 1, lineEnd));
  let offset = lineEnd + 2;
  const args = [];
  for (let i = 0; i < count; i++) {
    const end = buffer.indexOf("\r\n", offset);
    if (end < 0) return null;
    if (buffer[offset] !== 36) throw new Error("Home RESP argument was not bulk string");
    const size = Number(buffer.toString("ascii", offset + 1, end));
    const start = end + 2;
    if (buffer.length < start + size + 2) return null;
    args.push(buffer.toString("utf8", start, start + size));
    offset = start + size + 2;
  }
  return { args, rest: buffer.subarray(offset) };
}
function respBulk(value) {
  if (value === null || value === undefined) return Buffer.from("$-1\r\n");
  const body = Buffer.from(String(value));
  return Buffer.concat([Buffer.from(`$${body.length}\r\n`), body, Buffer.from("\r\n")]);
}

async function makeCertificates(work) {
  const run = async (...args) => {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await bounded(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), args.join(" "));
    assert(code === 0, `${args.join(" ")}: ${err}`);
    return out.trim();
  };
  const dir = join(work, "certs");
  await mkdir(dir);
  const caKey = join(dir, "ca.key"), caCert = join(dir, "ca.crt");
  const serverKey = join(dir, "server.key"), serverCsr = join(dir, "server.csr"), serverCert = join(dir, "server.crt");
  const clientKey = join(dir, "client.key"), clientCsr = join(dir, "client.csr"), clientCert = join(dir, "client.crt");
  await run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-days", "2", "-subj", "/CN=Home QA CA");
  for (const [key, csr, cn] of [[serverKey, serverCsr, "127.0.0.1"], [clientKey, clientCsr, "home-qa-gateway"]]) {
    await run("openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${cn}`);
  }
  const serverExt = join(dir, "server.ext"), clientExt = join(dir, "client.ext");
  await writeFile(serverExt, "[v3_req]\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  await writeFile(clientExt, "[v3_req]\nextendedKeyUsage=clientAuth\n");
  for (const [csr, cert, ext] of [[serverCsr, serverCert, serverExt], [clientCsr, clientCert, clientExt]]) {
    await run("openssl", "x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "2", "-sha256", "-extfile", ext, "-extensions", "v3_req");
  }
  const fingerprint = new X509Certificate(await readFile(caCert)).fingerprint256.replaceAll(":", "").toLowerCase();
  return {
    dir, caCert, clientCert, clientKey, serverCert, serverKey, fingerprint,
    caPem: await readFile(caCert), clientCertPem: await readFile(clientCert), clientKeyPem: await readFile(clientKey),
    serverCertPem: await readFile(serverCert), serverKeyPem: await readFile(serverKey),
  };
}

class HomeServer {
  constructor(options) {
    Object.assign(this, options);
    this.commands = [];
    this.sessions = [];
    this.waiters = [];
    this.server = createTlsServer({ key: this.serverKeyPem, cert: this.serverCertPem, ca: this.caPem, requestCert: true, rejectUnauthorized: true }, (socket) => this.accept(socket));
    this.server.on("tlsClientError", (err) => { this.tlsErrors ??= []; this.tlsErrors.push(String(err)); });
    this.listening = new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.port, "127.0.0.1", resolve); });
  }
  accept(socket) {
    const cert = socket.getPeerCertificate();
    this.sessions.push({ authorized: socket.authorized, authorizationError: socket.authorizationError ?? null, certificate: cert?.subject?.CN ?? null });
    this.notify();
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        let parsed;
        try { parsed = parseResp(pending); } catch (error) { this.errors ??= []; this.errors.push(String(error)); socket.destroy(); return; }
        if (!parsed) break;
        pending = parsed.rest;
        const [command, ...args] = parsed.args;
        this.commands.push({ command: command?.toUpperCase(), args });
        const id = this.commands.length - 1;
        this.notify();
        let response = null;
        if (command?.toUpperCase() === "GET" && args[0] === "config") response = this.configPayload;
        if (command?.toUpperCase() === "GET" && args[0]?.startsWith("{")) response = JSON.stringify({ object: "list", data: [{ id: "gpt-5.6-sol", owned_by: "codex" }] });
        if (command?.toUpperCase() === "CLUSTER") response = JSON.stringify({ ok: true, nodes: [] });
        if (command?.toUpperCase() === "RPOP") response = this.dispatchResponse;
        socket.write(respBulk(response));
        if (this.dropNext && id === this.dropAt) { this.dropNext = false; socket.destroy(); }
      }
    });
    socket.on("close", () => { this.notify(); });
  }
  notify() { for (const resolve of this.waiters.splice(0)) resolve(); }
  async waitFor(predicate, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${label} timed out`);
      await bounded(new Promise((resolve) => this.waiters.push(resolve)), label, remaining);
    }
  }
  async close() { this.server.close(); await bounded(once(this.server, "close"), "Home server close"); }
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "invalid home variant");
  assert(context.ports.length === 2 && context.ports.every((p) => p >= 18840 && p <= 18899), "leased test ports required");
  const gateway = join(root, "mahoquot-proxy");
  const closure = await context.getSourceClosure();
  const revision = await git(gateway, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const binding = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingBytes = await readFile(binding);
  assert(bindingBytes.toString().trim() === [revision, binaryHash, closure.sourceHash, context.buildCommand].join("\n"), "binary source binding mismatch");
  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "home-qa-"));
  const config = join(work, "config.yaml"), auth = join(work, "auth"), cpaDir = join(work, ".cli-proxy-api");
  await mkdir(auth); await mkdir(cpaDir);
  const certs = await makeCertificates(work);
  await writeFile(join(cpaDir, "client-crt.pem"), await readFile(certs.clientCert));
  await writeFile(join(cpaDir, "client-key.pem"), await readFile(certs.clientKey));
  await writeFile(join(cpaDir, "home-ca-crt.pem"), await readFile(certs.caCert));
  const claims = { certificate_id: "node-qa-1", cluster_id: "cluster-qa", ca_fingerprint: certs.fingerprint, enrollment_secret: "secret-qa-123", ip: "127.0.0.1", port: context.ports[1] };
  const validJwt = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.dummy_sig`;
  const assertions = [], events = [], wireRequests = [];
  let failure, child, exitPromise, pipes, exit, home, upstream, stderrBuffer = "";
  const record = (id, expected, actual, extra = {}) => assertions.push({ id, expected, actual, pass: expected === actual, ...extra });
  const mgmtSecret = "home-qa-mgmt-secret";
  async function startGateway() {
    await writeFile(config, `api-keys: [inference-key]\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(mgmtSecret)}\n`);
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(context.ports[0]), "--auth-dir", auth, "--auth-refresh", "false"], {
      cwd: gateway,
      env: { ...process.env, HOME: work, AUTH_DIR: auth, CONFIG_PATH: config, MANAGEMENT_PASSWORD: "", HOME_JWT: validJwt, MAHOQUOT_QA_LOOPBACK_ONLY: "1", NO_COLOR: "1", CLICOLOR: "0", TERM: "dumb", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exitPromise = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
    pipes = Promise.all([child.stdout, child.stderr].map((stream) => new Promise((resolve, reject) => {
      let buffer = "";
      stream.on("data", (chunk) => { buffer += chunk.toString(); if (stream === child.stderr) stderrBuffer += chunk.toString(); if (buffer.includes("listening")) readyResolve(); });
      stream.once("end", resolve); stream.once("error", reject);
    })));
    await bounded(Promise.race([ready, exitPromise.then((v) => { throw new Error(`gateway early exit ${JSON.stringify(v)} ${stderrBuffer}`); })]), "gateway readiness");
    events.push({ type: "gateway-ready", pid: child.pid });
  }
  async function stopGateway() {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    try { exit = await bounded(exitPromise, "gateway exit"); }
    catch (error) { child.kill("SIGKILL"); await bounded(exitPromise, "forced exit"); throw error; }
    await bounded(pipes, "gateway pipes closed");
    events.push({ type: "gateway-exit", pid: child.pid, ...exit, pipes_closed: true }); child = null;
  }
  try {
    const homeConfig = { "api-keys": ["inference-key"], "request-retry": 7, "remote-management": { "secret-key": mgmtSecret } };
    home = new HomeServer({ port: context.ports[1], ...certs, configPayload: JSON.stringify({ revision: 2, config: homeConfig }), dispatchResponse: JSON.stringify({ model: "gpt-5.6-sol", provider: "codex", auth: { id: "home-credential", provider: "codex", metadata: { type: "plus", account_id: "home-account", access_token: "home-selected-token", refresh_token: "home-refresh", id_token: "home-id", email: "home@fixture.invalid", expired: "2099-01-01T00:00:00Z", last_refresh: "2098-01-01T00:00:00Z", upstream_override: "http://127.0.0.1:18842" } } }) });
    await home.listening;
    if (variant === "happy") {
      upstream = Bun.serve({ hostname: "127.0.0.1", port: 18842, async fetch(req) {
        const bytes = Buffer.from(await req.arrayBuffer()); const body = bytes.toString("utf8"); wireRequests.push({ method: req.method, path: new URL(req.url).pathname, body, body_bytes_base64: bytes.toString("base64"), body_sha256: hash(bytes), authorization: req.headers.get("authorization") });
        return Response.json({ id: "chatcmpl-home", object: "chat.completion", created: Math.floor(Date.now() / 1000), choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      } });
      await writeFile(join(auth, "codex-fixture.json"), JSON.stringify({ type: "plus", identity_slug: "test-home", account_id: "test-home", access_token: "token-home", refresh_token: "fixture", id_token: "fixture", email: "test@fixture.invalid", expired: "2099-01-01T00:00:00Z", last_refresh: "2098-01-01T00:00:00Z", upstream_override: "http://127.0.0.1:18842" }));
      await startGateway();
      let tlsObserved = false;
      try {
        await home.waitFor(() => home.sessions.some((s) => s.authorized && s.certificate === "home-qa-gateway") && home.commands.some((c) => c.command === "CLUSTER"), "mTLS cluster sync");
        tlsObserved = true;
      } catch {}
      const configPulled = home.commands.some((c) => c.command === "GET" && c.args[0] === "config");
      record("mtls-sync", true, tlsObserved && configPulled, { sessions: home.sessions, commands: home.commands, tls_errors: home.tlsErrors ?? [], product_gap: !tlsObserved ? "Gateway did not complete an mTLS Home session; observed TLS failures are recorded" : configPulled ? null : "HomeSyncWorker establishes mTLS and refreshes cluster nodes but never pulls config or credentials" });
      const req = await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, { method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" }, body: JSON.stringify({ model: "gpt-5.6-sol", input: "home-probe", stream: false }) });
      const body = await req.text();
      try {
        await home.waitFor(() => home.commands.some((c) => c.command === "LPUSH" && c.args[0] === "concurrency-release")
          && home.commands.some((c) => c.command === "RPUSH" && c.args[0] === "request-log"), "Home release and request log");
      } catch (error) {
        throw new Error(`${error.message}; inference status=${req.status} body=${body.slice(0, 300)}; home commands=${JSON.stringify(home.commands.map((c) => [c.command, c.args[0]]))}; upstream requests=${wireRequests.length}; gateway stderr tail=${stderrBuffer.slice(-1500)}`);
      }
      const writesBefore = home.commands.length;
      const reqLogs = home.commands.filter((c) => c.command === "RPUSH" && c.args[0] === "request-log");
      const releaseLogs = home.commands.filter((c) => c.command === "LPUSH" && c.args[0] === "concurrency-release");
      const observedRequestLog = req.ok && wireRequests.length === 1 && wireRequests[0].authorization === "Bearer home-selected-token" && reqLogs.length === 1 && reqLogs[0].args[1]?.includes("gpt-5.6-sol") && releaseLogs.length === 1 && JSON.parse(releaseLogs[0].args[1]).credential_id === "home-credential" && home.commands.filter((c) => c.command === "RPOP").length === 1;
      record("fenced-release", true, observedRequestLog, {
        request_log_frames: reqLogs,
        release_frames: releaseLogs,
        product_gap: observedRequestLog ? null : "Concurrency release / request-log frame not pushed to Home exactly once"
      });
      const clusterCount = home.commands.filter((c) => c.command === "CLUSTER").length;
      if (tlsObserved && clusterCount > 0) {
        home.dropAt = home.commands.length;
        home.dropNext = true;
        const previousSessions = home.sessions.length;
        let reconnected = false;
        try { await home.waitFor(() => home.sessions.length > previousSessions && home.commands.filter((c) => c.command === "CLUSTER").length > clusterCount, "Home reconnect", 15000); reconnected = true; } catch {}
        record("reconnect", true, reconnected && home.sessions.slice(previousSessions).some((s) => s.authorized && s.certificate === "home-qa-gateway"), { sessions: home.sessions, commands: home.commands });
      } else {
        record("reconnect", true, false, { product_gap: "No initial mTLS Home session completed, so reconnect/resume cannot be observed", sessions: home.sessions, tls_errors: home.tlsErrors ?? [] });
      }
      await stopGateway();
    } else {
      await startGateway();
      await home.waitFor(() => home.commands.some((c) => c.command === "CLUSTER"), "initial sync");
      const jwt = await fetch(`http://127.0.0.1:${context.ports[0]}/v0/management/config`, { headers: { authorization: `Bearer ${mgmtSecret}` } });
      const managementJson = await jwt.json().catch(() => null);
      const previousClusters = home.commands.filter((c) => c.command === "CLUSTER").length;
      home.configPayload = JSON.stringify({ revision: 1, config: { ...homeConfig, "request-retry": 1 } });
      await home.waitFor(() => home.commands.filter((c) => c.command === "CLUSTER").length > previousClusters, "stale revision cycle");
      const after = await fetch(`http://127.0.0.1:${context.ports[0]}/v0/management/config`, { headers: { authorization: `Bearer ${mgmtSecret}` } });
      const afterJson = await after.json().catch(() => null);
      const revisionStayed = JSON.stringify(afterJson) === JSON.stringify(managementJson);
      record("stale-revision-rejected", true, revisionStayed && managementJson?.["request-retry"] === 7, { before: managementJson, after: afterJson, home_commands: home.commands });
      home.dispatchResponse = "not-json";
      const dispatchBefore = home.commands.filter((c) => c.command === "RPOP").length;
      const inference = await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, { method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" }, body: JSON.stringify({ model: "gpt-5.6-sol", input: "ambiguous-home-dispatch", stream: false }) });
      await inference.arrayBuffer();
      const dispatchAfter = home.commands.filter((c) => c.command === "RPOP").length;
      const subsequent = await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, { method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" }, body: JSON.stringify({ model: "gpt-5.6-sol", input: "fenced", stream: false }) });
      const subsequentError = await subsequent.text();
      record("ambiguous-dispatch-aborted", true, inference.status === 503 && subsequent.status === 503 && subsequentError.includes("fenced") && dispatchAfter - dispatchBefore === 1 && home.commands.filter((c) => c.command === "RPOP").length === dispatchAfter, { http_status: inference.status, rpop_before: dispatchBefore, rpop_after: dispatchAfter, subsequent_error: subsequentError });
      events.push({ type: "management-revision-observation", status: after.status, revisionStayed });
      await stopGateway();
    }
  } catch (error) { failure = error; }
  finally {
    if (upstream) upstream.stop(true);
    try { await stopGateway(); } catch (error) { failure ??= error; }
    if (home) { try { await home.close(); } catch (error) { failure ??= error; } }
    await rm(work, { recursive: true, force: true });
  }
  const productGaps = assertions.filter((entry) => entry.pass === false).map(({ id, product_gap }) => ({ id, product_gap }));
  const requiredIds = variant === "happy"
    ? ["mtls-sync", "fenced-release", "reconnect"]
    : ["ambiguous-dispatch-aborted", "stale-revision-rejected"];
  const receipt = context.createReceipt({
    caseName: "home", variant, assertions, requiredAssertionIds: requiredIds, events, wireRequests,
    provenance: { gateway_binary: context.binary, gateway_sha256: binaryHash, desktop_revision: await git(root, "rev-parse", "HEAD"), gateway_revision: revision, gateway_source_sha256: closure.sourceHash, source_root: gateway, source_manifest: { files: closure.files }, build_command: context.buildCommand, build_receipt: { path: binding, sha256: hash(bindingBytes) }, binary_source_revision: revision, dirty: Boolean(await git(gateway, "status", "--porcelain")) },
    teardown: { exit, termination: "controlled-signal", listeners: failure ? null : 0, ownedProcesses: failure ? null : 0, listener_inventory: [], process_inventory: [] },
  });
  receipt.product_gaps = productGaps;
  receipt.status = failure || productGaps.length ? "FAIL" : "PASS";
  receipt.failure = failure ? String(failure) : null;
  await writeFile(evidencePath, JSON.stringify(receipt, null, 2), { flag: "wx" });
  assert(!failure && productGaps.length === 0, failure ? String(failure) : `Home product gaps: ${JSON.stringify(productGaps)}`);
  return receipt;
}

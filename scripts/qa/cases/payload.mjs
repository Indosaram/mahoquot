import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditInternals } from "../cliproxy-audit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gateway = join(root, "mahoquot-proxy");
const hash = (value) => createHash("sha256").update(value).digest("hex");
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, label, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error(`${label} timed out`)); }, 10000);
    })]);
  } finally { clearTimeout(timer); }
}
async function git(path, ...args) {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const result = await bounded(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), "git", () => child.kill());
  assert.equal(result[2], 0, result[1]);
  return result[0].trim();
}
export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant));
  const ports = context.ports;
  assert(ports.length === 2 && ports[0] !== ports[1] && ports.every((port) => port >= 18840 && port <= 18899));
  const closure = await context.getSourceClosure();
  const revision = await git(gateway, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const binding = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingBytes = await readFile(binding);
  assert.deepEqual(bindingBytes.toString().trim().split("\n"), [revision, binaryHash, closure.sourceHash, context.buildCommand]);
  const provenance = { gateway_binary: context.binary, gateway_sha256: binaryHash,
    gateway_revision: revision, desktop_revision: await git(root, "rev-parse", "HEAD"),
    gateway_source_sha256: closure.sourceHash, source_root: gateway, source_manifest: { files: closure.files },
    build_command: context.buildCommand, build_receipt: { path: binding, sha256: hash(bindingBytes) },
    binary_source_revision: revision, dirty: (await git(gateway, "status", "--porcelain")).length > 0 };
  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "payload-"));
  const events = [], requests = [], assertions = [], extras = [];
  const proof = (list, id, expected, actual) => {
    const pass = JSON.stringify(expected) === JSON.stringify(actual);
    list.push({ id, expected, actual, pass });
    assert(pass, `${id}: ${JSON.stringify(actual)}`);
  };
  let mock, child, exitPromise, outputPromise, exit, failure;
  const ready = deferred();
  try {
    mock = Bun.serve({ hostname: "127.0.0.1", port: ports[1], async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers),
        body_bytes_base64: Buffer.from(body).toString("base64"), body_sha256: hash(body) });
      if (url.pathname === "/backend-api/codex/responses") {
        const value = JSON.parse(body);
        if (value.phase === "twice") return Response.json({error: {message: "duplicate finalization"}}, {status: 400});
        if (value.input?.some((item) => item.content?.some?.((part) => part.text === "retry")) && !events.some((e) => e.type === "retry-failed")) {
          events.push({type: "retry-failed"});
          return Response.json({error: {message: "transient"}}, {status: 503});
        }
        return new Response('data: {"type":"response.output_text.delta","delta":"payload sentinel"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n\n', {headers: {"content-type":"text/event-stream"}});
      }
      return Response.json({});
    } });
    const auth = join(work, "auth");
    await mkdir(auth);
    for (const type of ["codex"]) {
      await writeFile(join(auth, `${type}.json`), JSON.stringify({ type, identity_slug: `payload-${type}`, email: `${type}@example.test`,
        access_token: "fixture-token", refresh_token: "fixture-refresh", account_id: "fixture", id_token: "fixture-id",
        last_refresh: "2026-01-01T00:00:00Z",
        project_id: "fixture-project", expired: "2099-01-01T00:00:00Z", upstream_override: `http://127.0.0.1:${ports[1]}` }));
    }
    await writeFile(join(auth, "config.yaml"), `routing:
  strategy: fill-first
request-retry: 1
remote-management:
  secret-key: payload-test-secret
model-catalog:
  refresh-enabled: false
payload:
  override:
    - models: [{name: "*", match: [{phase: configured}]}]
      params: {phase: twice}
    - models: [{name: "*", not-exist: [phase]}]
      params: {phase: configured, temperature: 0.7}
  filter:
    - models: [{name: "*"}]
      params: [service_tier]
`);
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(ports[0]), "--auth-dir", auth,
      "--config", join(auth, "config.yaml"), "--auth-refresh", "false", "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: gateway, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AUTH_DIR: auth, API_KEYS: "", MAHOQUOT_CACHE_DIR: join(work, "cache"),
        MAHOQUOT_QA_LOOPBACK_ONLY: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    });
    exitPromise = new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal })); });
    const lines = async (source, type) => {
      let buffer = "";
      for await (const chunk of source) {
        buffer += chunk.toString();
        const parts = buffer.split("\n"); buffer = parts.pop();
        for (const line of parts) { events.push({ type, line }); if (line.includes("listening") && line.includes(String(ports[0]))) ready.resolve(); }
      }
      if (buffer) events.push({ type, line: buffer });
    };
    outputPromise = Promise.all([lines(child.stdout, "stdout"), lines(child.stderr, "stderr")]);
    await bounded(Promise.race([ready.promise, exitPromise.then((result) => { throw new Error(`gateway exited before readiness: ${JSON.stringify(result)}`); })]), "readiness");
    const fetchText = async (path, init) => {
      const controller = new AbortController();
      const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      return bounded((async () => { const response = await fetch(`http://127.0.0.1:${ports[0]}${path}`, { ...init, signal }); return { status: response.status, text: await response.text() }; })(), "HTTP response", () => controller.abort());
    };
    const catalog = JSON.parse((await fetchText("/v1/models")).text);
    const codex = catalog.data.find((model) => ["openai", "codex"].includes(model.owned_by))?.id;
    assert(codex, "fixture catalog must expose Codex");
    const post = (text, stream) => fetchText("/v1/chat/completions", {method: "POST", headers: {"content-type":"application/json", "x-session-id":"payload-private"}, body: JSON.stringify({model: codex, messages: [{role:"user", content:text}], service_tier:"priority", stream})});
    if (variant === "happy") {
      for (const stream of [false, true]) {
        const response = await post("payload", stream);
        assert.equal(response.status, 200, response.text);
        assert(response.text.includes("payload sentinel"));
      }
      const retried = await post("retry", true);
      assert.equal(retried.status, 200, retried.text);
      assert(retried.text.includes("payload sentinel"));
      const wire = requests.filter((r) => r.path === "/backend-api/codex/responses").map((r) => JSON.parse(Buffer.from(r.body_bytes_base64, "base64")));
      proof(assertions, "payload-rule-applied-once", true, wire.length === 4 && wire.every((v) => v.phase === "configured" && v.temperature === 0.7 && !("service_tier" in v)));
      proof(extras, "private-routing-header", true, requests.every((r) => !r.headers["x-session-id"]));
    } else {
      const before = await fetchText("/v0/management/config.yaml", {headers: {"X-Management-Key":"payload-test-secret"}});
      assert.equal(before.status, 200);
      const invalid = await fetchText("/v0/management/config.yaml", {method:"PUT", headers:{"X-Management-Key":"payload-test-secret"}, body: 'payload:\n  override-raw:\n    - models: [{name: "*"}]\n      params: {temperature: "not-json"}\n'});
      const after = await fetchText("/v0/management/config.yaml", {headers:{"X-Management-Key":"payload-test-secret"}});
      proof(assertions, "invalid-rule-rejected", true, invalid.status === 400 && after.text === before.text);
      const response = await post("payload", true);
      assert.equal(response.status, 200, response.text);
      const wire = JSON.parse(Buffer.from(requests.find((r) => r.path === "/backend-api/codex/responses").body_bytes_base64, "base64"));
      proof(extras, "prior-rule-remains-active", "configured", wire.phase);
    }
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [];
    if (child) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
        exit = await bounded(exitPromise, "gateway exit", () => child.kill("SIGKILL"));
        await bounded(outputPromise, "gateway pipes EOF");
        assert(exit.code === 0 || exit.signal === "SIGINT", `unexpected exit ${JSON.stringify(exit)}`);
      } catch (error) { cleanupErrors.push(error); }
    }
    try { mock?.stop(true); } catch (error) { cleanupErrors.push(error); }
    for (const port of ports) {
      try { const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); probe.stop(true); events.push({ type: "port-released", port }); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await rm(work, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Payload case cleanup failed");
  }
  if (failure) {
    await writeFile(`${evidencePath}.diagnostic.json`, JSON.stringify({ error: String(failure), events, requests, assertions, extras }, null, 2));
    throw failure;
  }
  assert.equal((await context.getSourceClosure()).sourceHash, closure.sourceHash);
  const ids = variant === "happy" ? ["payload-rule-applied-once"] : ["invalid-rule-rejected"];
  const receipt = context.createReceipt({ caseName: "payload", variant, assertions, requiredAssertionIds: ids, events, wireRequests: requests, provenance,
    teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" } });
  delete receipt.wire_capture.external_dials;
  receipt.extra_assertions = extras;
  await auditInternals.validateReceipt(receipt, "payload", variant, `responses/${variant}`);
  await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}


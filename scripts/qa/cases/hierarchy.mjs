import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise, label, cancel = () => {}) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => { cancel(); reject(new Error(`${label} timed out`)); }, 10000);
  })]); } finally { clearTimeout(timer); }
}
async function git(path, ...args) {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const result = await bounded(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), "git", () => child.kill());
  assert.equal(result[2], 0, result[1]); return result[0].trim();
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant));
  const ports = context.ports;
  assert(ports.length === 2 && ports[0] !== ports[1] && ports.every((p) => p >= 18840 && p <= 18899));
  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "hierarchy-"));
  const gateway = join(root, "mahoquot-proxy");
  const closure = await context.getSourceClosure();
  const revision = await git(gateway, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const buildPath = join(dirname(dirname(context.binary)), "source-revision.txt");
  const buildBytes = await readFile(buildPath);
  assert.deepEqual(buildBytes.toString().trim().split("\n"), [revision, binaryHash, closure.sourceHash, context.buildCommand]);
  const provenance = { gateway_binary: context.binary, gateway_sha256: binaryHash,
    gateway_revision: revision, desktop_revision: await git(root, "rev-parse", "HEAD"),
    gateway_source_sha256: closure.sourceHash, source_root: gateway, source_manifest: { files: closure.files },
    build_command: context.buildCommand, build_receipt: { path: buildPath, sha256: hash(buildBytes) },
    binary_source_revision: revision, dirty: (await git(gateway, "status", "--porcelain")).length > 0 };
  const events = [], requests = [], assertions = [], extras = [], pending = new Map();
  let mock, child, exited, pipes, exit, failure;
  const proof = (id, pass) => { assertions.push({ id, expected: true, actual: pass, pass }); assert(pass, id); };
  const extraProof = (id, pass) => { extras.push({ id, expected: true, actual: pass, pass }); assert(pass, id); };
  const authDir = join(work, "auth");
  const config = (ttl = "1h") => `routing:\n  strategy: fill-first\n  session-affinity: true\n  session-affinity-lcp: true\n  session-affinity-ttl: ${ttl}\nremote-management:\n  secret-key: hierarchy-secret\napi-keys: [caller-one, caller-two]\nmodel-catalog:\n  refresh-enabled: false\nopenai-compatibility:\n  - name: hierarchy-fixture\n    support-prompt-cache-key: true\n`;
  try {
    await mkdir(authDir);
    mock = Bun.serve({ hostname: "127.0.0.1", port: ports[1], async fetch(request) {
      const body = await request.text();
      const value = JSON.parse(body);
      const capture = { method: request.method, path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers),
        body_bytes_base64: Buffer.from(body).toString("base64"), body_sha256: hash(body), value };
      requests.push(capture);
      const label = value.messages?.at(-1)?.content;
      pending.get(label)?.resolve(capture);
      return Response.json({ id: "hierarchy", object: "chat.completion", model: value.model,
        choices: [{ index: 0, message: { role: "assistant", content: "hierarchy-sentinel" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } });
    for (const id of ["a", "b"]) await writeFile(join(authDir, `${id}.json`), JSON.stringify({ type: "generic",
      identity_slug: id, provider: "hierarchy-fixture", adapter: "openai-chat", api_key: `token-${id}`,
      models: ["hierarchy-model"], base_url: `http://127.0.0.1:${ports[1]}/v1`, upstream_override: `http://127.0.0.1:${ports[1]}` }));
    await writeFile(join(authDir, "config.yaml"), config());
    const ready = deferred();
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(ports[0]), "--auth-dir", authDir,
      "--config", join(authDir, "config.yaml"), "--auth-refresh", "false", "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: gateway, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AUTH_DIR: authDir, API_KEYS: "caller-one,caller-two",
        MAHOQUOT_CACHE_DIR: join(work, "cache"), MAHOQUOT_QA_LOOPBACK_ONLY: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
        http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
    exited = new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal })); });
    const lines = async (stream, type) => {
      let buffer = "";
      for await (const chunk of stream) { buffer += chunk.toString(); const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) { events.push({ type, line }); if (line.includes("listening") && line.includes(String(ports[0]))) ready.resolve(); } }
    };
    pipes = Promise.all([lines(child.stdout, "stdout"), lines(child.stderr, "stderr")]);
    await bounded(Promise.race([ready.promise, exited.then((result) => { throw new Error(`early exit ${JSON.stringify(result)}`); })]), "ready");
    const http = async (path, init) => {
      const controller = new AbortController();
      return bounded((async () => { const response = await fetch(`http://127.0.0.1:${ports[0]}${path}`, {
        ...init, signal: controller.signal, redirect: "error", proxy: "" }); return { status: response.status, text: await response.text() }; })(), "HTTP", () => controller.abort());
    };
    const management = { "X-Management-Key": "hierarchy-secret", "content-type": "application/json" };
    const toggle = async (id, enabled) => {
      const response = await http("/v0/management/auth-files/bulk", { method: "POST", headers: management,
        body: JSON.stringify({ action: enabled ? "enable" : "disable", names: [`${id}.json`] }) });
      assert.equal(response.status, 200, response.text);
    };
    const catalog = await http("/v1/models", { headers: { authorization: "Bearer caller-one" } });
    assert.equal(catalog.status, 200);
    const model = JSON.parse(catalog.text).data.find((entry) => entry.id.endsWith("hierarchy-model"))?.id;
    assert(model);
    const call = async (messages, label, caller = "caller-one", extraHeaders = {}, extraBody = {}) => {
      const signal = deferred(); pending.set(label, signal);
      events.push({ type: "wire-subscribed", label });
      try {
        const response = http("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${caller}`,
          "content-type": "application/json", ...extraHeaders }, body: JSON.stringify({ model, messages: [...messages, { role: "user", content: label }], ...extraBody }) });
        const [wire, result] = await bounded(Promise.all([signal.promise, response]), "wire-response");
        assert.equal(result.status, 200, result.text); assert(result.text.includes("hierarchy-sentinel")); return wire;
      } finally { pending.delete(label); }
    };
    const base = [{ role: "system", content: "stable environment" }];
    await toggle("a", false);
    const first = await call(base, "first");
    await toggle("a", true);
    const growth = [...base, { role: "user", content: "first" }, { role: "assistant", content: "answer" }];
    if (variant === "happy") {
      const grown = await call(growth, "grown");
      proof("prefix-growth-locality", first.headers.authorization === grown.headers.authorization && first.value.prompt_cache_key === grown.value.prompt_cache_key);
      const left = await call(growth, "left");
      const right = await call(growth, "right");
      extraProof("sibling-cache-keys-distinct", left.value.prompt_cache_key !== right.value.prompt_cache_key
        && left.headers.authorization === grown.headers.authorization && right.headers.authorization === grown.headers.authorization);
      const explicit = await call(growth, "explicit", "caller-one", { "x-session-id": "explicit-child", "x-client-request-id": "private" }, { prompt_cache_key: "explicit-key" });
      proof("explicit-session-precedence", explicit.headers.authorization === "Bearer token-a" && explicit.value.prompt_cache_key === "explicit-key");
      const parent = await call(base, "parent", "caller-one", { "x-session-id": "parent" });
      const childWire = await call(base, "child", "caller-one", { "x-session-id": "child", "x-parent-session-id": "parent" });
      extraProof("eligible-parent-locality", parent.headers.authorization === childWire.headers.authorization);
    } else {
      const other = await call(growth, "other", "caller-two");
      proof("cross-tenant-isolation", other.headers.authorization === "Bearer token-a" && other.value.prompt_cache_key !== first.value.prompt_cache_key);
      const reload = await http("/v0/management/config.yaml", { method: "PUT", headers: management, body: config("1ns") });
      assert.equal(reload.status, 200, reload.text);
      await toggle("a", false);
      await call(base, "expiry");
      await toggle("a", true);
      const expired = await call([...base, { role: "user", content: "expiry" }], "expiry-next");
      proof("expired-binding-evicted", expired.headers.authorization === "Bearer token-a");
    }
    extraProof("routing-header-not-forwarded", requests.every((wire) => !["x-session-id", "x-client-request-id", "x-parent-session-id"].some((key) => key in wire.headers)));
  } catch (error) { failure = error; }
  finally {
    const errors = [];
    if (child) try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
      exit = await bounded(exited, "exit", () => child.kill("SIGKILL"));
      await bounded(pipes, "pipes");
      assert(exit.code === 0 || exit.signal === "SIGINT");
    } catch (error) { errors.push(error); }
    try { mock?.stop(true); } catch (error) { errors.push(error); }
    for (const port of ports) try { const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); probe.stop(true); }
    catch (error) { errors.push(error); }
    try { await rm(work, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], "hierarchy cleanup");
  }
  if (failure) { await writeFile(`${evidencePath}.diagnostic.json`, JSON.stringify({ error: String(failure), events, requests, assertions }, null, 2)); throw failure; }
  const required = variant === "happy" ? ["prefix-growth-locality", "explicit-session-precedence"] : ["cross-tenant-isolation", "expired-binding-evicted"];
  const receipt = context.createReceipt({ caseName: "hierarchy", variant, assertions, requiredAssertionIds: required, events,
    wireRequests: requests, provenance, teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" } });
  delete receipt.wire_capture.external_dials;
  receipt.extra_assertions = extras;
  await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

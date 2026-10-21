import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000); })]);
  } finally { clearTimeout(timer); }
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixture = await mkdtemp(join(root, ".omo/meta-qa-"));
  const auth = join(fixture, "auth");
  const cache = join(fixture, "cache");
  await mkdir(auth);
  await mkdir(cache);
  const [gatewayPort, mockPort] = context.ports;
  assert(gatewayPort >= 18840 && gatewayPort <= 18899 && mockPort >= 18840 && mockPort <= 18899);
  const base = `http://127.0.0.1:${mockPort}`;
  const events = [];
  const wireRequests = [];
  const assertions = [];
  let model = "fixture-muse-one";
  let generation = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: mockPort, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.text();
    const headers = Object.fromEntries(request.headers);
    wireRequests.push({ method: request.method, path, url: request.url, headers, body,
      body_bytes_base64: Buffer.from(body).toString("base64"), body_sha256: createHash("sha256").update(body).digest("hex") });
    if (path === "/device") {
      assert.equal(new URLSearchParams(body).get("client_id"), "1031625952748946");
      return Response.json({ device_code: "fixture-device", user_code: "CODE", verification_uri: `${base}/approve`, interval: 1, expires_in: 900 });
    }
    if (path.startsWith("/token")) {
      assert.equal(new URLSearchParams(body).get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
      if (path === "/token-denied") return Response.json({ error: "access_denied" }, { status: 400 });
      if (path === "/token-expired") return Response.json({ error: "expired_token" }, { status: 400 });
      return Response.json({ access_token: "dca:fixture", token_type: "Bearer", expires_in: 1 });
    }
    if (path === "/mint") {
      assert.equal(headers.authorization, "Bearer dca:fixture");
      assert.equal(JSON.parse(body).dca_token, "dca:fixture");
      generation += 1;
      if (generation > 1) model = "fixture-muse-two";
      return Response.json({ api_key: `fixture-key-${generation}`, base_url: `${base}/v1`, user_email: "fixture@example.invalid", subs_tier_name: "Pro", is_subs_active: true });
    }
    if (path === "/v1/models") return Response.json({ data: [{ id: model }] });
    if (path === "/v1/responses") {
      assert.equal(headers["x-client-id"], "tbh:tui");
      assert.equal(headers["x-session-id"], undefined);
      assert.equal(headers["x-client-request-id"], undefined);
      const parsed = JSON.parse(body);
      assert.equal(parsed.stream, true);
      assert.equal(parsed.input[0].encrypted_content, "muse-opaque");
      if (variant === "failure" && headers.authorization === "Bearer fixture-key-1") return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
      const item = { type: "reasoning", id: "reasoning-fixture", encrypted_content: "muse-opaque" };
      return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp-meta", object: "response", model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("unhandled fixture path", { status: 404 });
  }});
  let child;
  let closed;
  const ready = deferred();
  try {
    const config = join(fixture, "config.yaml");
    await writeFile(config, `auth-dir: ${auth}\napi-keys:\n  - fixture-client\nremote-management:\n  secret-key: fixture-management\nrouting:\n  strategy: fill-first\nmodel-catalog:\n  refresh-enabled: false\n`);
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(gatewayPort), "--auth-dir", auth, "--config", config, "--auth-refresh", "true", "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: join(root, "mahoquot-proxy"), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MAHOQUOT_CACHE_DIR: cache, MAHOQUOT_QA_LOOPBACK_ONLY: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" },
    });
    closed = new Promise((resolveExit, rejectExit) => { child.once("error", rejectExit); child.once("close", (code, signal) => resolveExit({ code, signal })); });
    closed.catch(() => {});
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.on("data", (chunk) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) { events.push({ type: "log", line }); if (line.includes("listening") && line.includes(String(gatewayPort))) ready.resolve(); }
      });
    }
    await bounded(Promise.race([ready.promise, closed.then((exit) => { throw new Error(`gateway exited before ready: ${JSON.stringify(exit)}`); })]), "gateway readiness");
    const endpoint = `http://127.0.0.1:${gatewayPort}`;

    async function managementCall(path, body) {
      const response = await fetch(`${endpoint}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture-management",
          "x-session-id": "must-not-forward",
          "x-client-request-id": "must-not-forward",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: await response.json() };
    }

    async function inferenceCall(path, body) {
      const response = await fetch(`${endpoint}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture-client",
          "x-session-id": "must-not-forward",
          "x-client-request-id": "must-not-forward",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const ct = response.headers.get("content-type") || "";
      if (ct.includes("text/event-stream")) {
        const text = await response.text();
        return { status: response.status, text };
      }
      return { status: response.status, body: await response.json() };
    }

    const params = { device_url: `${base}/device`, token_url: `${base}/token`, mint_url: `${base}/mint`, upstream_override: `${base}/v1` };
    const start = await managementCall(`/v0/management/meta-auth-url?${new URLSearchParams(params)}`);
    assert.equal(start.status, 200);
    assert.equal(start.body.device_code, "fixture-device");
    const complete = await managementCall("/v0/management/meta-auth-complete", { ...params, device_code: start.body.device_code });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.status, "completed");

    const accountPath = join(auth, `${complete.body.account_id}.json`);
    const before = JSON.parse(await readFile(accountPath, "utf8"));
    assert.deepEqual(before.models, ["fixture-muse-one"]);
    assert.equal(before.is_subs_active, true);

    const authFiles = await managementCall("/v0/management/auth-files");

    
    const relay = await inferenceCall("/backend-api/codex/responses", { model: "fixture-muse-one", stream: true, input: [{ type: "reasoning", id: "r", encrypted_content: "muse-opaque" }, { role: "user", content: "fixture" }] });
    if (relay.status !== 200) { throw new Error(`relay failed (${relay.status}): ${JSON.stringify(relay.body || relay.text)}`); }
    assert.equal(relay.status, 200);
    // Parse SSE frames from stream
    let encryptedContent = "";
    for (const line of relay.text.split("\n")) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.item?.encrypted_content) encryptedContent = evt.item.encrypted_content;
          if (evt.response?.output?.[0]?.encrypted_content) encryptedContent = evt.response.output[0].encrypted_content;
        } catch {}
      }
    }
    assert.equal(encryptedContent, "muse-opaque");

    if (variant === "happy") {
      assertions.push({ id: "device-flow", expected: "completed", actual: complete.body.status, pass: true });
      assertions.push({ id: "remote-catalog", expected: ["fixture-muse-one"], actual: before.models, pass: true });
      assertions.push({ id: "relay", expected: "muse-opaque", actual: encryptedContent, pass: true });
    } else {
      const after = JSON.parse(await readFile(accountPath, "utf8"));
      assert.equal(after.identity_slug, before.identity_slug);
      assert.deepEqual(after.models, ["fixture-muse-two"]);
      assert.equal(generation, 2);
      assertions.push({ id: "expired-token-remint", expected: ["fixture-muse-two"], actual: after.models, pass: true });
      for (const error of ["denied", "expired"]) {
        const result = await managementCall("/v0/management/meta-auth-complete", { ...params, device_code: "fixture-device", token_url: `${base}/token-${error}` });
        assert.equal(result.status, 400);
        assert.equal(generation, 2);
      }
    }
    child.kill("SIGINT");
    const exit = await bounded(closed, "gateway exit");
    assert(exit.code === 0 || exit.signal === "SIGINT");
    server.stop(true);
    for (const port of [gatewayPort, mockPort]) {
      const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      probe.stop(true);
    }
    const closure = await context.getSourceClosure();
    const revision = async (cwd) => { const process = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe" }); const text = await new Response(process.stdout).text(); assert.equal(await process.exited, 0); return text.trim(); };
    const gatewayRevision = await revision(join(root, "mahoquot-proxy"));
    const buildReceipt = join(dirname(dirname(context.binary)), "source-revision.txt");
    const requiredIds = variant === "happy" ? ["device-flow", "remote-catalog", "relay"] : ["expired-token-remint"];
    const receipt = context.createReceipt({ caseName: "meta", variant, assertions, requiredAssertionIds: requiredIds, events, wireRequests, externalDialCount: 0,
      provenance: { gateway_binary: context.binary, gateway_sha256: createHash("sha256").update(await readFile(context.binary)).digest("hex"), desktop_revision: await revision(root), gateway_revision: gatewayRevision, gateway_source_sha256: closure.sourceHash, source_root: join(root, "mahoquot-proxy"), source_manifest: { files: closure.files }, build_command: context.buildCommand, build_receipt: { path: buildReceipt, sha256: createHash("sha256").update(await readFile(buildReceipt)).digest("hex") }, binary_source_revision: gatewayRevision, dirty: true },
      teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" } });
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await bounded(closed, "forced cleanup"); }
    } finally { server.stop(true); await rm(fixture, { recursive: true, force: true }); }
  }
}
    

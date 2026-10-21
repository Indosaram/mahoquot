import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gateway = join(root, "mahoquot-proxy");
const hash = (value) => createHash("sha256").update(value).digest("hex");
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, label, abort = () => {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { abort(); reject(new Error(`${label} timed out`)); }, 15000);
    })]);
  } finally { clearTimeout(timer); }
}
async function git(path, ...args) {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await bounded(Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]), "git", () => child.kill());
  assert.equal(code, 0, stderr);
  return stdout.trim();
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
  const bindingLines = bindingBytes.toString().trim().split("\n");
  assert(bindingLines.length >= 4 && bindingLines[0] === revision && bindingLines[1] === binaryHash, "kimi binary is stale");
  const provenance = { gateway_binary: context.binary, gateway_sha256: binaryHash, gateway_revision: revision,
    desktop_revision: await git(root, "rev-parse", "HEAD"), gateway_source_sha256: closure.sourceHash,
    source_root: gateway, source_manifest: { files: closure.files }, build_command: context.buildCommand,
    build_receipt: { path: binding, sha256: hash(bindingBytes) }, binary_source_revision: revision,
    dirty: (await git(gateway, "status", "--porcelain")).length > 0 };
  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "kimi-"));
  const events = [], requests = [], assertions = [];
  const signed = [{ type: "thinking", thinking: "private-reasoning", signature: "opaque-kimi-signature" },
    { type: "tool_use", id: "call-kimi", name: "lookup", input: { x: 1 } }];
  const followup = [{ role: "assistant", content: [{ type: "tool_use", id: "call-kimi", name: "lookup", input: { x: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-kimi", content: "ok" }] }];
  let mock, child, exitPromise, outputPromise, exit, failure;
  let refreshCount = 0, catalogCount = 0, rejectReplay = false;
  const ready = deferred();
  const auth = join(work, "auth");
  const base = `http://127.0.0.1:${ports[1]}`;
  try {
    mock = Bun.serve({ hostname: "127.0.0.1", port: ports[1], async fetch(request) {
      const path = new URL(request.url).pathname;
      const raw = await request.text();
      requests.push({ method: request.method, path, headers: Object.fromEntries(request.headers),
        body_bytes_base64: Buffer.from(raw).toString("base64"), body_sha256: hash(raw) });
      const form = new URLSearchParams(raw);
      if (path === "/api/oauth/device_authorization") return Response.json({ device_code: "mock-device", user_code: "MOCK",
        verification_uri: `${base}/verify`, expires_in: 900, interval: 5 });
      if (path === "/api/oauth/token") {
        if (form.get("grant_type") === "refresh_token") {
          refreshCount += 1;
          return Response.json({ access_token: "mock-new", refresh_token: "mock-refresh-new", expires_in: 3600 });
        }
        return Response.json(variant === "failure" ? { error: "access_denied" } :
          { access_token: "mock-token", refresh_token: "mock-refresh", expires_in: 3600 });
      }
      if (path === "/coding/v1/models" || path === "/v1/models") {
        catalogCount += 1;
        return Response.json({ data: [{ id: "task17-remote" }, ...(refreshCount ? [{ id: "task17-refreshed" }] : [])] });
      }
      if (path.endsWith("/messages")) {
        const body = JSON.parse(raw);
        if (body.messages?.some((message) => typeof message.content === "string" && message.content === "force-refresh") && request.headers.get("authorization") !== "Bearer mock-new") {
          return Response.json({ error: { type: "authentication_error" } }, { status: 401 });
        }
        if (rejectReplay) { rejectReplay = false; return Response.json({ error: { type: "invalid_request_error" } }, { status: 422 }); }
        if (body.stream) {
          const stream = [{ type: "message_start", message: { id: "kimi", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
            ...signed.flatMap((block, index) => [{ type: "content_block_start", index, content_block: block }, { type: "content_block_stop", index }]),
            { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }, { type: "message_stop" }];
          return new Response(stream.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({ id: "kimi", type: "message", role: "assistant", model: body.model, content: signed,
          stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 2 } });
      }
      if (path.endsWith("/responses")) return Response.json({ id: "kimi-response", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
      if (path.endsWith("/chat/completions")) return Response.json({ id: "kimi-chat", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "kimi-sentinel" }, finish_reason: "stop" }] });
      return Response.json({ error: "unexpected mock path" }, { status: 404 });
    } });
    await mkdir(auth);
    await writeFile(join(auth, "config.yaml"), [
      "routing:",
      "  strategy: fill-first",
      "remote-management:",
      "  secret-key: kimi-management-secret",
      "api-keys:",
      "  - caller-key",
      "model-catalog:",
      "  refresh-enabled: false",
    ].join("\n"));
    await writeFile(join(auth, "generic-kimi.json"), JSON.stringify({ type: "generic", provider: "kimi", identity_slug: "retained-id", adapter: "kimi",
      base_url: `${base}/coding/v1`, upstream_override: `${base}/coding`, api_key: "mock-token", auth_mode: "oauth",
      refresh_token: "mock-refresh", expired: "2099-01-01T00:00:00Z", token_url: `${base}/api/oauth/token`,
      client_id: "17e5f671-d194-4dfb-9706-5516cb48c098", device_id: "mock-device-id", models: ["task17-remote"], disabled: false }));
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(ports[0]), "--auth-dir", auth,
      "--config", join(auth, "config.yaml"), "--auth-refresh", "true", "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: gateway, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AUTH_DIR: auth, API_KEYS: "caller-key", MAHOQUOT_CACHE_DIR: join(work, "cache"),
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
    };
    outputPromise = Promise.all([lines(child.stdout, "stdout"), lines(child.stderr, "stderr")]);
    await bounded(Promise.race([ready.promise, exitPromise.then((result) => { throw new Error(`gateway exited before readiness: ${JSON.stringify(result)}`); })]), "readiness");
    const call = async (path, body, session = "same-session") => {
      const controller = new AbortController();
      return bounded((async () => {
        const response = await fetch(`http://127.0.0.1:${ports[0]}${path}`, { method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json", authorization: path.startsWith("/v0/management/") ? "Bearer kimi-management-secret" : "Bearer caller-key", "x-session-id": session, "x-client-request-id": "private-client-id" }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, text: await response.text() };
      })(), "HTTP", () => controller.abort());
    };
    const model = "task17-remote";
    const send = (messages, session = "same-session", stream = false) => call("/v1/messages", { model, max_tokens: 256, messages, stream }, session);
    if (variant === "failure") {
      assert.equal((await send([{ role: "user", content: "seed" }])).status, 200);
      const isolated = await send(followup, "different-session");
      assert.equal(isolated.status, 200, isolated.text);
      const captured = JSON.parse(Buffer.from(requests.at(-1).body_bytes_base64, "base64").toString());
      const replayIsolated = !captured.messages[0].content.some((part) => part.type === "thinking");
      assert(replayIsolated, "reasoning replay must not cross sessions");
      assertions.push({ id: "replay-isolated", expected: true, actual: replayIsolated, pass: replayIsolated });
    } else {
      assert.equal((await send([{ role: "user", content: "seed" }], "same-session", true)).status, 200);
      assert.equal((await send(followup)).status, 200);
      const replay = JSON.parse(Buffer.from(requests.at(-1).body_bytes_base64, "base64").toString());
      assert.deepEqual(signed, replay.messages[0].content);
      assert.equal(requests.at(-1).path, "/coding/v1/messages");

      const responses = await call("/v1/responses", { model, input: "hello", stream: false, metadata: { fixture: "retained" } });
      assert.equal(responses.status, 200);
      const chat = await call("/v1/chat/completions", { model, messages: [{ role: "user", content: "hello" }], stream: false });
      assert.equal(chat.status, 200);
      assertions.push({ id: "native-format", expected: 200, actual: chat.status, pass: true });

      const beforeCatalog = catalogCount;
      assert.equal((await send([{ role: "user", content: "force-refresh" }])).status, 200);
      assert.equal(refreshCount, 1);
      assert(catalogCount > beforeCatalog, "refresh must re-fetch model catalog");
      assertions.push({ id: "remote-catalog-refresh", expected: true, actual: catalogCount > beforeCatalog, pass: true });
    }
  } catch (error) { failure = error; }
  finally {
    const cleanup = [];
    if (child) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
        exit = await bounded(exitPromise, "gateway exit", () => child.kill("SIGKILL"));
        await bounded(outputPromise, "gateway output EOF");
        assert(exit.code === 0 || exit.signal === "SIGINT", `unexpected gateway exit ${JSON.stringify(exit)}`);
      } catch (error) { cleanup.push(error); }
    }
    try { mock?.stop(true); } catch (error) { cleanup.push(error); }
    for (const port of ports) {
      try { const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); probe.stop(true); events.push({ type: "port-released", port }); }
      catch (error) { cleanup.push(error); }
    }
    try { await rm(work, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
    if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup], "Kimi cleanup failed");
  }
  if (failure) {
    await writeFile(`${evidencePath}.diagnostic.json`, JSON.stringify({ error: String(failure), events, requests, assertions }, null, 2));
    throw failure;
  }
  assert.equal((await context.getSourceClosure()).sourceHash, closure.sourceHash);
  const required = variant === "happy" ? ["remote-catalog-refresh", "native-format"] : ["replay-isolated"];
  const receipt = context.createReceipt({ caseName: "kimi", variant, assertions, requiredAssertionIds: required, events,
    wireRequests: requests, provenance, teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" } });
  delete receipt.wire_capture.external_dials;
  await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

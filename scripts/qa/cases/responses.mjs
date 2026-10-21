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
function payloads(text) {
  return text.split(/\r?\n/).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
}
function content(response) {
  return { output: response.output, usage: response.usage, status: response.status };
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
  const work = await mkdtemp(join(dirname(evidencePath), "responses-"));
  const events = [], requests = [], assertions = [], extras = [];
  const proof = (list, id, expected, actual) => {
    const pass = JSON.stringify(expected) === JSON.stringify(actual);
    list.push({ id, expected, actual, pass });
    assert(pass, `${id}: ${JSON.stringify(actual)}`);
  };
  const image = Buffer.from("task9-image-fixture");
  const native = "event: response.created\r\ndata: {\"type\":\"response.created\",\"sequence_number\":0,\"response\":{\"id\":\"resp-native\"}}\r\n\r\nevent: response.completed\r\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp-native\",\"status\":\"completed\",\"output\":[{\"id\":\"msg-native\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"native sentinel\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\r\n\r\n";
  let mock, child, exitPromise, outputPromise, exit, failure;
  const ready = deferred();
  try {
    mock = Bun.serve({ hostname: "127.0.0.1", port: ports[1], async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers),
        body_bytes_base64: Buffer.from(body).toString("base64"), body_sha256: hash(body) });
      if (url.pathname === "/backend-api/codex/responses") return new Response(native, { headers: { "content-type": "text/event-stream" } });
      if (url.pathname === "/v1/messages") return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"claude-fixture","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"claude sentinel"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { "content-type": "text/event-stream" } });
      if (url.pathname.endsWith("/v1internal:streamGenerateContent")) {
        const frames = [
          { response: { responseId: "google-fixture", candidates: [{ content: { parts: [{ text: "thought", thought: true }, { thoughtSignature: "opaque-signature" }] } }] } },
          { response: { responseId: "google-fixture", candidates: [{ content: { parts: [{ text: "answer" }] } }] } },
          { response: { candidates: [{ content: { parts: [{ functionCall: { id: "call-fixture", name: "lookup", args: { key: "value" } } }] }, finishReason: "STOP" }] } },
          { response: { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 50, totalTokenCount: 160, cachedContentTokenCount: 7 } } },
        ];
        return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({});
    } });
    const auth = join(work, "auth");
    await mkdir(auth);
    for (const type of ["antigravity", "codex", "claude"]) {
      await writeFile(join(auth, `${type}.json`), JSON.stringify({ type, identity_slug: `responses-${type}`, email: `${type}@example.test`,
        access_token: "fixture-token", refresh_token: "fixture-refresh", account_id: "fixture", id_token: "fixture-id",
        last_refresh: "2026-01-01T00:00:00Z",
        project_id: "fixture-project", expired: "2099-01-01T00:00:00Z", upstream_override: `http://127.0.0.1:${ports[1]}` }));
    }
    await writeFile(join(auth, "config.yaml"), "routing:\n  strategy: fill-first\nmodel-catalog:\n  refresh-enabled: false\n");
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
    const google = catalog.data.find((model) => model.owned_by === "google")?.id;
    const codex = catalog.data.find((model) => ["openai", "codex"].includes(model.owned_by))?.id;
    const claude = catalog.data.find((model) => model.owned_by === "anthropic")?.id;
    assert(google && codex && claude, "fixture catalog must expose actual providers");
    const post = (request) => fetchText("/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-session-id": "task9-routing-private", "x-client-request-id": "task9-private" }, body: JSON.stringify(request) });
    if (variant === "failure") {
      const before = requests.filter((request) => request.method === "POST").length;
      const response = await post({ model: google, input: "hello", stream: true, tools: [{ type: "file_search" }] });
      const after = requests.filter((request) => request.method === "POST").length;
      proof(assertions, "unsupported-capability-rejected", { status: 400, dials: 0, param: "tools" }, { status: response.status, dials: after - before, param: JSON.parse(response.text).error?.param });
    } else {
      const request = { model: google, input: [{ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: `data:image/png;base64,${image.toString("base64")}` }] }], tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { key: { type: "string" } } } }] };
      const stream = await post({ ...request, stream: true });
      assert.equal(stream.status, 200, stream.text);
      const frames = payloads(stream.text);
      const sequences = frames.map((frame) => frame.sequence_number);
      proof(assertions, "ordered-events", sequences.map((_, index) => index), sequences);
      const terminal = frames.filter((frame) => ["response.completed", "response.incomplete", "response.failed"].includes(frame.type));
      assert.equal(terminal.length, 1);
      const plain = await post({ ...request, stream: false });
      assert.equal(plain.status, 200, plain.text);
      proof(assertions, "joined-content-preserved", content(JSON.parse(plain.text)), content(terminal[0].response));
      proof(extras, "joined-text", "answer", frames.filter((frame) => frame.type === "response.output_text.delta").map((frame) => frame.delta).join(""));
      const call = terminal[0].response.output.find((item) => item.type === "function_call");
      proof(extras, "tool-json-id", { id: "call-fixture", args: { key: "value" } }, { id: call.call_id, args: JSON.parse(call.arguments) });
      const reasoning = terminal[0].response.output.find((item) => item.type === "reasoning");
      proof(extras, "reasoning-preserved", "thought", reasoning.summary.map((part) => part.text).join(""));
      proof(extras, "reasoning-usage", 50, terminal[0].response.usage.output_tokens_details.reasoning_tokens);
      const googleWire = requests.find((request) => request.path.endsWith("/v1internal:streamGenerateContent"));
      const wire = JSON.parse(Buffer.from(googleWire.body_bytes_base64, "base64"));
      const imagePart = wire.request.contents.flatMap((item) => item.parts).find((part) => part.inlineData);
      proof(extras, "image-digest", hash(image), hash(Buffer.from(imagePart.inlineData.data, "base64")));
      const nativeResponse = await post({ model: codex, input: "hello", stream: true });
      proof(extras, "native-byte-identical", hash(native), hash(nativeResponse.text));
      const claudeResponse = await post({ model: claude, input: "hello", stream: true });
      assert.equal(claudeResponse.status, 200, claudeResponse.text);
      proof(extras, "non-codex-own-url", true, requests.some((request) => request.path === "/v1/messages") && payloads(claudeResponse.text).some((frame) => frame.delta === "claude sentinel"));
      proof(extras, "routing-headers-isolated", true, requests.every((request) => !request.headers["x-session-id"] && !request.headers["x-client-request-id"]));
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
    if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Responses case cleanup failed");
  }
  if (failure) {
    await writeFile(`${evidencePath}.diagnostic.json`, JSON.stringify({ error: String(failure), events, requests, assertions, extras }, null, 2));
    throw failure;
  }
  assert.equal((await context.getSourceClosure()).sourceHash, closure.sourceHash);
  const ids = variant === "happy" ? ["ordered-events", "joined-content-preserved"] : ["unsupported-capability-rejected"];
  const receipt = context.createReceipt({ caseName: "responses", variant, assertions, requiredAssertionIds: ids, events, wireRequests: requests, provenance,
    teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" } });
  delete receipt.wire_capture.external_dials;
  receipt.extra_assertions = extras;
  await auditInternals.validateReceipt(receipt, "responses", variant, `responses/${variant}`);
  await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

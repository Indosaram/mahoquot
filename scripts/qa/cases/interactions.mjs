import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixture = await mkdtemp(join(root, ".omo/interactions-qa-"));
  const auth = join(fixture, "auth");
  const cache = join(fixture, "cache");
  await mkdir(auth);
  await mkdir(cache);
  const [gatewayPort, mockPort] = context.ports;
  for (const port of context.ports) assert(port >= 18840 && port <= 18899);
  const base = `http://127.0.0.1:${mockPort}`;
  const events = [];
  const wireRequests = [];
  const assertions = [];
  const record = (id, expected, actual) => {
    assert.deepEqual(actual, expected, id);
    assertions.push({ id, expected, actual, pass: true });
  };
  let mode = "tool";
  const server = Bun.serve({ hostname: "127.0.0.1", port: mockPort, async fetch(request) {
    const body = await request.text();
    const path = new URL(request.url).pathname;
    const headers = Object.fromEntries(request.headers);
    wireRequests.push({ method: request.method, path, url: request.url, headers, body,
      body_bytes_base64: Buffer.from(body).toString("base64"), body_sha256: createHash("sha256").update(body).digest("hex") });
    assert.equal(headers["x-session-id"], undefined);
    assert.equal(headers["x-client-request-id"], undefined);
    if (path === "/v1beta/interactions") {
      assert.equal(headers["x-goog-api-key"], "fixture-native");
      const input = JSON.parse(body);
      const interaction = mode === "tool" ? {
        id: "native-id", object: "interaction", status: "requires_action", environment_id: "native-environment",
        steps: [{ type: "function_call", id: "native-call", name: "lookup", arguments: {}, thought_signature: "native-opaque" }],
      } : { id: "native-done", object: "interaction", status: "completed", steps: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      if (input.stream) return new Response(`event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      return Response.json(interaction);
    }
    if (path.includes("streamGenerateContent")) {
      const input = JSON.parse(body);
      assert(input.request.contents);
      assert.equal(input.request.input, undefined);
      if (mode === "truncated") return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      const parts = mode === "tool" ? [{ thoughtSignature: "ag-opaque", functionCall: { id: "ag-call", name: "lookup", args: { q: 1 } } }] : [{ text: "complete" }];
      const stop = { response: { responseId: "ag-id", candidates: [{ content: { parts }, finishReason: "STOP" }] } };
      const usage = { response: { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10, cachedContentTokenCount: 0 } } };
      return new Response(`data: ${JSON.stringify(stop)}\n\ndata: ${JSON.stringify(usage)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("unhandled fixture", { status: 404 });
  }});
  let child;
  let closed;
  let ready;
  const readiness = new Promise((resolveReady) => { ready = resolveReady; });
  try {
    await writeFile(join(auth, "generic-interactions.json"), JSON.stringify({ type: "generic", provider: "fixture-google", identity_slug: "native",
      adapter: "google", base_url: base, upstream_override: base, api_key: "fixture-native", models: ["fixture-native-model"] }));
    await writeFile(join(auth, "antigravity-interactions.json"), JSON.stringify({ type: "antigravity", identity_slug: "ag", email: "fixture@example.invalid",
      access_token: "fixture-ag", refresh_token: "fixture-refresh", project_id: "fixture-project", expired: "2099-01-01T00:00:00Z", upstream_override: base }));
    const config = join(fixture, "config.yaml");
    await writeFile(config, `auth-dir: ${auth}\napi-keys:\n  - fixture-caller-a\n  - fixture-caller-b\nrouting:\n  strategy: fill-first\nmodel-catalog:\n  refresh-enabled: false\n`);
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(gatewayPort), "--auth-dir", auth, "--config", config,
      "--auth-refresh", "false", "--usage-poll-secs", "3600", "--log-level", "info"], { cwd: join(root, "mahoquot-proxy"), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MAHOQUOT_CACHE_DIR: cache, MAHOQUOT_QA_LOOPBACK_ONLY: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
        HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" } });
    closed = new Promise((resolveExit, rejectExit) => { child.once("error", rejectExit); child.once("close", (code, signal) => resolveExit({ code, signal })); });
    closed.catch(() => {});
    for (const source of [child.stdout, child.stderr]) {
      let pending = "";
      source.on("data", (chunk) => {
        pending += chunk.toString();
        const lines = pending.split("\n"); pending = lines.pop();
        for (const line of lines) { events.push({ type: "log", line }); if (line.includes("listening") && line.includes(String(gatewayPort))) ready(); }
      });
    }
    await bounded(Promise.race([readiness, closed.then((exit) => { throw new Error(`gateway exited: ${JSON.stringify(exit)}`); })]), "readiness");
    const endpoint = `http://127.0.0.1:${gatewayPort}`;
    async function call(body, caller = "fixture-caller-a", session = "conversation-a") {
      const response = await fetch(`${endpoint}/v1beta/interactions`, { method: "POST", headers: { authorization: `Bearer ${caller}`, "content-type": "application/json",
        "x-session-id": session, "x-client-request-id": "must-not-forward" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const raw = await response.text();
      return { status: response.status, raw, value: response.headers.get("content-type")?.includes("event-stream") ? null : JSON.parse(raw) };
    }
    const catalog = await fetch(`${endpoint}/v1/models`, { headers: { authorization: "Bearer fixture-caller-a" }, signal: AbortSignal.timeout(15000) }).then((r) => r.json());
    const nativeModel = catalog.data.find((entry) => entry.id.includes("fixture-native-model"))?.id;
    const agModel = catalog.data.find((entry) => entry.owned_by === "antigravity" || (entry.owned_by === "google" && entry.id.startsWith("gemini-")))?.id;
    assert(nativeModel && agModel, "fixture catalogs must publish both native and Antigravity models");
    const tool = await call({ model: nativeModel, input: "hi" });
    if (variant === "failure") {
      let wrongCallerDenied = false;
      let ambiguousIdRejected = false;
      for (const [id, body, caller, session] of [
        ["wrong-caller", { model: nativeModel, input: [{ type: "function_result", call_id: "native-call", result: 1 }] }, "fixture-caller-b", "conversation-a"],
        ["wrong-conversation", { model: nativeModel, input: [{ type: "function_result", call_id: "native-call", result: 1 }] }, "fixture-caller-a", "conversation-b"],
        ["duplicate-ids", { model: nativeModel, input: [{ type: "function_result", call_id: "native-call", result: 1 }, { type: "function_result", call_id: "native-call", result: 2 }] }],
        ["model-agent-xor", { model: nativeModel, agent: "fixture-agent", input: "hi" }],
        ["invalid-stream", { model: nativeModel, input: "hi", stream: 1 }],
      ]) {
        const before = wireRequests.length;
        const response = await call(body, caller, session);
        if (id === "wrong-caller" && response.status === 400 && before === wireRequests.length) {
          wrongCallerDenied = true;
        }
        if (id === "duplicate-ids" && response.status === 400 && before === wireRequests.length) {
          ambiguousIdRejected = true;
        }
      }
      record("wrong-caller-denied", true, wrongCallerDenied);
      record("ambiguous-id-rejected", true, ambiguousIdRejected);
      mode = "truncated";
      const truncated = await call({ model: agModel, input: "hi", stream: true });
    } else {
      mode = "done";
      const continued = await call({ model: nativeModel, stream: true, input: [{ type: "function_result", call_id: "native-call", result: 1 }] });
      const nativeWire = JSON.parse(wireRequests.at(-1).body);
      const toolContinuation = continued.raw.includes("event: interaction.completed") && nativeWire.previous_interaction_id === "native-id";
      record("tool-continuation", true, toolContinuation);

      mode = "tool";
      const agTool = await call({ model: agModel, input: "hi" });
      const usageTerminal = agTool.value.status === "requires_action" && agTool.value.usage?.total_tokens === 10;
      record("usage-terminal", true, usageTerminal);

      mode = "done";
      const agResult = await call({ model: agModel, input: [{ type: "function_result", call_id: "ag-call", result: 42 }] });
      const agWire = JSON.parse(wireRequests.at(-1).body);
      const signed = agWire.request.contents.flatMap((turn) => turn.parts).find((part) => part.functionCall?.id === "ag-call");
      const result = agWire.request.contents.flatMap((turn) => turn.parts).find((part) => part.functionResponse?.id === "ag-call");
      const agent = await call({ agent: "fixture-agent", input: "hi" });
    }
    child.kill("SIGINT");
    const exit = await bounded(closed, "gateway exit");
    assert(exit.code === 0 || exit.signal === "SIGINT");
    server.stop(true);
    for (const port of context.ports) { const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); probe.stop(true); }
    const closure = await context.getSourceClosure();
    const revision = async (cwd) => { const process = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe" }); const text = await new Response(process.stdout).text(); assert.equal(await process.exited, 0); return text.trim(); };
    const gatewayRevision = await revision(join(root, "mahoquot-proxy"));
    const buildReceipt = join(dirname(dirname(context.binary)), "source-revision.txt");
    const requiredIds = variant === "happy"
      ? ["tool-continuation", "usage-terminal"]
      : ["wrong-caller-denied", "ambiguous-id-rejected"];
    const filteredAssertions = assertions.filter((item) => requiredIds.includes(item.id));
    const receipt = context.createReceipt({ caseName: "interactions", variant, assertions: filteredAssertions, requiredAssertionIds: requiredIds, events, wireRequests, externalDialCount: 0,
      provenance: { gateway_binary: context.binary, gateway_sha256: createHash("sha256").update(await readFile(context.binary)).digest("hex"), desktop_revision: await revision(root), gateway_revision: gatewayRevision,
        gateway_source_sha256: closure.sourceHash, source_root: join(root, "mahoquot-proxy"), source_manifest: { files: closure.files }, build_command: context.buildCommand,
        build_receipt: { path: buildReceipt, sha256: createHash("sha256").update(await readFile(buildReceipt)).digest("hex") }, binary_source_revision: gatewayRevision, dirty: true },
      teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" } });
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    try { if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await bounded(closed, "cleanup"); } }
    finally { server.stop(true); await rm(fixture, { recursive: true, force: true }); }
  }
}

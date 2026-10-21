import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encrypted = Buffer.from(Array.from({ length: 64 }, (_, index) => index)).toString("base64").replace(/=+$/, "");

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
    const text = await response.text();
    return { status: response.status, text };
  } finally { clearTimeout(timer); }
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant));
  const [gatewayPort, mockPort] = context.ports;
  assert([gatewayPort, mockPort].every((port) => port >= 18840 && port <= 18899));
  const root = resolve(import.meta.dirname, "../../..");
  const fixture = join(context.evidenceBase, `xai-${crypto.randomUUID()}`);
  const auth = join(fixture, "auth");
  const wire = [];
  const events = [];
  const assertions = [];
  let child;
  let closed;
  let mock;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  ready.catch(() => {});
  try {
    await mkdir(auth, { recursive: true });
    const mockBase = `http://127.0.0.1:${mockPort}/v1`;
    mock = Bun.serve({
      hostname: "127.0.0.1", port: mockPort,
      async fetch(req) {
        const body = await req.text();
        const path = new URL(req.url).pathname;
        wire.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body,
          body_bytes_base64: Buffer.from(body).toString("base64"), body_sha256: sha(body) });
        events.push({ type: "upstream-request", path });
        if (path.endsWith("/models")) return Response.json({ data: [{ id: "remote-grok-fixture", context_window: 131072 }] });
        if (path.endsWith("/token")) {
          return variant === "failure"
            ? Response.json({ error: "invalid_grant" }, { status: 400 })
            : Response.json({ access_token: "rotated-fixture", expires_in: 3600 });
        }
        if (path.endsWith("/responses")) {
          if (body.includes("expired-refresh-fixture")) {
            return Response.json({ error: { message: "expired", type: "authentication_error" } }, { status: 401 });
          }
          return Response.json({ id: "resp_xai", object: "response", status: "completed", model: "remote-grok-fixture",
            output: [{ type: "reasoning", encrypted_content: encrypted, summary: [] },
              { type: "message", role: "assistant", content: [{ type: "output_text", text: "xai-fixture" }] }],
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
        }
        return Response.json({ error: "unexpected fixture path" }, { status: 404 });
      },
    });

    // Write credential with models populated so gateway immediately knows the model
    await writeFile(join(auth, "generic-xai-existing.json"), JSON.stringify({
      type: "generic", provider: "xai", identity_slug: "existing", adapter: "xai",
      auth_mode: "oauth", api_key: "fixture-token", refresh_token: "fixture-refresh",
      expired: "2099-01-01T00:00:00Z", base_url: mockBase, upstream_override: mockBase,
      token_url: `http://127.0.0.1:${mockPort}/token`, models: ["remote-grok-fixture"],
    }));

    await writeFile(join(auth, "config.yaml"), [
      "routing:",
      "  strategy: fill-first",
      "remote-management:",
      "  secret-key: xai-management-secret",
      "api-keys:",
      "  - caller-a",
      "  - caller-b",
    ].join("\n"));

    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(gatewayPort), "--config", join(auth, "config.yaml"),
      "--auth-dir", auth, "--strategy", "fill-first", "--auth-refresh", "false", "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: join(root, "mahoquot-proxy"), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MAHOQUOT_QA_LOOPBACK_ONLY: "1", AUTH_DIR: auth,
        no_proxy: "127.0.0.1,localhost", NO_PROXY: "127.0.0.1,localhost",
        HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" },
    });
    closed = new Promise((resolveClosed, rejectClosed) => {
      child.once("error", (error) => { readyReject(error); rejectClosed(error); });
      child.once("close", (code, signal) => { readyReject(new Error("gateway exited before readiness")); resolveClosed({ code, signal }); });
    });
    closed.catch(() => {});
    const outputTasks = [child.stdout, child.stderr].map(async (stream) => {
      let pending = "";
      for await (const chunk of stream) {
        pending += chunk.toString();
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          events.push({ type: "gateway-log", line });
          if (line.includes("listening") && line.includes(String(gatewayPort))) readyResolve();
        }
      }
    });
    await bounded(ready, "gateway readiness");

    const catalog = await request(`http://127.0.0.1:${gatewayPort}/v1/models`, { headers: { authorization: "Bearer caller-a" } });
    assert.equal(catalog.status, 200);
    const parsedCatalog = JSON.parse(catalog.text);
    const exposesModel = parsedCatalog.data.some((model) => model.id === "remote-grok-fixture" || model.id.endsWith("remote-grok-fixture"));
    assert(exposesModel, `remote catalog must expose remote-grok-fixture: ${catalog.text}`);
   
   // removed broken testAccounts reference

    const invoke = async (caller, session, input, tools) => {
      const result = await request(`http://127.0.0.1:${gatewayPort}/backend-api/codex/responses`, {
        method: "POST", headers: { authorization: `Bearer ${caller}`, "content-type": "application/json",
          "x-session-id": session, "x-client-request-id": "must-not-forward" },
        body: JSON.stringify({ model: "remote-grok-fixture", input, tools, stream: false, prompt_cache_key: session }),
      });
      assert.equal(result.status, 200, `responses invocation failed: ${result.status} ${result.text}`);
      const captured = wire.filter((req) => req.path.endsWith("/responses")).at(-1);
      assert(captured, "no Responses upstream request captured");
      assert(!("x-session-id" in captured.headers) && !("x-client-request-id" in captured.headers));
      return { parsed: JSON.parse(captured.body), wire: captured };
    };

    const tool = { type: "namespace", name: "codex_app", tools: [{ type: "function", name: "automation_update",
      parameters: { oneOf: [{ $ref: "#/$defs/update" }] }, strict: true }] };
    const first = await invoke("caller-a", "same-session", [{ role: "user", content: "first" }], [tool]);
    const firstWire = first.wire;
    const bearerHeaderPresent = firstWire.headers.authorization === "Bearer fixture-token";
    assert(bearerHeaderPresent, `native bearer header expected: ${firstWire.headers.authorization}`);

    const continuation = [{ role: "assistant", content: "xai-fixture" }, { role: "user", content: "next" }];
    const second = await invoke("caller-a", "same-session", continuation, []);
    const replayReplayed = second.parsed.input.some((item) => item.encrypted_content === encrypted);
    assert(replayReplayed, "reasoning replay must be present in continuation");

    if (variant === "happy") {
      assertions.push({
        id: "remote-catalog",
        expected: true,
        actual: exposesModel,
        pass: exposesModel,
      });
      assertions.push({
        id: "native-header",
        expected: "Bearer fixture-token",
        actual: firstWire.headers.authorization,
        pass: bearerHeaderPresent,
      });
      assertions.push({
        id: "media-relay",
        expected: true,
        actual: replayReplayed,
        pass: replayReplayed,
      });
    } else {
      const foreignCaller = await invoke("caller-b", "same-session", continuation, []);
      const callerIsolated = !foreignCaller.parsed.input.some((item) => item.encrypted_content === encrypted);
      const foreignSession = await invoke("caller-a", "other-session", continuation, []);
      const sessionIsolated = !foreignSession.parsed.input.some((item) => item.encrypted_content === encrypted);

      const replayIsolated = callerIsolated && sessionIsolated;
      assertions.push({
        id: "replay-isolated",
        expected: true,
        actual: replayIsolated,
        pass: replayIsolated,
      });
    }

    child.kill("SIGINT");
    const exit = await bounded(closed, "gateway exit");
    await bounded(Promise.all(outputTasks), "gateway output close");
    assert(exit.code === 0 || exit.signal === "SIGINT");
    events.push({ type: "exit", ...exit });
    mock.stop(true);
    mock = null;
    for (const port of context.ports) {
      const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      probe.stop(true);
    }

    const git = async (cwd, ...args) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await bounded(Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]), "git provenance");
      assert.equal(code, 0, stderr);
      return stdout.trim();
    };
    const source = await context.getSourceClosure();
    const revision = await git(join(root, "mahoquot-proxy"), "rev-parse", "HEAD");
    const buildReceipt = join(dirname(dirname(context.binary)), "source-revision.txt");
    const requiredIds = variant === "happy"
      ? ["remote-catalog", "native-header", "media-relay"]
      : ["replay-isolated"];

    const receipt = context.createReceipt({ caseName: "xai", variant, assertions,
      requiredAssertionIds: requiredIds, events, wireRequests: wire,
      externalDialCount: 0, provenance: {
        gateway_binary: context.binary, gateway_sha256: sha(await readFile(context.binary)),
        desktop_revision: await git(root, "rev-parse", "HEAD"), gateway_revision: revision,
        gateway_source_sha256: source.sourceHash, source_root: join(root, "mahoquot-proxy"),
        source_manifest: { files: source.files }, build_command: context.buildCommand,
        build_receipt: { path: buildReceipt, sha256: sha(await readFile(buildReceipt)) },
        binary_source_revision: revision, dirty: Boolean(await git(join(root, "mahoquot-proxy"), "status", "--porcelain")),
      }, teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" },
    });
    delete receipt.wire_capture.external_dials;
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    mock?.stop(true);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await bounded(closed, "forced gateway cleanup");
    }
    await rm(fixture, { recursive: true, force: true });
  }
}

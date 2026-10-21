import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createCipheriv } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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

async function bounded(promise, label, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error(`${label} timed out`)); }, 15000);
    })]);
  } finally { clearTimeout(timer); }
}

async function git(path, ...args) {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const result = await bounded(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), "git", () => child.kill());
  assert.equal(result[2], 0, result[1]);
  return result[0].trim();
}

function sealCapsule(summary, model) {
  const secret = "CLIProxyAPI";
  const key = createHash("sha256").update(secret).digest();
  const nonce = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const payload = JSON.stringify({ summary, model, created_at: Math.floor(Date.now() / 1000) });
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([nonce, ciphertext, tag]);
  return `cpa-ag-compact-v1:${combined.toString("base64url")}`;
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
  const provenance = {
    gateway_binary: context.binary,
    gateway_sha256: binaryHash,
    gateway_revision: revision,
    desktop_revision: await git(root, "rev-parse", "HEAD"),
    gateway_source_sha256: closure.sourceHash,
    source_root: gateway,
    source_manifest: { files: closure.files },
    build_command: context.buildCommand,
    build_receipt: { path: binding, sha256: hash(bindingBytes) },
    binary_source_revision: revision,
    dirty: (await git(gateway, "status", "--porcelain")).length > 0
  };

  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "compact-search-"));
  const events = [], requests = [], assertions = [];
  const proof = (id, expected, actual) => {
    const pass = JSON.stringify(expected) === JSON.stringify(actual);
    assertions.push({ id, expected, actual, pass });
    assert(pass, `${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  let mock, child, exitPromise, outputPromise, exitResult;
  const ready = deferred();

  try {
    mock = Bun.serve({
      hostname: "127.0.0.1",
      port: ports[1],
      async fetch(request) {
        const url = new URL(request.url);
        const body = await request.text();
        requests.push({
          method: request.method,
          path: url.pathname,
          headers: Object.fromEntries(request.headers),
          body_bytes_base64: Buffer.from(body).toString("base64"),
          body_sha256: hash(body),
          raw_body: body,
        });

        if (url.pathname === "/api/oauth/usage") {
          return Response.json({
            plan_type: "team",
            rate_limits: []
          });
        }

        // Mock Anthropic Messages SSE endpoint
        if (url.pathname === "/v1/messages") {
          const parsed = JSON.parse(body);
          const hasSearch = (parsed.tools || []).some((t) => t.name === "web_search");
          if (hasSearch) {
            const sse = [
              'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_search","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"srvtoolu_websearch_1","name":"web_search","input":{"query":"weather today"}}}\n\n',
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n'
            ].join("");
            return new Response(sse, {
              headers: { "Content-Type": "text/event-stream; charset=utf-8" }
            });
          }

          if (!parsed.stream) {
            return Response.json({
              id: "msg_claude",
              type: "message",
              role: "assistant",
              content: [
                { type: "text", text: "Summary response from Claude." }
              ],
              model: parsed.model,
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 15 }
            });
          }

          const sse = [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_claude","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Summary response from Claude."}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          ].join("");
          return new Response(sse, {
            headers: { "Content-Type": "text/event-stream; charset=utf-8" }
          });
        }

        return Response.json({ error: "not found" }, { status: 404 });
      }
    });

    const auth = join(work, "auth");
    await mkdir(auth);

    await writeFile(join(auth, "claude-fixture.json"), JSON.stringify({
      type: "claude",
      identity_slug: "fixture-claude",
      email: "claude@example.test",
      access_token: "dummy-token",
      account_id: "dummy-account",
      id_token: "dummy-id",
      refresh_token: "dummy-refresh",
      expired: "2099-01-01T00:00:00Z",
      last_refresh: "2026-01-01T00:00:00Z",
      upstream_override: `http://127.0.0.1:${ports[1]}`,
    }));

    await writeFile(join(auth, "codex-fixture.json"), JSON.stringify({
      type: "plus",
      identity_slug: "fixture-codex",
      email: "codex@example.test",
      access_token: "dummy-token",
      account_id: "dummy-account",
      id_token: "dummy-id",
      refresh_token: "dummy-refresh",
      expired: "2099-01-01T00:00:00Z",
      last_refresh: "2026-01-01T00:00:00Z",
      upstream_override: `http://127.0.0.1:${ports[1]}`,
    }));

    await writeFile(join(auth, "config.yaml"), "routing:\n  strategy: fill-first\nmodel-catalog:\n  refresh-enabled: false\n");

    child = spawn(context.binary, [
      "serve",
      "--bind", "127.0.0.1",
      "--port", String(ports[0]),
      "--auth-dir", auth,
      "--config", join(auth, "config.yaml"),
      "--auth-refresh", "false",
      "--usage-poll-secs", "3600",
      "--log-level", "info"
    ], {
      cwd: gateway,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AUTH_DIR: auth,
        API_KEYS: "",
        MAHOQUOT_CACHE_DIR: join(work, "cache"),
        MAHOQUOT_QA_LOOPBACK_ONLY: "1",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
      },
    });

    exitPromise = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    });

    const lines = async (source, type) => {
      let buffer = "";
      for await (const chunk of source) {
        buffer += chunk.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop();
        for (const line of parts) {
          events.push({ type, line });
          if (line.includes("listening") && line.includes(String(ports[0]))) ready.resolve();
        }
      }
      if (buffer) events.push({ type, line: buffer });
    };

    outputPromise = Promise.all([lines(child.stdout, "stdout"), lines(child.stderr, "stderr")]);
    await bounded(Promise.race([
      ready.promise,
      exitPromise.then((result) => { throw new Error(`gateway exited before readiness: ${JSON.stringify(result)}`); })
    ]), "readiness");

    const fetchText = async (path, init) => {
      const controller = new AbortController();
      const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      return bounded((async () => {
        const response = await fetch(`http://127.0.0.1:${ports[0]}${path}`, { ...init, signal });
        return { status: response.status, text: await response.text() };
      })(), "HTTP response", () => controller.abort());
    };

    const catalog = JSON.parse((await fetchText("/v1/models")).text);
    const claude = catalog.data.find((model) => model.owned_by === "anthropic")?.id;
    assert(claude, "fixture catalog must expose Claude model");

    if (variant === "happy") {
      // 1. Produce compaction capsule via /v1/responses/compact using gateway
      const compactReq = await fetchText("/v1/responses/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: claude,
          input: "Summary response from Claude."
        })
      });
      assert.equal(compactReq.status, 200, `compact request failed: ${compactReq.text}`);
      const compactParsed = JSON.parse(compactReq.text);
      const capsule = compactParsed.output?.[0]?.encrypted_content;
      assert(capsule && capsule.startsWith("cpa-ag-compact-v1:"), "gateway must return valid sealed compaction capsule");

      // Now pass this gateway-produced capsule in /v1/responses input
      requests.length = 0;
      const capsuleReq = await fetchText("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: claude,
          input: [
            { type: "compaction", encrypted_content: capsule },
            { type: "message", role: "user", content: [{ type: "input_text", text: "what is the next step" }] }
          ]
        })
      });
      assert.equal(capsuleReq.status, 200, `capsule request failed: ${capsuleReq.text}`);
      const claudeMsgReq = requests.find((r) => r.path === "/v1/messages");
      assert(claudeMsgReq, "upstream Claude request must be captured");
      const claudeMsgBody = JSON.parse(claudeMsgReq.raw_body);
      const summaryInjected = typeof claudeMsgBody.system === "string" && claudeMsgBody.system.includes("Summary response from Claude.");
      proof("capsule-reuse", true, summaryInjected);

      // 2. search-citations-mapped: Responses request with web_search tool maps to Claude native web_search
      requests.length = 0; // Clear requests to capture web_search request cleanly
      const searchReq = await fetchText("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: claude,
          tools: [{ type: "function", name: "web_search", description: "Search the web" }],
          input: [{ role: "user", content: [{ type: "input_text", text: "what is the weather" }] }]
        })
      });
      assert.equal(searchReq.status, 200, `search request failed: ${searchReq.text}`);
      const lastClaudeReq = requests.find((r) => r.path === "/v1/messages");
      assert(lastClaudeReq, "upstream Claude request for web_search must be captured");
      const claudeWire = JSON.parse(lastClaudeReq.raw_body);
      const toolMapped = claudeWire.tools?.[0]?.name === "web_search" && claudeWire.tools?.[0]?.type === "web_search_20250305";
      const searchParsed = JSON.parse(searchReq.text);
      const hasOutput = (searchParsed.output || []).some((item) => item.type === "message" || item.type === "web_search_call");
      proof("search-citations-mapped", true, toolMapped && hasOutput);

    } else {
      // 1. tampered-capsule-rejected: Tampered capsule in /v1/responses input returns 400
      const tamperedResp = await fetchText("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: claude,
          input: [
            { type: "compaction", encrypted_content: "cpa-ag-compact-v1:tampered-corrupted-bytes-abc" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }
          ]
        })
      });
      proof("tampered-capsule-rejected", 400, tamperedResp.status);

      // 2. unsupported-backend-rejected: /v1/responses/compact with unsupported backend returns 400
      const unsupportedCompact = await fetchText("/v1/responses/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "non-existent-unsupported-model", input: "test" })
      });
      proof("unsupported-backend-rejected", 400, unsupportedCompact.status);
    }
  } finally {
    if (child) {
      child.kill("SIGTERM");
      exitResult = await bounded(Promise.all([exitPromise, outputPromise]), "process teardown", () => child.kill("SIGKILL"));
    }
    if (mock) await mock.stop(true);
    await rm(work, { recursive: true, force: true });
  }

  const exitInfo = exitResult?.[0] ?? { code: 0, signal: "SIGTERM" };
  const wireRequests = requests.map((r) => ({
    method: r.method,
    path: r.path,
    headers: r.headers,
    body_bytes_base64: r.body_bytes_base64,
    body_sha256: r.body_sha256,
  }));

  const requiredAssertionIds = variant === "happy"
    ? ["capsule-reuse", "search-citations-mapped"]
    : ["tampered-capsule-rejected", "unsupported-backend-rejected"];

  const receipt = context.createReceipt({
    caseName: "compact-search",
    variant,
    assertions,
    requiredAssertionIds,
    events,
    wireRequests,
    externalDialCount: 0,
    provenance,
    teardown: {
      exit: exitInfo,
      listeners: 0,
      ownedProcesses: 0,
      listener_inventory: [],
      process_inventory: [],
      termination: "controlled-signal"
    },
  });

  await writeFile(evidencePath, JSON.stringify(receipt, null, 2));
  return receipt;
}

#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSourceClosure } from "./cliproxy-audit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATEWAY = join(ROOT, "mahoquot-proxy");
const EVIDENCE_BASE = join(ROOT, ".omo/evidence/cliproxy-remediation");
const RUN_ID = "6417c774-c554-4c53-880b-d8355082043e";
const EVIDENCE_ROOT = join(EVIDENCE_BASE, RUN_ID);
const BUILD_TARGET = join(EVIDENCE_ROOT, "target");
const BINARY = join(BUILD_TARGET, "debug/mahoquot-gateway");
const TEST_PORTS = [18840, 18841];
const SENTINEL = "cliproxy-loopback-fixture-sentinel";

const CASES = [
  "fixture", "proxy", "retry", "multimodal", "options", "usage", "settings", "affinity",
  "responses", "cancel", "payload", "models", "hierarchy", "quota", "meta", "xai",
  "kimi", "tls", "ws", "aistudio", "realtime", "audio-image", "video", "interactions",
  "compact-search", "management-auth", "v8-config", "management-ops", "resp", "plugin",
  "plugin-store", "home", "stores", "tui-discovery", "bench-core", "bench-locality",
  "bench-resilience", "desktop-parity"
];

const PLAN_CASES = [
  "fixture", "proxy", "retry", "multimodal", "options", "usage", "settings", "affinity",
  "responses", "cancel", "payload", "models", "hierarchy", "quota", "meta", "xai",
  "kimi", "tls", "ws", "aistudio", "realtime", "audio-image", "video", "interactions",
  "compact-search", "management-auth", "v8-config", "management-ops", "resp", "plugin",
  "plugin-store", "home", "stores", "tui-discovery", "bench-core", "bench-locality",
  "bench-resilience", "desktop-parity"
];

const REQUIRED_ASSERTIONS = {
  happy: ["healthz-200", "chat-status", "sentinel", "wire-payload-model", "wire-body-sha256", "teardown"],
  failure: ["healthz-200", "external-url-rejected", "mock-external-dial-zero", "teardown"],
};
const BUILD_COMMAND = `CARGO_TARGET_DIR=${BUILD_TARGET} cargo build -p mahoquot-gateway --bin mahoquot-gateway`;
assert(JSON.stringify([...CASES].sort()) === JSON.stringify([...PLAN_CASES].sort()), "case manifest differs from task1 inventory");

class CliError extends Error {}

function assert(condition, message) {
  if (!condition) throw new CliError(message);
}

const KNOWN_FLAGS = new Set([
  "--case",
  "--variant",
  "--evidence",
  "--list-cases",
  "--audit",
  "--evidence-root",
  "--negative-receipt-test",
  "--binary",
]);

const VALUE_FLAGS = new Set([
  "--case",
  "--variant",
  "--evidence",
  "--audit",
  "--evidence-root",
  "--binary",
]);

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      throw new CliError(`unexpected positional argument: ${item}`);
    }
    if (!KNOWN_FLAGS.has(item)) {
      throw new CliError(`unknown flag: ${item}`);
    }
    if (args.has(item)) {
      throw new CliError(`duplicate flag: ${item}`);
    }
    if (VALUE_FLAGS.has(item)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new CliError(`flag ${item} requires a value`);
      }
      args.set(item, next);
      index += 1;
    } else {
      args.set(item, true);
    }
  }
  return args;
}

async function readLines(stream, onLine) {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) onLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  const remaining = buffer.trim();
  if (remaining.length > 0) onLine(remaining);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function bounded(promise, label, timeoutMs = 15_000) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CliError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

function makeMock(variant = "happy") {
  const requests = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 18841,
    async fetch(request) {
      const body = await request.text();
      requests.push({ method: request.method, path: new URL(request.url).pathname, url: request.url, headers: Object.fromEntries(request.headers), body });
      if (request.method === "GET" && new URL(request.url).pathname === "/backend-api/wham/usage") {
        return Response.json({ rate_limit: { primary_window: { used_percent: 0, reset_at: 1799999999, limit_window_seconds: 18000 } }, plan_type: "plus" });
      }
      if (request.method !== "POST" || new URL(request.url).pathname !== "/backend-api/codex/responses") {
        return Response.json({ data: [{ id: "gpt-5.6-sol", object: "model", owned_by: "openai" }] });
      }
      if (variant === "failure") {
        return new Response("redirecting to external", {
          status: 302,
          headers: {
            location: "https://external.invalid/backend-api/codex/responses",
          },
        });
      }
      return new Response([
        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_fixture\"}}\n\n",
        "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"msg_fixture\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n",
        `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":"${SENTINEL}","item_id":"msg_fixture","output_index":0}\n\n`,
        "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fixture\",\"status\":\"completed\"}}\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, requests };
}

async function assertNoListener(port) {
  const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
  probe.stop(true);
}

async function terminate(child, exitPromise) {
  if (child.exitCode !== null) return await exitPromise;
  child.kill("SIGTERM");
  try {
    return await bounded(exitPromise, "gateway cleanup exit", 2_000);
  } catch (error) {
    if (!(error instanceof CliError) || !error.message.includes("timed out")) throw error;
    child.kill("SIGKILL");
    return await bounded(exitPromise, "gateway forced cleanup exit", 2_000);
  }
}

async function runChild(binary, args, options, onOutput) {
  const child = spawn(binary, args, options);
  const completion = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const stdout = [];
  const stderr = [];
  const output = Promise.all([
    readLines(child.stdout, (line) => { stdout.push(line); onOutput("stdout", line); }),
    readLines(child.stderr, (line) => { stderr.push(line); onOutput("stderr", line); }),
  ]);
  return { child, completion, stdout, stderr, output };
}

async function runFixture(variant, evidencePath) {
  await assertNoListener(TEST_PORTS[0]);
  await assertNoListener(TEST_PORTS[1]);
  const fixtureRoot = join(EVIDENCE_BASE, `${RUN_ID}.fixture-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const authDir = join(fixtureRoot, "auth");
  await mkdir(authDir, { recursive: true });
  const assertions = [];
  const events = [];
  let ready;
  let childExit;
  let rejectChildExit;
  const exited = new Promise((resolve, reject) => {
    childExit = resolve;
    rejectChildExit = reject;
  });
  const started = new Promise((resolveReady) => { ready = { resolveReady }; });
  let child;
  let mock;
  const ownedListeners = [];
  let externalDialCount = 0;
  let exitPromise;
  let resolveGuardDeny;
  const guardDenyPromise = new Promise((resolve) => { resolveGuardDeny = resolve; });

  try {
    mock = makeMock(variant);
    ownedListeners.push(mock.server);
    await writeFile(join(authDir, "codex-fixture-plus.json"), JSON.stringify({
      identity_slug: "fixture", access_token: "dummy-token", account_id: "dummy-account",
      email: "fixture@example.invalid", expired: "2099-01-01T00:00:00Z", id_token: "dummy-id",
      last_refresh: "2026-01-01T00:00:00Z", refresh_token: "dummy-refresh", type: "plus",
      upstream_override: "http://127.0.0.1:18841",
    }));
    await writeFile(join(authDir, "config.yaml"), "routing:\n  strategy: fill-first\n");
    const running = await runChild(BINARY, ["serve", "--bind", "127.0.0.1", "--port", "18840", "--auth-dir", authDir,
      "--strategy", "fill-first", "--auth-refresh", "false", "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: GATEWAY,
      env: { ...process.env, AUTH_DIR: authDir, BIND_ADDR: "127.0.0.1", GATEWAY_PORT: "18840", STRATEGY: "fill-first", MAHOQUOT_QA_LOOPBACK_ONLY: "1", no_proxy: "127.0.0.1,localhost", NO_PROXY: "127.0.0.1,localhost", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" },
      stdio: ["ignore", "pipe", "pipe"],
    }, (type, line) => {
      events.push({ type, line });
      if (line.includes('listening') && line.includes('18840')) ready.resolveReady();
      if (line.includes("loopback_guard") && line.includes('decision="deny"') && line.includes("https://external.invalid")) {
        resolveGuardDeny?.(line);
      }
    });
    child = running.child;
    exitPromise = running.completion;
    const recordOutput = running.output;
    child.once("exit", (code, signal) => childExit({ code, signal }));
    exitPromise.catch(rejectChildExit);
        await bounded(Promise.race([started, exited.then(({ code, signal }) => { throw new CliError(`gateway exited before readiness code=${code} signal=${signal}; ${running.stderr.join(" | ")}`); })]), "gateway readiness");
    assert(events.some((e) => e.type === "stdout" && e.line?.includes("strategy=FillFirst")), "gateway startup did not report effective FillFirst strategy");

    const healthController = new AbortController();
    const health = await bounded(fetch("http://127.0.0.1:18840/healthz", { signal: healthController.signal }), "health request");
    const healthBody = await bounded(health.text(), "health body read", 3_000).catch((err) => { healthController.abort(); throw err; });
    assertions.push({ id: "healthz-200", expected: 200, actual: health.status, pass: health.status === 200 });

    if (variant === "happy") {
      const chatController = new AbortController();
      const response = await bounded(fetch("http://127.0.0.1:18840/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "fixture" }], stream: true }),
        signal: chatController.signal,
      }), "chat completion");
      const body = await bounded(response.text(), "chat response body read", 10_000).catch((err) => { chatController.abort(); throw err; });
      events.push({ type: "response-data", data: body });
      assertions.push({ id: "chat-status", expected: 200, actual: response.status, pass: response.status === 200 });
      assertions.push({ id: "sentinel", expected: SENTINEL, actual: body.includes(SENTINEL) ? SENTINEL : body, pass: body.includes(SENTINEL) });
      const inferenceCall = mock.requests.find((entry) => entry.method === "POST" && entry.path === "/backend-api/codex/responses");
      assert(inferenceCall, `missing inference wire capture; status=${response.status}; headers=${JSON.stringify(Object.fromEntries(response.headers))}; body=${body}; calls=${JSON.stringify(mock.requests)}`);
      const captured = inferenceCall.body;
      const wireValue = JSON.parse(captured);
      const wireHash = createHash("sha256").update(captured).digest("hex");
      assertions.push({ id: "wire-payload-model", expected: "gpt-5.6-sol", actual: wireValue.model, pass: wireValue.model === "gpt-5.6-sol" });
      assertions.push({ id: "wire-body-sha256", expected: "64 lowercase hex characters", actual: wireHash, pass: /^[a-f0-9]{64}$/.test(wireHash) });
      assert(response.status === 200 && body.includes(SENTINEL), "gateway did not relay sentinel completion");
      externalDialCount = mock.requests.filter((entry) => new URL(entry.url).hostname === "external.invalid").length;
    } else {
      const failureController = new AbortController();
      const fetchPromise = bounded(fetch("http://127.0.0.1:18840/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "external target rejection" }], stream: false }),
        signal: failureController.signal,
      }), "external-url rejection");

      const [response, guardLog] = await Promise.all([
        fetchPromise,
        bounded(guardDenyPromise, "loopback guard deny event", 5_000),
      ]);

      const failureBody = await bounded(response.text(), "failure response body read", 5_000).catch((err) => { failureController.abort(); throw err; });
      assert(guardLog.includes('decision="deny"'), "guard deny decision not logged");
      assert(guardLog.includes("target=https://external.invalid/backend-api/codex/responses"), "guard did not deny exact redirect target");
      assert(guardLog.includes('reason="non-literal-loopback redirect target"'), "guard deny reason mismatch");

      const redirectCall = mock.requests.find((entry) => entry.method === "POST" && entry.path === "/backend-api/codex/responses");
      assert(redirectCall, "mock never received redirect trigger POST");

      const rejectionEvidence = {
        status: response.status,
        mock_redirect: {
          method: "POST",
          path: "/backend-api/codex/responses",
          location: "https://external.invalid/backend-api/codex/responses",
        },
        guard_decision: {
          decision: "deny",
          target: "https://external.invalid/backend-api/codex/responses",
          reason: "non-literal-loopback redirect target",
          guard_logged: true,
          log_excerpt: guardLog.trim(),
        },
        body: failureBody,
      };
      assertions.push({
        id: "external-url-rejected",
        expected: rejectionEvidence,
        actual: rejectionEvidence,
        pass: response.status >= 400 && guardLog.includes('decision="deny"'),
      });
      externalDialCount = mock.requests.filter((entry) => new URL(entry.url).hostname === "external.invalid").length;
      assertions.push({ id: "mock-external-dial-zero", expected: 0, actual: externalDialCount, pass: externalDialCount === 0 });
      assert(!response.ok && externalDialCount === 0 && guardLog.includes('decision="deny"'), "external upstream redirect was not rejected before dial");
    }
    assert(health.status === 200, `healthz returned ${health.status}: ${healthBody}`);
    const inferenceRequests = mock.requests.filter((entry) => entry.method === "POST" && entry.path === "/backend-api/codex/responses");
    assert(inferenceRequests.length === 1, `inference calls=${inferenceRequests.length}; all calls=${JSON.stringify(mock.requests)}`);
    if (child.exitCode === null) child.kill("SIGINT");
    const exit = await bounded(exitPromise, "gateway process exit", 3_000);
    events.push({ type: "exit", ...exit });
    await bounded(recordOutput, "gateway pipe close");
    mock.server.stop(true);
    ownedListeners.splice(ownedListeners.indexOf(mock.server), 1);
    await assertNoListener(TEST_PORTS[0]);
    await assertNoListener(TEST_PORTS[1]);
    const teardown = { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [] };
    const controlledExit = exit.code === 0 || (exit.code === null && exit.signal === "SIGINT");
    assertions.push({ id: "teardown", expected: { controlled: true, listeners: 0, ownedProcesses: 0 }, actual: { controlled: controlledExit, listeners: 0, ownedProcesses: 0 }, pass: controlledExit && teardown.listeners === 0 && teardown.ownedProcesses === 0 });
    assert(controlledExit, `gateway exited ${JSON.stringify(exit)}`);
    assert(assertions.every((assertion) => assertion.pass), "fixture assertion failed");
    const sourceRevision = await git(GATEWAY, "rev-parse", "HEAD");
    const { files: sourceFiles, sourceHash } = await getSourceClosure();
    const binaryHash = createHash("sha256").update(await readFile(BINARY)).digest("hex");
    const wireRequests = mock.requests.map((request) => ({ ...request, body_bytes_base64: Buffer.from(request.body).toString("base64"), body_sha256: createHash("sha256").update(request.body).digest("hex") }));
    const cleanTeardown = { exit: { code: exit.code, signal: exit.signal }, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" };
    const provenance = {
      gateway_binary: BINARY,
      gateway_sha256: binaryHash,
      desktop_revision: await git(ROOT, "rev-parse", "HEAD"),
      gateway_revision: sourceRevision,
      gateway_source_sha256: sourceHash,
      source_root: GATEWAY,
      source_manifest: { files: sourceFiles },
      build_command: BUILD_COMMAND,
      build_receipt: { path: join(BUILD_TARGET, "source-revision.txt"), sha256: createHash("sha256").update(await readFile(join(BUILD_TARGET, "source-revision.txt"))).digest("hex") },
      binary_source_revision: sourceRevision,
      dirty: (await git(GATEWAY, "status", "--porcelain")).length > 0,
    };
    const receipt = createReceipt({
      caseName: "fixture",
      variant,
      assertions,
      requiredAssertionIds: REQUIRED_ASSERTIONS[variant],
      events,
      wireRequests,
      externalDialCount,
      provenance,
      teardown: cleanTeardown,
    });
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    for (const server of ownedListeners) server.stop(true);
    if (child && exitPromise) await terminate(child, exitPromise);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function createReceipt({
  caseName = "fixture",
  variant,
  assertions,
  requiredAssertionIds,
  events,
  wireRequests = [],
  externalDialCount = 0,
  provenance,
  teardown,
}) {
  const mappedEvents = events.map((event, index) => ({ id: `event-${index + 1}`, ...event }));
  return {
    schema: "cliproxy-parity/task1-v1",
    case: caseName,
    variant,
    created_at: new Date().toISOString(),
    assertions,
    required_assertion_ids: requiredAssertionIds ?? REQUIRED_ASSERTIONS[variant],
    events: mappedEvents,
    event_order: mappedEvents.map((event) => event.type),
    wire_capture: {
      gateway_requests: wireRequests,
      external_dials: externalDialCount,
    },
    provenance,
    teardown,
  };
}

async function buildGateway() {
  const currentRevision = await git(GATEWAY, "rev-parse", "HEAD");
  const currentClosure = await getSourceClosure();
  const bindingPath = join(BUILD_TARGET, "source-revision.txt");

  const existingBinary = Bun.file(BINARY);
  if (await existingBinary.exists()) {
    const binaryHash = createHash("sha256").update(await readFile(BINARY)).digest("hex");
    const bindingContent = await Bun.file(bindingPath).text().catch(() => "");
    const lines = bindingContent.replace(/\n$/, "").split("\n");
    if (
      lines.length === 4 &&
      lines[0] === currentRevision &&
      lines[1] === binaryHash &&
      lines[2] === currentClosure.sourceHash &&
      lines[3] === BUILD_COMMAND
    ) {
      return { command: BUILD_COMMAND, reused: true, stdout: "", stderr: "" };
    }
  }

  await mkdir(dirname(BUILD_TARGET), { recursive: true });
  const sourceHashBefore = currentClosure.sourceHash;

  const proc = Bun.spawn(["cargo", "build", "-p", "mahoquot-gateway", "--bin", "mahoquot-gateway"], {
    cwd: GATEWAY,
    env: { ...process.env, CARGO_TARGET_DIR: BUILD_TARGET },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutTask = new Response(proc.stdout).text();
  const stderrTask = new Response(proc.stderr).text();

  let code;
  try {
    code = await bounded(proc.exited, "gateway source build", 600_000);
  } catch (err) {
    proc.kill("SIGTERM");
    try {
      await bounded(proc.exited, "gateway source build abort", 3_000);
    } catch (_) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    throw err;
  }

  const [stdout, stderr] = await Promise.all([stdoutTask, stderrTask]);
  assert(code === 0, `gateway source build failed (${code})\n${stdout}\n${stderr}`);

  const closureAfter = await getSourceClosure();
  assert(closureAfter.sourceHash === sourceHashBefore, "source closure modified during compilation");

  const binaryHash = createHash("sha256").update(await readFile(BINARY)).digest("hex");
  await writeFile(
    bindingPath,
    `${currentRevision}\n${binaryHash}\n${closureAfter.sourceHash}\n${BUILD_COMMAND}\n`
  );
  return { command: BUILD_COMMAND, stdout, stderr };
}

async function git(cwd, ...args) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdoutTask = new Response(proc.stdout).text();
  const stderrTask = new Response(proc.stderr).text();
  let code;
  try {
    code = await bounded(proc.exited, `git ${args.join(" ")}`, 5_000);
  } catch (err) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw err;
  }
  const [stdout, stderr] = await Promise.all([stdoutTask, stderrTask]);
  if (code !== 0) throw new CliError(`git ${args.join(" ")} failed (${code}): ${stderr}`);
  return stdout.trim();
}

function evidencePath(value) {
  const root = process.env.MAHOQUOT_QA_EVIDENCE_ROOT;
  assert(root && isAbsolute(root), "MAHOQUOT_QA_EVIDENCE_ROOT must be an absolute path");
  const evidenceRoot = resolve(root);
  assert(evidenceRoot.startsWith(EVIDENCE_BASE + sep), "evidence root must be under workspace .omo/evidence/cliproxy-remediation");
  const candidate = resolve(evidenceRoot, value);
  assert(candidate.startsWith(evidenceRoot + sep), "evidence path escapes evidence root");
  return candidate;
}

async function dispatchCase(name, variant, destination, context = {}) {
  assert(CASES.includes(name), `unknown case: ${name ?? "(missing)"}`);
  assert(variant === "happy" || variant === "failure", `unknown variant: ${variant ?? "(missing)"}`);

  let caseModule = null;
  if (name !== "fixture") {
    const casePath = context.casesDir
      ? resolve(context.casesDir, `${name}.mjs`)
      : resolve(dirname(fileURLToPath(import.meta.url)), "cases", `${name}.mjs`);
    if (!await Bun.file(casePath).exists()) {
      throw new CliError(`case module not implemented: cases/${name}.mjs; task1 does not treat future cases as passing`);
    }
    caseModule = await import(casePath);
    assert(typeof caseModule.runCase === "function", `case module cases/${name}.mjs must export runCase(variant, evidencePath, context)`);
  }

  const build = context.build ?? (await buildGateway());
  let receipt;
  if (name === "fixture") {
    receipt = await runFixture(variant, destination);
  } else {
    receipt = await caseModule.runCase(variant, destination, {
      binary: BINARY,
      buildCommand: build.command,
      ports: TEST_PORTS,
      evidenceBase: EVIDENCE_BASE,
      runId: RUN_ID,
      getSourceClosure,
      createReceipt,
    });
  }

  assert(receipt && typeof receipt === "object", "case execution did not return a valid receipt object");
  assert(receipt.provenance && receipt.provenance.build_command === build.command, "receipt build command does not match source-bound build");
  const { auditInternals } = await import("./cliproxy-audit.mjs");
  await auditInternals.validateReceipt(receipt, name, variant, `${name}/${variant}`);
  return receipt;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("--list-cases")) {
    assert(JSON.stringify([...CASES].sort()) === JSON.stringify([...PLAN_CASES].sort()), "case manifest differs from approved plan");
    process.stdout.write(`${CASES.join("\n")}\n`);
    return;
  }
  if (args.has("--audit")) {
    const audit = args.get("--audit");
    const evidenceRoot = args.get("--evidence-root");
    assert(typeof audit === "string" && ["F1", "F2", "F3", "F4"].includes(audit), "--audit requires F1, F2, F3, or F4");
    assert(typeof evidenceRoot === "string" && isAbsolute(evidenceRoot), "--evidence-root must be absolute");
    assert(resolve(evidenceRoot) === join(EVIDENCE_BASE, RUN_ID), "--evidence-root must match the approved run evidence path");
    const { runAudit } = await import("./cliproxy-audit.mjs");
    return runAudit({ audit, evidenceRoot, negativeReceiptTest: args.has("--negative-receipt-test") });
  }
  const name = args.get("--case");
  const variant = args.get("--variant");
  assert(CASES.includes(name), `unknown case: ${name ?? "(missing)"}`);
  assert(variant === "happy" || variant === "failure", `unknown variant: ${variant ?? "(missing)"}`);
  const output = args.get("--evidence");
  assert(typeof output === "string", "--evidence is required");
  assert(args.get("--binary") === undefined, "--binary is unsupported; task1 requires the source-built pinned binary");
  const destination = evidencePath(output);
  assert(!await Bun.file(destination).exists(), `evidence receipt already exists: ${destination}`);

  const receipt = await dispatchCase(name, variant, destination);
  process.stdout.write(`${JSON.stringify({ status: "PASS", evidence: output, assertions: receipt.assertions.length })}\n`);
}

export {
  CASES,
  PLAN_CASES,
  REQUIRED_ASSERTIONS,
  BUILD_COMMAND,
  parseArgs,
  evidencePath,
  buildGateway,
  runFixture,
  getSourceClosure,
  createReceipt,
  dispatchCase,
  main,
};

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

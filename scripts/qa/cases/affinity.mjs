import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORTS = [18860, 18861];
const SESSIONS = { route: "route-affinity-session", model: "model-affinity-session", caller: "caller-affinity-session", remove: "remove-affinity-session" };
const ROUTING_HEADERS = ["x-session-id", "x-client-request-id"];
const SENTINEL = "affinity-wire-sentinel";

class CaseError extends Error {}

function assert(condition, message) {
  if (!condition) throw new CaseError(message);
}

function bounded(promise, label, timeoutMs = 15_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CaseError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function requestText(url, options, label, timeoutMs = 15_000, controller = new AbortController()) {
  let timer;
  try {
    const operation = (async () => {
      const response = await fetch(url, { ...options, redirect: "error", proxy: "", signal: controller.signal });
      return { response, text: await response.text() };
    })();
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CaseError(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function observeLine(stream, predicate, timeoutMs = 15_000) {
  const found = deferred();
  let buffer = "";
  stream.setEncoding("utf8");
  const timer = setTimeout(() => found.reject(new CaseError("gateway readiness timed out")), timeoutMs);
  const onData = (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trimEnd();
      buffer = buffer.slice(index + 1);
      if (line && predicate(line)) found.resolve(line);
    }
  };
  stream.on("data", onData);
  return found.promise.finally(() => {
    clearTimeout(timer);
    stream.off("data", onData);
  });
}

function lineReader(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trimEnd();
      buffer = buffer.slice(at + 1);
      if (line) onLine(line);
    }
  });
  stream.on("end", () => { if (buffer.trim()) onLine(buffer.trim()); });
}

async function assertPortFree(port) {
  try {
    const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    listener.stop(true);
  } catch (error) {
    throw new CaseError(`reserved port ${port} is already occupied: ${error.message}`);
  }
}

async function terminate(child, exitPromise) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return exitPromise;
  child.kill("SIGTERM");
  try {
    return await bounded(exitPromise, "gateway termination", 2_000);
  } catch (error) {
    if (!(error instanceof CaseError) || !error.message.includes("timed out")) throw error;
    child.kill("SIGKILL");
    return await bounded(exitPromise, "gateway forced termination", 2_000);
  }
}

async function git(cwd, ...args) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  try {
    const [code, stdout, stderr] = await bounded(Promise.all([proc.exited, out, err]), `git ${args.join(" ")}`, 5_000);
    if (code !== 0) throw new CaseError(`git ${args.join(" ")} failed (${code}): ${stderr}`);
    return stdout.trim();
  } finally {
    if (proc.exitCode === null) proc.kill();
    await bounded(proc.exited, "git cleanup", 2_000);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function accountFile(label, provider, token, upstream) {
  const common = {
    identity_slug: label,
    email: `${label}@affinity.invalid`,
    upstream_override: upstream,
    type: provider,
  };
  if (provider === "claude") {
    return { ...common, api_key: token };
  }
  return {
    ...common,
    access_token: token,
    refresh_token: `refresh-${label}`,
    expired: "2099-01-01T00:00:00Z",
    account_id: `account-${label}`,
    id_token: `id-${label}`,
    last_refresh: "2026-01-01T00:00:00Z",
  };
}

export async function runCase(variant, evidencePath, context) {
  assert(variant === "happy" || variant === "failure", `unknown affinity variant: ${variant}`);
  const ports = context.ports ?? PORTS;
  const gatewayPort = ports[0] ?? PORTS[0];
  const mockPort = ports[1] ?? PORTS[1];
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const gatewayRoot = join(root, "mahoquot-proxy");
  const runKey = `${context.runId ?? "affinity"}.affinity-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fixtureRoot = join(context.evidenceBase, runKey);
  const authDir = join(fixtureRoot, "auth");
  const upstream = `http://127.0.0.1:${mockPort}`;
  const events = [];
  const wireRequests = [];
  const ownedServers = [];
  const pending = new Map();
  const activeRequests = new Set();
  let readyPromise;
  let child;
  let exitPromise;
  let pipePromise;
  let exit = { code: null, signal: null };
  const note = (type, detail = {}) => events.push({ type, ...detail });

  try {
    await assertPortFree(gatewayPort);
    await assertPortFree(mockPort);
    await mkdir(authDir, { recursive: true });
    await mkdir(join(fixtureRoot, "cache"), { recursive: true });

    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: mockPort,
      async fetch(request) {
        const url = new URL(request.url);
        const reader = request.body?.getReader();
        const chunks = [];
        let size = 0;
        try {
          if (reader) await bounded((async () => {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              assert(size <= 1_048_576, "mock request body exceeded 1 MiB");
              chunks.push(Buffer.from(value));
            }
          })(), "mock request body", 5_000);
        } finally {
          if (reader) {
            await bounded(reader.cancel(), "mock body cancellation", 2_000);
            reader.releaseLock();
          }
        }
        const raw = Buffer.concat(chunks);
        const headers = Object.fromEntries(request.headers);
        const matchedAccounts = ["tok-affinity-a1", "tok-affinity-a2", "tok-affinity-b1"].filter((token) => Object.values(headers).some((value) => value.includes(token)));
        if (matchedAccounts.length !== 1) throw new CaseError(`upstream request matched ${matchedAccounts.length} known fixture credentials`);
        const account = matchedAccounts[0];
        if (url.pathname.includes("usage")) return Response.json({ rate_limits: {} });
        const payload = JSON.parse(raw.toString("utf8"));
        const messages = payload.messages ?? payload.input;
        const texts = Array.isArray(messages) ? messages.flatMap((message) =>
          typeof message.content === "string" ? [message.content] :
            (message.content ?? []).filter((part) => typeof part.text === "string").map((part) => part.text)) : [];
        const labels = [...pending.keys()].filter((label) => texts.includes(`affinity ${label}`));
        assert(labels.length === 1, `upstream payload matched ${labels.length} pending requests`);
        const requestLabel = labels[0];
        const captured = {
          method: request.method,
          path: url.pathname,
          headers,
          account,
          label: requestLabel,
          model: payload.model,
          body: raw.toString("utf8"),
          body_bytes_base64: raw.toString("base64"),
          body_sha256: sha256(raw),
        };
        wireRequests.push(captured);
        note("upstream-captured", { label: requestLabel, account, model: payload.model });
        pending.get(requestLabel).resolve(captured);
        if (url.pathname === "/v1/messages") {
          return new Response(
            `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_${account}","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${SENTINEL}"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
            { headers: { "content-type": "text/event-stream" } }
          );
        }
        const frames = [
          `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_${account}"}}\n\n`,
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":"${SENTINEL}","item_id":"msg_${account}","output_index":0}\n\n`,
          `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_${account}","status":"completed"}}\n\n`,
        ];
        const subscription = pending.get(requestLabel);
        if (subscription.cancelled) {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frames.slice(0, 2).join("")));
              note("upstream-body-held", { label: requestLabel });
            },
            cancel() {
              note("upstream-body-cancelled", { label: requestLabel });
              subscription.cancelled.resolve();
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    ownedServers.push(mock);
    note("mock-listening", { port: mockPort });

    const accounts = [
      ["codex-a1", "codex", "tok-affinity-a1"],
      ["codex-a2", "codex", "tok-affinity-a2"],
      ["claude-b1", "claude", "tok-affinity-b1"],
    ];
    for (const [name, provider, token] of accounts) {
      await Bun.write(join(authDir, `${name}.json`), JSON.stringify(accountFile(name, provider, token, upstream), null, 2));
    }
    await Bun.write(join(authDir, "config.yaml"), "routing:\n  strategy: fill-first\nremote-management:\n  secret-key: affinity-management-secret\nmodel-catalog:\n  refresh-enabled: false\n");

    const env = {
      ...process.env,
      API_KEYS: "caller-one,caller-two",
      AUTH_DIR: authDir,
      BIND_ADDR: "127.0.0.1",
      GATEWAY_PORT: String(gatewayPort),
      STRATEGY: "fill-first",
      MAHOQUOT_QA_LOOPBACK_ONLY: "1",
      MAHOQUOT_CACHE_DIR: join(fixtureRoot, "cache"),
      no_proxy: "127.0.0.1,localhost",
      NO_PROXY: "127.0.0.1,localhost",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
    };
    delete env.MAHOQUOT_API_KEYS;

    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(gatewayPort), "--auth-dir", authDir, "--config", join(authDir, "config.yaml"), "--strategy", "fill-first", "--auth-refresh", "false", "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: gatewayRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    readyPromise = observeLine(child.stdout, (line) => line.includes("listening") && line.includes(String(gatewayPort)));
    exitPromise = new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    const stderr = [];
    const stdoutDone = new Promise((resolveDone, rejectDone) => {
      lineReader(child.stdout, (line) => {
        events.push({ type: "stdout", line });
      });
      child.stdout.once("end", resolveDone);
      child.stdout.once("error", rejectDone);
    });
    const stderrDone = new Promise((resolveDone, rejectDone) => {
      lineReader(child.stderr, (line) => {
        stderr.push(line);
        events.push({ type: "stderr", line });
      });
      child.stderr.once("end", resolveDone);
      child.stderr.once("error", rejectDone);
    });
    pipePromise = Promise.all([stdoutDone, stderrDone]);
    await bounded(Promise.race([
      readyPromise,
      exitPromise.then((result) => { throw new CaseError(`gateway exited before ready: ${JSON.stringify(result)} ${stderr.join(" | ")}`); }),
    ]), "gateway readiness");

    const health = await requestText(`http://127.0.0.1:${gatewayPort}/healthz`, {}, "healthz");
    assert(health.response.status === 200, `healthz returned ${health.response.status}`);

    const catalogResponse = await requestText(`http://127.0.0.1:${gatewayPort}/v1/models`, { headers: { authorization: "Bearer caller-one" } }, "model catalog");
    assert(catalogResponse.response.status === 200, `model catalog returned ${catalogResponse.response.status}`);
    const catalog = JSON.parse(catalogResponse.text).data ?? [];
    const modelsByOwner = new Map();
    for (const entry of catalog) {
      if (typeof entry.id !== "string" || typeof entry.owned_by !== "string") continue;
      const group = modelsByOwner.get(entry.owned_by) ?? [];
      group.push(entry.id);
      modelsByOwner.set(entry.owned_by, group);
    }
    const codexModels = modelsByOwner.get("openai");
    const claudeModels = modelsByOwner.get("anthropic");
    assert(codexModels?.length >= 2 && claudeModels?.length >= 1, "runtime catalog must expose two Codex-backed models and one Claude-backed model");
    const MODEL_A = codexModels[0];
    const MODEL_A_SIBLING = codexModels[1];
    const MODEL_B = claudeModels[0];
    const call = async ({ model, session, caller, label }) => {
      const capturedSignal = deferred();
      const controller = new AbortController();
      activeRequests.add(controller);
      pending.set(label, capturedSignal);
      note("wire-subscribed", { label, session, model });
      const body = { model, messages: [{ role: "user", content: `affinity ${label}` }] };
      body.stream = true;
      const headers = { "content-type": "application/json", "x-session-id": session, "x-client-request-id": label };
      headers.authorization = `Bearer ${caller ?? "caller-one"}`;
      try {
        note("request-trigger", { label, headers, model });
        const responsePromise = requestText(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) }, `request ${label}`, 15_000, controller);
        const [captured, result] = await bounded(Promise.all([capturedSignal.promise, responsePromise]), `wire and response ${label}`);
        assert(result.response.status === 200 && result.text.includes(SENTINEL), `${label}: expected successful sentinel response, got ${result.response.status}`);
        note("request-complete", { label, status: result.response.status, account: captured.account, model, body: result.text });
        return { status: result.response.status, body: result.text, account: captured.account, captured };
      } finally {
        controller.abort();
        activeRequests.delete(controller);
        pending.delete(label);
      }
    };

    const setEnabled = async (name, enabled) => {
      const result = await requestText(`http://127.0.0.1:${gatewayPort}/v0/management/auth-files/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer affinity-management-secret" },
        body: JSON.stringify({ action: enabled ? "enable" : "disable", names: [`${name}.json`] }),
      }, `account ${name} ${enabled ? "enable" : "disable"}`);
      assert(result.response.ok, `account toggle failed HTTP ${result.response.status}: ${result.text}`);
      const ack = JSON.parse(result.text);
      assert(ack.status === "ok" && ack.changed === 1, `account toggle did not acknowledge one changed fixture: ${result.text}`);
      note("account-rescan-ack", { name, enabled, status: result.response.status, ack });
    };

    const assertions = [];
    if (variant === "happy") {
      await setEnabled("codex-a1", false);
      const routeA1 = await call({ model: MODEL_A, session: SESSIONS.route, label: "route-a-first" });
      await setEnabled("codex-a1", true);
      const routeB = await call({ model: MODEL_B, session: SESSIONS.route, label: "route-b" });
      const routeA2 = await call({ model: MODEL_A, session: SESSIONS.route, label: "route-a-restored" });

      const modelFirst = await call({ model: MODEL_A, session: SESSIONS.model, label: "model-first" });
      await setEnabled("codex-a1", false);
      const modelRebound = await call({ model: MODEL_A, session: SESSIONS.model, label: "model-rebound" });
      await setEnabled("codex-a1", true);
      const modelSibling = await call({ model: MODEL_A_SIBLING, session: SESSIONS.model, label: "model-sibling" });

      const callerOneFirst = await call({ model: MODEL_A, session: SESSIONS.caller, caller: "caller-one", label: "caller-one-first" });
      await setEnabled("codex-a1", false);
      const callerOneRebound = await call({ model: MODEL_A, session: SESSIONS.caller, caller: "caller-one", label: "caller-one-rebound" });
      await setEnabled("codex-a1", true);
      const callerTwo = await call({ model: MODEL_A, session: SESSIONS.caller, caller: "caller-two", label: "caller-two" });
      const callerOneAgain = await call({ model: MODEL_A, session: SESSIONS.caller, caller: "caller-one", label: "caller-one-again" });

      // A distinct session and a delimiter-bearing session must not inherit A2.
      const otherSession = await call({ model: MODEL_A, session: `${SESSIONS.caller}|\"branch`, label: "session-delimiter" });
      const originalSession = await call({ model: MODEL_A, session: SESSIONS.caller, label: "session-original" });

      const expected = {
        routeA_unavailable: "tok-affinity-a2", routeB: "tok-affinity-b1", routeA_restored: "tok-affinity-a2",
        modelFirst: "tok-affinity-a1", modelRebound: "tok-affinity-a2", modelSibling: "tok-affinity-a2",
        callerOneFirst: "tok-affinity-a1", callerOneRebound: "tok-affinity-a2", callerTwo: "tok-affinity-a1", callerOneAgain: "tok-affinity-a2",
        otherSession: "tok-affinity-a1", originalSession: "tok-affinity-a2",
      };
      const actual = {
        routeA_unavailable: routeA1.account, routeB: routeB.account, routeA_restored: routeA2.account,
        modelFirst: modelFirst.account, modelRebound: modelRebound.account, modelSibling: modelSibling.account,
        callerOneFirst: callerOneFirst.account, callerOneRebound: callerOneRebound.account, callerTwo: callerTwo.account, callerOneAgain: callerOneAgain.account,
        otherSession: otherSession.account, originalSession: originalSession.account,
      };
      const allOk = [routeA1, routeB, routeA2, modelFirst, modelRebound, modelSibling, callerOneFirst, callerOneRebound, callerTwo, callerOneAgain].every((item) => item.status === 200 && item.body.includes(SENTINEL));
      assertions.push({ id: "route-binding-restored", expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual) && allOk });
    } else {
      const malformedBoundary = wireRequests.length;
      note("malformed-json-trigger", { body: "{", session: SESSIONS.remove });
      const malformed = await requestText(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer caller-one", "x-session-id": SESSIONS.remove, "x-client-request-id": "malformed-json" }, body: "{",
      }, "malformed JSON rejection");
      assert(malformed.response.status === 400 && wireRequests.length === malformedBoundary, "malformed JSON must return 400 without inference capture");
      note("malformed-json-rejected", { status: malformed.response.status, body: malformed.text, captures_before: malformedBoundary, captures_after: wireRequests.length });
      const beforeRemoval = await call({ model: MODEL_A, session: SESSIONS.remove, label: "remove-first" });
      await setEnabled("codex-a1", false);
      const boundToA2 = await call({ model: MODEL_A, session: SESSIONS.remove, label: "remove-bind-a2" });
      await setEnabled("codex-a1", true);

      await unlink(join(authDir, "codex-a2.json"));
      note("account-file-removed", { name: "codex-a2" });
      await setEnabled("codex-a1", true);
      const removalBoundary = wireRequests.length;
      const afterRemoval = await call({ model: MODEL_A, session: SESSIONS.remove, label: "remove-after" });
      const postRemovalA2 = wireRequests.slice(removalBoundary).filter((entry) => entry.account === "tok-affinity-a2").length;
      // Reintroduce the same account ID: a purged pin must not resurrect.
      await Bun.write(join(authDir, "codex-a2.json"), JSON.stringify(accountFile("codex-a2", "codex", "tok-affinity-a2", upstream)));
      await setEnabled("codex-a2", true);
      const afterReadd = await call({ model: MODEL_A, session: SESSIONS.remove, label: "remove-readd" });
      const siblingAfterReadd = await call({ model: MODEL_A_SIBLING, session: SESSIONS.remove, label: "remove-readd-sibling" });

      // Subscribe before opening an intentionally non-terminating SSE body.
      // Cancellation is triggered by actual downstream bytes, never a delay.
      const heldLabel = "cancel-held-body";
      const held = deferred();
      held.cancelled = deferred();
      pending.set(heldLabel, held);
      const heldController = new AbortController();
      activeRequests.add(heldController);
      note("cancel-subscribed", { label: heldLabel });
      let heldReader;
      let deadline;
      try {
        deadline = setTimeout(() => heldController.abort(), 5_000);
        note("request-trigger", { label: heldLabel, model: MODEL_A });
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
          method: "POST", proxy: "", redirect: "error", signal: heldController.signal,
          headers: { "content-type": "application/json", authorization: "Bearer caller-one", "x-session-id": SESSIONS.remove, "x-client-request-id": heldLabel },
          body: JSON.stringify({ model: MODEL_A, messages: [{ role: "user", content: `affinity ${heldLabel}` }], stream: true }),
        });
        assert(response.status === 200 && response.body, "held response must expose a successful streaming body");
        heldReader = response.body.getReader();
        const [captured, first] = await bounded(Promise.all([held.promise, heldReader.read()]), "held upstream and downstream bytes", 5_000);
        assert(captured.account === "tok-affinity-a1" && !first.done && first.value.byteLength > 0, "held request must reach pinned account and emit bytes");
        note("downstream-body-observed", { label: heldLabel, bytes_base64: Buffer.from(first.value).toString("base64") });
        clearTimeout(deadline);
        note("client-cancel-trigger", { label: heldLabel });
        await bounded(heldReader.cancel(), "downstream held body cancel", 2_000);
        heldController.abort();
        await bounded(held.cancelled.promise, "upstream held body cancellation", 5_000);
      } finally {
        clearTimeout(deadline);
        if (heldReader) heldReader.releaseLock();
        heldController.abort();
        activeRequests.delete(heldController);
        pending.delete(heldLabel);
      }
      const resumed = await call({ model: MODEL_A, session: SESSIONS.remove, label: "cancel-resumed" });
      assert(resumed.account === "tok-affinity-a1", "cancel/resume must retain eligible route binding");
      const expected = { first: "tok-affinity-a1", pin: "tok-affinity-a2", after: "tok-affinity-a1", readd: "tok-affinity-a1", sibling: "tok-affinity-a1", removed_account_requests_after: 0, status: 200 };
      const actual = { first: beforeRemoval.account, pin: boundToA2.account, after: afterRemoval.account, readd: afterReadd.account, sibling: siblingAfterReadd.account, removed_account_requests_after: postRemovalA2, status: afterRemoval.status };
      assertions.push({ id: "removed-binding-evicted", expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual) && afterRemoval.body.includes(SENTINEL) });
    }

    const leaked = wireRequests.flatMap((request) => ROUTING_HEADERS.filter((header) => request.headers[header] !== undefined).map((header) => ({ account: request.account, label: request.label, header, value: request.headers[header] })));
    assert(wireRequests.length > 0 && leaked.length === 0, `ingress headers reached mock: ${JSON.stringify(leaked)}`);
    if (variant === "happy") assertions.push({ id: "routing-header-not-forwarded", expected: [], actual: leaked, pass: true });

    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    exit = await bounded(exitPromise, "gateway exit", 5_000);
    note("gateway-exit", exit);
    await bounded(pipePromise, "gateway pipe close", 5_000);
    for (const server of ownedServers) server.stop(true);
    ownedServers.length = 0;
    await assertPortFree(gatewayPort);
    await assertPortFree(mockPort);
    note("owned-resources-released", { exit, ports: [gatewayPort, mockPort] });

    const { files, sourceHash } = await context.getSourceClosure();
    const gatewayRevision = await git(gatewayRoot, "rev-parse", "HEAD");
    const desktopRevision = await git(root, "rev-parse", "HEAD");
    const binaryHash = sha256(await readFile(context.binary));
    const buildReceiptPath = join(context.evidenceBase, context.runId, "target/source-revision.txt");
    const buildReceipt = await readFile(buildReceiptPath);
    const provenance = {
      gateway_binary: context.binary,
      gateway_sha256: binaryHash,
      desktop_revision: desktopRevision,
      gateway_revision: gatewayRevision,
      gateway_source_sha256: sourceHash,
      source_root: gatewayRoot,
      source_manifest: { files },
      build_command: context.buildCommand,
      build_receipt: { path: buildReceiptPath, sha256: sha256(buildReceipt) },
      binary_source_revision: buildReceipt.toString("utf8").trim().split("\n")[0],
      dirty: (await git(gatewayRoot, "status", "--porcelain")).length > 0,
    };
    const receipt = context.createReceipt({
      caseName: "affinity",
      variant,
      assertions,
      requiredAssertionIds: variant === "happy" ? ["route-binding-restored", "routing-header-not-forwarded"] : ["removed-binding-evicted"],
      events,
      wireRequests: wireRequests.map((request) => ({ ...request, request_bytes: Buffer.from(request.body).length })),
      externalDialCount: null,
      provenance,
      teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" },
    });
    // No socket-level external-dial observer exists in this case. Do not turn
    // loopback configuration or mock-local captures into a measured zero.
    delete receipt.wire_capture.external_dials;
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } catch (error) {
    console.error(JSON.stringify({ error: String(error), events }, null, 2));
    throw error;
  } finally {
    for (const controller of activeRequests) controller.abort();
    pending.clear();
    try {
      if (child && exitPromise) exit = await terminate(child, exitPromise);
      if (pipePromise) await bounded(pipePromise, "gateway pipe cleanup", 5_000);
    } finally {
      for (const server of ownedServers) server.stop(true);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
}

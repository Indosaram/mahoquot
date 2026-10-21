import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const SENTINEL = "cliproxy-loopback-models-sentinel";

class CliError extends Error {}

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

async function boundedFetchBody(input, init, label, readBody, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CliError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = await readBody(response);
    return { response, body };
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? error;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

async function fetchJson(input, init, label, timeoutMs = 15_000) {
  return boundedFetchBody(input, init, label, (response) => response.json(), timeoutMs);
}

async function fetchText(input, init, label, timeoutMs = 15_000) {
  return boundedFetchBody(input, init, label, (response) => response.text(), timeoutMs);
}

async function assertNoListener(port) {
  const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
  probe.stop(true);
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

function runChild(binary, args, options, onOutput, ownedChildren) {
  const child = spawn(binary, args, options);
  const completion = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const stdout = [];
  const stderr = [];
  const output = Promise.all([
    readLines(child.stdout, (line) => { stdout.push(line); onOutput("stdout", line); }),
    readLines(child.stderr, (line) => { stderr.push(line); onOutput("stderr", line); }),
  ]);
  const running = { child, completion, closed, stdout, stderr, output };
  ownedChildren.push(running);
  for (const promise of [completion, closed, output]) promise.catch(() => {});
  return running;
}

async function terminate(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return await bounded(exitPromise, "completed gateway cleanup exit", 2_000);
  }
  child.kill("SIGTERM");
  try {
    return await bounded(exitPromise, "gateway cleanup exit", 2_000);
  } catch (error) {
    child.kill("SIGKILL");
    return await bounded(exitPromise, "gateway forced cleanup exit", 2_000);
  }
}

function makeMock(port, variant = "happy") {
  const requests = [];
  const abortObserved = createDeferred();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      if (new URL(request.url).pathname === "/deadline-probe") {
        return new Response(new ReadableStream({
          cancel() {
            abortObserved.resolve({ path: new URL(request.url).pathname });
          },
        }), { headers: { "content-type": "application/json" } });
      }
      const body = await request.text();
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body,
      });
      const urlPath = new URL(request.url).pathname;
      if (request.method === "GET" && urlPath === "/v1/models") {
        return Response.json({
          models: [{ name: "models/claude-sonnet-4-6", displayName: "claude-sonnet-4-6" }],
        });
      }
      if (request.method === "GET" && urlPath === "/backend-api/wham/usage") {
        return Response.json({
          rate_limit: { primary_window: { used_percent: 0, reset_at: 1799999999, limit_window_seconds: 18000 } },
          plan_type: "plus",
        });
      }

      if (request.method === "POST" && urlPath === "/backend-api/codex/responses") {
        return new Response([
          "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_models\"}}\n\n",
          "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"msg_models\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n",
          `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":"${SENTINEL}","item_id":"msg_models","output_index":0}\n\n`,
          "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_models\",\"status\":\"completed\"}}\n\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }

      return Response.json({ status: "ok" });
    },
  });
  return { server, requests, abortObserved };
}

export function validateAuxiliaryAssertions(variant, assertions) {
  const required = variant === "happy"
    ? ["fetch-deadline-aborts-upstream", "repeated-interruption-incarnations"]
    : ["fetch-deadline-aborts-upstream", "scoped-collection-hides-model", "account-removal-detail-before", "account-removal-detail", "account-removal-detail-transition", "account-removal-collection-before", "account-removal-collection-after", "account-removal-collection-transition", "account-removal-detail-error-shape", "missing-model-detail", "repeated-interruption-incarnations"];
  assert(variant === "happy" || variant === "failure", "unknown models variant");
  assert.deepStrictEqual(assertions.map((entry) => entry.id).sort(), [...required].sort(), "models auxiliary assertion inventory mismatch");
  for (const entry of assertions) {
    assert.equal(entry.pass, true, `models auxiliary assertion failed: ${entry.id}`);
    if (entry.id === "repeated-interruption-incarnations") {
      assert.equal(entry.actual.length, entry.expected.incarnations);
      assert.deepStrictEqual(entry.actual.map((item) => item.incarnation), [1, 2]);
      for (const item of entry.actual) {
        assert(item.ready && item.accepted && item.pipes_closed);
        assert.equal(item.binary_sha256, entry.expected.binary_sha256);
        assert.equal(item.health_status, entry.expected.health_status);
        assert.equal(item.signal, entry.expected.signal);
        assert.equal(item.port_released, entry.expected.port_released);
        assert(item.exit.code === 0 || (item.exit.code === null && item.exit.signal === "SIGINT"));
      }
    } else {
      assert.deepStrictEqual(entry.actual, entry.expected, `models auxiliary assertion mismatch: ${entry.id}`);
    }
  }
}

export async function finalizeReceipt(records, createReceipt, publish) {
  const { variant, assertions } = records;
  const requiredAssertionIds = variant === "happy" ? ["detail-matches-catalog"] : ["hidden-or-removed-model-404"];
  const requiredAssertions = assertions.filter((entry) => requiredAssertionIds.includes(entry.id));
  assert.deepStrictEqual(requiredAssertions.map((entry) => entry.id), requiredAssertionIds, "models frozen assertion inventory mismatch");
  for (const entry of requiredAssertions) {
    assert.equal(entry.pass, true, `models frozen assertion failed: ${entry.id}`);
    assert.deepStrictEqual(entry.actual, entry.expected, `models frozen assertion mismatch: ${entry.id}`);
  }
  const auxiliaryAssertions = assertions.filter((entry) => !requiredAssertionIds.includes(entry.id));
  validateAuxiliaryAssertions(variant, auxiliaryAssertions);
  const receipt = createReceipt({ ...records, caseName: "models", assertions: requiredAssertions, requiredAssertionIds });
  receipt.auxiliary_assertions = auxiliaryAssertions;
  await publish(receipt);
  return receipt;
}

export async function runCase(variant, evidencePath, context) {
  const [gatewayPort, mockPort] = context.ports;
  await assertNoListener(gatewayPort);
  await assertNoListener(mockPort);

  const fixtureRoot = join(context.evidenceBase, `${context.runId}.models-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const authDir = join(fixtureRoot, "auth");
  const cacheDir = join(fixtureRoot, "cache");
  const configPath = join(authDir, "config.yaml");
  await mkdir(authDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  const assertions = [];
  const events = [];
  const ownedChildren = [];
  const interruptions = [];
  let mock;
  const ownedListeners = [];
  let externalDialCount = 0;

  try {
    mock = makeMock(mockPort, variant);
    ownedListeners.push(mock.server);
    let deadlineError;
    try {
      await boundedFetchBody(
        `http://127.0.0.1:${mockPort}/deadline-probe`,
        { method: "POST" },
        "response body abort probe",
        (response) => response.text(),
        100,
      );
    } catch (error) {
      deadlineError = error;
    }
    assert(deadlineError, "response body deadline probe unexpectedly completed");
    assert.match(String(deadlineError), /timed out/i, "deadline probe must reject with its timeout reason");
    const cancellation = await bounded(mock.abortObserved.promise, "mock observes response-body cancellation", 2_000);
    assert.equal(cancellation.path, "/deadline-probe", "deadline cancellation must come from the designated probe request");
    assertions.push({
      id: "fetch-deadline-aborts-upstream",
      expected: { path: "/deadline-probe", event: "response-body cancellation" },
      actual: { path: cancellation.path, event: "response-body cancellation" },
      pass: cancellation.path === "/deadline-probe",
    });

    await writeFile(join(authDir, "codex-fixture-plus.json"), JSON.stringify({
      identity_slug: "fixture",
      access_token: "dummy-token",
      account_id: "dummy-account",
      email: "fixture@example.invalid",
      expired: "2099-01-01T00:00:00Z",
      id_token: "dummy-id",
      last_refresh: "2026-01-01T00:00:00Z",
      refresh_token: "dummy-refresh",
      type: "plus",
      upstream_override: `http://127.0.0.1:${mockPort}`,
    }));

    await writeFile(join(authDir, "claude-fixture.json"), JSON.stringify({
      identity_slug: "claude-fixture",
      access_token: "sk-ant-dummy",
      email: "claude@example.invalid",
      expired: "2099-01-01T00:00:00Z",
      type: "claude",
      upstream_override: `http://127.0.0.1:${mockPort}`,
    }));

    const rawScopedKey = "sk-scoped-user-test";
    const scopedKeyIdent = createHash("sha256").update(rawScopedKey).digest("hex");

    await writeFile(configPath, [
      "model-catalog:",
      "  refresh-enabled: false",
      "routing:",
      "  strategy: fill-first",
      `auth-dir: ${authDir}`,
      "remote-management:",
      "  secret-key: test-admin-secret",
      "api-keys:",
      "  - test-admin",
      "scoped-api-keys:",
      "  - id: scoped-user-1",
      "    name: scoped-test",
      `    key_identifier: ${scopedKeyIdent}`,
      "    key_prefix: sk-scoped",
      `    raw_key: ${rawScopedKey}`,
      "    allowed_models:",
      "      - gpt-5.6-sol",
      "    is_active: true",
    ].join("\n") + "\n");

    const rootDir = resolve(fileURLToPath(import.meta.url), "../../../..");
    const gatewayDir = join(rootDir, "mahoquot-proxy");

    const binaryHash = createHash("sha256").update(await readFile(context.binary)).digest("hex");
    const gatewayArgs = [
      "serve",
      "--bind", "127.0.0.1",
      "--port", String(gatewayPort),
      "--auth-dir", authDir,
      "--config", configPath,
      "--strategy", "fill-first",
      "--auth-refresh", "false",
      "--usage-poll-secs", "3600",
      "--log-level", "info",
    ];
    const gatewayOptions = {
      cwd: gatewayDir,
      env: {
        ...process.env,
        AUTH_DIR: authDir,
        MAHOQUOT_CACHE_DIR: cacheDir,
        BIND_ADDR: "127.0.0.1",
        GATEWAY_PORT: String(gatewayPort),
        STRATEGY: "fill-first",
        MAHOQUOT_QA_LOOPBACK_ONLY: "1",
        no_proxy: "127.0.0.1,localhost",
        NO_PROXY: "127.0.0.1,localhost",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    };
    const launch = async (incarnation) => {
      const launchHash = createHash("sha256").update(await readFile(context.binary)).digest("hex");
      assert.equal(launchHash, binaryHash, "gateway binary must not change between incarnations");
      const started = createDeferred();
      const running = runChild(context.binary, gatewayArgs, gatewayOptions, (type, line) => {
        events.push({ id: `evt-${events.length + 1}`, type, incarnation, line });
        if (line.includes("listening") && line.includes(String(gatewayPort))) started.resolve();
      }, ownedChildren);
      running.incarnation = incarnation;
      running.binaryHash = launchHash;
      events.push({ id: `evt-${events.length + 1}`, type: "gateway-launch", incarnation, pid: running.child.pid, binary_sha256: launchHash });
      await bounded(Promise.race([
        started.promise,
        running.completion.then(({ code, signal }) => {
          throw new CliError(`gateway ${incarnation} exited before readiness code=${code} signal=${signal}; ${running.stderr.join(" | ")}`);
        }),
      ]), `gateway ${incarnation} readiness`);
      events.push({ id: `evt-${events.length + 1}`, type: "gateway-ready", incarnation, pid: running.child.pid });
      const { response } = await fetchText(`http://127.0.0.1:${gatewayPort}/healthz`, {}, `gateway ${incarnation} health`, 3_000);
      assert.equal(response.status, 200, "ready gateway must answer healthz");
      events.push({ id: `evt-${events.length + 1}`, type: "gateway-health", incarnation, pid: running.child.pid, status: response.status });
      running.healthStatus = response.status;
      return running;
    };
    const interrupt = async (running) => {
      const { child, incarnation } = running;
      assert(child.exitCode === null && child.signalCode === null, "gateway must still be alive before SIGINT");
      const accepted = child.kill("SIGINT");
      events.push({ id: `evt-${events.length + 1}`, type: "signal-sent", incarnation, pid: child.pid, signal: "SIGINT", accepted });
      assert(accepted, "SIGINT delivery must be accepted");
      const exit = await bounded(running.completion, `gateway ${incarnation} SIGINT exit`, 3_000);
      events.push({ id: `evt-${events.length + 1}`, type: "signal-exit", incarnation, pid: child.pid, ...exit });
      assert(exit.code === 0 || (exit.code === null && exit.signal === "SIGINT"), `gateway exited ${JSON.stringify(exit)}`);
      await bounded(Promise.all([running.closed, running.output]), `gateway ${incarnation} pipes close`, 3_000);
      events.push({ id: `evt-${events.length + 1}`, type: "pipes-closed", incarnation, pid: child.pid });
      await assertNoListener(gatewayPort);
      events.push({ id: `evt-${events.length + 1}`, type: "port-released", incarnation, pid: child.pid, port: gatewayPort });
      interruptions.push({ incarnation, pid: child.pid, binary_sha256: running.binaryHash, ready: true, health_status: running.healthStatus, signal: "SIGINT", accepted, exit, pipes_closed: true, port_released: gatewayPort });
      return exit;
    };
    const first = await launch(1);

    if (variant === "happy") {
      // Sequentially fetch collection and detail (no Promise.all masking: deterministic catalog created time guarantees exact equality)
      const slashModelId = "anthropic/claude-sonnet-4-6";
      const { response: collectionRes, body: collectionJson } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models`, {
        headers: { "accept": "application/json", "authorization": "Bearer test-admin" },
      }, "collection fetch");
      assert.equal(collectionRes.status, 200, `collection returned status ${collectionRes.status}`);
      assert.equal(collectionJson.object, "list", "collection object must be list");
      assert(Array.isArray(collectionJson.data), "collection data must be an array");

      const catalogMatch = collectionJson.data.find((item) => item.id === slashModelId);
      assert(catalogMatch, `collection must contain slash ID ${slashModelId}`);
      const requestsBeforeDetail = mock.requests.length;

      const { response: detailRes, body: detailJson } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models/${slashModelId}`, {
        headers: { "accept": "application/json", "authorization": "Bearer test-admin" },
      }, "detail fetch");
      assert.equal(detailRes.status, 200, `detail returned status ${detailRes.status}`);
      assert.equal(mock.requests.length, requestsBeforeDetail, "detail lookup must make zero extra remote requests");

      // Exact catalog object match: visible detail equals catalog entry exactly
      assert.deepStrictEqual(detailJson, catalogMatch, "visible detail must equal catalog entry exactly");

      assertions.push({
        id: "detail-matches-catalog",
        expected: catalogMatch,
        actual: detailJson,
        pass: true,
      });

      // Verification wire request to satisfy validateWire happy path
      const { response: chatRes, body: chatBody } = await fetchText(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer test-admin" },
        body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "models test" }], stream: true }),
      }, "wire completion fetch");
      assert.equal(chatRes.status, 200, `wire completion returned status ${chatRes.status}`);
      assert(chatBody.includes(SENTINEL), "wire completion missing sentinel");

    } else {
      const slashModelId = "anthropic/claude-sonnet-4-6";

      // 1. Scoped-hidden model: scoped key allowlist contains only gpt-5.6-sol
      const requestsBeforeScopedLookups = mock.requests.length;
      const { response: scopedHiddenRes, body: scopedHiddenBody } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models/${slashModelId}`, {
        headers: { "accept": "application/json", "authorization": "Bearer sk-scoped-user-test" },
      }, "scoped hidden model fetch");

      assert.equal(scopedHiddenRes.status, 404, `scoped hidden model returned ${scopedHiddenRes.status}`);
      assert.equal(scopedHiddenBody.error?.code, "model_not_found", "scoped hidden error code must be model_not_found");
      assert.equal(scopedHiddenBody.error?.type, "invalid_request_error", "scoped hidden error type must be invalid_request_error");

      // Verify scoped key can still view its permitted model
      const { response: scopedAllowedRes } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models/gpt-5.6-sol`, {
        headers: { "accept": "application/json", "authorization": "Bearer sk-scoped-user-test" },
      }, "scoped allowed model fetch");
      assert.equal(scopedAllowedRes.status, 200, `scoped allowed model returned ${scopedAllowedRes.status}`);
      const { response: scopedCollectionRes, body: scopedCollection } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models`, {
        headers: { "accept": "application/json", "authorization": "Bearer sk-scoped-user-test" },
      }, "scoped collection fetch");
      assert.equal(scopedCollectionRes.status, 200);
      assert(scopedCollection.data.every((entry) => entry.id !== slashModelId), "scoped collection must hide disallowed model");
      assert.equal(mock.requests.length, requestsBeforeScopedLookups, "scoped model lookups must not trigger upstream discovery");
      assertions.push({
        id: "scoped-collection-hides-model",
        expected: "model absent",
        actual: scopedCollection.data.some((entry) => entry.id === slashModelId) ? "model present" : "model absent",
        pass: scopedCollection.data.every((entry) => entry.id !== slashModelId),
      });

      // 2. Removed model after credential disable and management rescan
      // Model initially present under admin
      const { response: initialAdminRes, body: initialAdminBody } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models/${slashModelId}`, {
        headers: { "accept": "application/json", "authorization": "Bearer test-admin" },
      }, "initial admin model check");
      assert.equal(initialAdminRes.status, 200, "model must initially be present before disable");
      assertions.push({
        id: "account-removal-detail-before",
        expected: "detail present",
        actual: initialAdminRes.status === 200 && initialAdminBody.id === slashModelId ? "detail present" : "detail absent",
        pass: initialAdminRes.status === 200 && initialAdminBody.id === slashModelId,
      });
      const { response: collectionBeforeDisableRes, body: collectionBeforeDisable } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models`, {
        headers: { "accept": "application/json", "authorization": "Bearer test-admin" },
      }, "collection before disable fetch");
      assert.equal(collectionBeforeDisableRes.status, 200);
      assert(collectionBeforeDisable.data.some((entry) => entry.id === slashModelId), "admin collection must contain model before disable");
      assertions.push({
        id: "account-removal-collection-before",
        expected: "model present",
        actual: collectionBeforeDisable.data.some((entry) => entry.id === slashModelId) ? "model present" : "model absent",
        pass: collectionBeforeDisable.data.some((entry) => entry.id === slashModelId),
      });

      // Disable claude credential and trigger pool rescan via management API
      const { response: patchRes, body: patchBody } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v0/management/auth-files/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "authorization": "Bearer test-admin-secret" },
        body: JSON.stringify({ name: "claude-fixture.json", disabled: true }),
      }, "disable credential patch");
      assert.equal(patchRes.status, 200, `patch auth file returned ${patchRes.status}`);
      assert.equal(patchBody.status, "ok", "patch auth file status must be ok");
      assert.equal(patchBody.disabled, true, "patch auth file disabled must be true");
      const requestsAfterDisable = mock.requests.length;

      const { response: detailAfterDisableRes, body: detailAfterDisable } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models/${slashModelId}`, {
        headers: { "accept": "application/json", "authorization": "Bearer test-admin" },
      }, "detail immediately after disable");
      assert.equal(detailAfterDisableRes.status, 404, "detail must be absent after the management handler rescans the pool");
      assert.equal(detailAfterDisable.error?.code, "model_not_found");
      assertions.push({
        id: "account-removal-detail",
        expected: 404,
        actual: detailAfterDisableRes.status,
        pass: detailAfterDisableRes.status === 404,
      });
      assertions.push({
        id: "account-removal-detail-transition",
        expected: { before: "detail present", after: "detail absent" },
        actual: {
          before: initialAdminRes.status === 200 && initialAdminBody.id === slashModelId ? "detail present" : "detail absent",
          after: detailAfterDisableRes.status === 404 ? "detail absent" : "detail present",
        },
        pass: initialAdminRes.status === 200
          && initialAdminBody.id === slashModelId
          && detailAfterDisableRes.status === 404,
      });

      const { response: collectionAfterDisableRes, body: collectionAfterDisable } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models`, {
        headers: { "accept": "application/json", "authorization": "Bearer test-admin" },
      }, "collection after disable fetch");
      assert.equal(collectionAfterDisableRes.status, 200);
      assert(collectionAfterDisable.data.every((entry) => entry.id !== slashModelId), "disabled model must be removed from collection after rescan");
      assertions.push({
        id: "account-removal-collection-after",
        expected: "model absent",
        actual: collectionAfterDisable.data.some((entry) => entry.id === slashModelId) ? "model present" : "model absent",
        pass: collectionAfterDisable.data.every((entry) => entry.id !== slashModelId),
      });
      assertions.push({
        id: "account-removal-collection-transition",
        expected: { before: "model present", after: "model absent" },
        actual: {
          before: collectionBeforeDisable.data.some((entry) => entry.id === slashModelId) ? "model present" : "model absent",
          after: collectionAfterDisable.data.some((entry) => entry.id === slashModelId) ? "model present" : "model absent",
        },
        pass: collectionBeforeDisable.data.some((entry) => entry.id === slashModelId)
          && collectionAfterDisable.data.every((entry) => entry.id !== slashModelId),
      });

      // Model now removed -> 404 Not Found
      const { response: removedRes, body: removedBody } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models/${slashModelId}`, {
        headers: { "accept": "application/json", "authorization": "Bearer test-admin" },
      }, "removed model fetch");
      assert.equal(removedRes.status, 404, `removed model returned ${removedRes.status}`);
      assert.equal(removedBody.error?.code, "model_not_found", "removed model error code must be model_not_found");
      assert.equal(removedBody.error?.type, "invalid_request_error", "removed model error type must be invalid_request_error");
      assertions.push({
        id: "account-removal-detail-error-shape",
        expected: { code: "model_not_found", type: "invalid_request_error" },
        actual: { code: removedBody.error?.code, type: removedBody.error?.type },
        pass: removedBody.error?.code === "model_not_found" && removedBody.error?.type === "invalid_request_error",
      });

      // 3. Nonexistent model -> 404 Not Found
      const { response: missingModelRes, body: missingBody } = await fetchJson(`http://127.0.0.1:${gatewayPort}/v1/models/nonexistent-model`, {
        headers: { "accept": "application/json", "authorization": "Bearer test-admin" },
      }, "nonexistent model fetch");
      assert.equal(missingModelRes.status, 404, `nonexistent model returned ${missingModelRes.status}`);
      assert.equal(missingBody.error?.code, "model_not_found");
      assert.equal(missingBody.error?.type, "invalid_request_error");

      // Verify all state lookups made no additional upstream requests.
      assert.equal(mock.requests.length, requestsAfterDisable, "post-disable collection/detail lookups must not trigger upstream discovery");

      assertions.push({
        id: "missing-model-detail",
        expected: { status: 404, code: "model_not_found", type: "invalid_request_error" },
        actual: {
          status: missingModelRes.status,
          code: missingBody.error?.code,
          type: missingBody.error?.type,
        },
        pass: missingModelRes.status === 404
          && missingBody.error?.code === "model_not_found"
          && missingBody.error?.type === "invalid_request_error",
      });
      assertions.push({
        id: "hidden-or-removed-model-404",
        expected: { before: { collection: true, detail: 200 }, after: { collection: false, detail: 404 } },
        actual: {
          before: { collection: collectionBeforeDisable.data.some((entry) => entry.id === slashModelId), detail: initialAdminRes.status },
          after: { collection: collectionAfterDisable.data.some((entry) => entry.id === slashModelId), detail: detailAfterDisableRes.status },
        },
        pass: initialAdminRes.status === 200
          && collectionBeforeDisable.data.some((entry) => entry.id === slashModelId)
          && detailAfterDisableRes.status === 404
          && collectionAfterDisable.data.every((entry) => entry.id !== slashModelId),
      });
    }

    await interrupt(first);
    const second = await launch(2);
    const exit = await interrupt(second);
    assert.equal(interruptions.length, 2);
    assertions.push({
      id: "repeated-interruption-incarnations",
      expected: { incarnations: 2, binary_sha256: binaryHash, health_status: 200, signal: "SIGINT", pipes_closed: true, port_released: gatewayPort },
      actual: interruptions,
      pass: interruptions.every((entry) => entry.binary_sha256 === binaryHash && entry.ready && entry.health_status === 200
        && entry.signal === "SIGINT" && entry.accepted && entry.pipes_closed && entry.port_released === gatewayPort),
    });
    events.push({ id: `evt-${events.length + 1}`, type: "exit", ...exit });

    mock.server.stop(true);
    ownedListeners.splice(ownedListeners.indexOf(mock.server), 1);
    await assertNoListener(gatewayPort);
    await assertNoListener(mockPort);

    const controlledExit = exit.code === 0 || (exit.code === null && exit.signal === "SIGINT");
    assert(controlledExit, `gateway exited ${JSON.stringify(exit)}`);
    assert(assertions.every((a) => a.pass), "assertion failed");

    const sourceRevision = await (async () => {
      const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: gatewayDir, stdout: "pipe" });
      return (await new Response(proc.stdout).text()).trim();
    })();

    const desktopRevision = await (async () => {
      const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: rootDir, stdout: "pipe" });
      return (await new Response(proc.stdout).text()).trim();
    })();

    const { files: sourceFiles, sourceHash } = await context.getSourceClosure();
    assert.equal(createHash("sha256").update(await readFile(context.binary)).digest("hex"), binaryHash);

    const buildReceiptPath = join(dirname(dirname(context.binary)), "source-revision.txt");
    const buildReceiptBytes = await readFile(buildReceiptPath);
    const buildReceiptSha = createHash("sha256").update(buildReceiptBytes).digest("hex");

    const wireRequests = mock.requests.map((request) => ({
      ...request,
      body_bytes_base64: Buffer.from(request.body).toString("base64"),
      body_sha256: createHash("sha256").update(request.body).digest("hex"),
    }));

    const cleanTeardown = {
      exit: { code: exit.code, signal: exit.signal },
      signal_deliveries: events.filter((event) => event.type === "signal-sent"),
      repeated_interruptions: { scope: "two-sequential-gateway-incarnations", same_pid_repeated_receipt: false, incarnations: interruptions },
      listeners: 0,
      ownedProcesses: 0,
      listener_inventory: [],
      process_inventory: [],
      termination: "controlled-signal",
    };

    const isDirty = (await (async () => {
      const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: gatewayDir, stdout: "pipe" });
      return (await new Response(proc.stdout).text()).trim();
    })()).length > 0;

    const provenance = {
      gateway_binary: context.binary,
      gateway_sha256: binaryHash,
      desktop_revision: desktopRevision,
      gateway_revision: sourceRevision,
      gateway_source_sha256: sourceHash,
      source_root: gatewayDir,
      source_manifest: { files: sourceFiles },
      build_command: context.buildCommand,
      build_receipt: { path: buildReceiptPath, sha256: buildReceiptSha },
      binary_source_revision: sourceRevision,
      dirty: isDirty,
    };

    return await finalizeReceipt({
      variant,
      assertions,
      events,
      wireRequests,
      externalDialCount,
      provenance,
      teardown: cleanTeardown,
    }, context.createReceipt, async (receipt) => {
      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    });
  } finally {
    try {
      const cleanup = await Promise.allSettled(ownedChildren.map(async (running) => {
        await terminate(running.child, running.completion);
        await bounded(Promise.all([running.closed, running.output]), "gateway cleanup pipes close", 2_000);
      }));
      const failed = cleanup.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    } finally {
      for (const server of ownedListeners) server.stop(true);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
}

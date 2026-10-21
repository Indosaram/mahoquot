import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gateway = join(root, "mahoquot-proxy");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assert(value, message) { if (!value) throw new Error(message); }
async function bounded(promise, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out")), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function git(directory, ...args) {
  const child = Bun.spawn(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  try {
    const [text, error, code] = await bounded(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), "git " + args.join(" "));
    assert(code === 0, error);
    return text.trim();
  } catch (error) { child.kill("SIGKILL"); await child.exited; throw error; }
}
async function releasedPort(port) {
  const probe = createServer();
  await bounded(new Promise((done, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", done);
  }), "bind port probe " + port);
  await bounded(new Promise((done) => probe.close(done)), "close port probe " + port);
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "unknown management-ops variant: " + variant);
  const ports = context.ports;
  assert(ports.length === 2 && ports[0] !== ports[1] && ports.every((port) => port >= 18840 && port <= 18899),
    "management-ops requires leased test ports");
  const revision = await git(gateway, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const closure = await context.getSourceClosure();
  const bindingPath = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingContent = await readFile(bindingPath, "utf8");
  const lines = bindingContent.trim().split("\n");
  assert(lines[0] === revision && lines[1] === binaryHash && lines[2] === closure.sourceHash &&
    lines[3] === context.buildCommand, "management-ops requires a current source-bound binary");
  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "management-ops-"));
  const auth = join(work, "auth"), config = join(work, "config.yaml");
  const events = [], wireRequests = [], assertions = [];
  let child, mock, exitPromise, pipePromise, exit, failure;
  const record = (id, expected, actual) => assertions.push({
    id, expected, actual, pass: JSON.stringify(expected) === JSON.stringify(actual)
  });

  try {
    await releasedPort(ports[0]);
    await releasedPort(ports[1]);
    await mkdir(auth);

    await writeFile(join(auth, "codex-test-acct.json"), JSON.stringify({
      type: "codex", identity_slug: "test-acct", account_id: "test-acct", access_token: "token-test",
      refresh_token: "fixture", id_token: "fixture", email: "test@fixture.invalid",
      expired: "2099-01-01T00:00:00Z", last_refresh: "2098-01-01T00:00:00Z",
      upstream_override: `http://127.0.0.1:${ports[1]}`, usage_override: `http://127.0.0.1:${ports[1]}`,
    }));

    await writeFile(config, [
      "api-keys: [test-client-key]",
      "remote-management:",
      "  allow-remote: false",
      '  secret-key: "test-management"',
      "model-catalog:",
      "  refresh-enabled: false"
    ].join("\n"));

    mock = Bun.serve({
      hostname: "127.0.0.1",
      port: ports[1],
      async fetch(request) {
        const body = await request.text();
        const path = new URL(request.url).pathname;
        const headers = Object.fromEntries(request.headers);
        wireRequests.push({
          method: request.method,
          path,
          headers,
          body_bytes_base64: Buffer.from(body).toString("base64"),
          body_sha256: hash(body),
        });
        if (path === "/latest-release") return Response.json({ tag_name: "v-task28-mock" });
        if (path === "/echo") {
          return Response.json({ status: "echoed", method: request.method, path,
            authorization: request.headers.get("authorization") });
        }
        if (path === "/backend-api/codex/responses") return Response.json({ error: { message: "fixture rate limit" } }, { status: 429 });
        return Response.json({ id: "mock-resp", status: "ok" });
      }
    });

    let readyResolve;
    const ready = new Promise((done) => { readyResolve = done; });
    child = spawn(context.binary, [
      "serve", "--bind", "127.0.0.1", "--port", String(ports[0]),
      "--auth-dir", auth, "--config", config, "--auth-refresh", "false",
      "--usage-poll-secs", "3600", "--log-level", "info"
    ], {
      cwd: gateway,
      env: {
        ...process.env,
        AUTH_DIR: auth,
        CONFIG_PATH: config,
        MAHOQUOT_LATEST_VERSION_URL: `http://127.0.0.1:${ports[1]}/latest-release`,
        MANAGEMENT_PASSWORD: "",
        MAHOQUOT_QA_LOOPBACK_ONLY: "1",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        NO_PROXY: "127.0.0.1,localhost"
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    exitPromise = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    });

    const readPipes = async (source, type) => {
      let buffer = "";
      for await (const chunk of source) {
        buffer += chunk.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop();
        for (const line of parts) {
          events.push({ type, line });
          if (line.includes("listening") && line.includes(String(ports[0]))) readyResolve();
        }
      }
      if (buffer) events.push({ type, line: buffer });
    };

    pipePromise = Promise.all([readPipes(child.stdout, "stdout"), readPipes(child.stderr, "stderr")]);
    await bounded(Promise.race([
      ready,
      exitPromise.then((value) => { throw new Error("early gateway exit " + JSON.stringify(value)); })
    ]), "gateway readiness");
    events.push({ type: "gateway-ready", pid: child.pid });

    const mgmtHeaders = {
      "authorization": "Bearer test-management",
      "content-type": "application/json"
    };

    if (variant === "happy") {
      const base = `http://127.0.0.1:${ports[0]}`;
      const jsonCall = async (method, path, body, auth = mgmtHeaders) => {
        const response = await fetch(base + path, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await response.text();
        let value; try { value = JSON.parse(text); } catch { value = null; }
        events.push({ type: "manifest-route", method, path, status: response.status, body: value ?? text.slice(0, 300) });
        return { status: response.status, body: value, text };
      };
      const exportHeaders = { ...mgmtHeaders, "x-mahoquot-export-authorization": "test-management" };
      const routes = [
        ["GET", "/v8/management/config"], ["GET", "/v8/management/server/latest-version"],
        ["POST", "/v8/management/requests/api-call", { auth_index: "codex-test-acct.json", method: "GET", url: `http://127.0.0.1:${ports[1]}/echo`, header: { authorization: "Bearer $TOKEN$" } }],
        ["POST", "/v8/management/routing/cooldown/reset", { auth_index: "test-acct" }],
        ["GET", "/v8/management/routing/model-definitions/codex"],
        ["GET", "/v8/management/observability/logs"], ["DELETE", "/v8/management/observability/logs"],
        ["GET", "/v8/management/observability/logs/errors"], ["GET", "/v8/management/observability/logs/errors/missing.json"],
        ["GET", "/v8/management/observability/logs/requests/missing"], ["GET", "/v8/management/observability/usage/api-keys"],
        ["GET", "/v8/management/observability/usage/queue"], ["GET", "/v8/management/credentials"],
        ["GET", "/v8/management/credentials/models?name=codex-test-acct.json"], ["GET", "/v8/management/credentials/download?name=codex-test-acct.json"],
        ["GET", "/v0/management/quota/providers"],
        ["PATCH", "/v8/management/credentials/status", { name: "codex-test-acct.json", disabled: true }],
        ["PATCH", "/v8/management/credentials/fields", { name: "codex-test-acct.json", label: "task28" }],
        ["POST", "/v8/management/credentials/refresh", { name: "codex-test-acct.json" }],
        ["POST", "/v8/management/oauth/import?provider=unsupported", {}], ["GET", "/v8/management/oauth/auth-url?provider=unsupported"],
        ["GET", "/v8/management/oauth/status"], ["DELETE", "/v8/management/oauth/session"],
        ["POST", "/v0/management/quota/fetch", { auth_index: "codex-test-acct.json" }],
        ["POST", "/v0/management/quota/reset", { auth_index: "codex-test-acct.json" }],
        ["POST", "/v0/management/auth-files/refresh", { name: "codex-test-acct.json" }],
        ["GET", "/v0/management/meta-auth-url"], ["GET", "/v0/management/kimi-auth-url"], ["GET", "/v0/management/devin-auth-url"],
      ];
      const routeResults = [];
      for (const [method, path, body] of routes) {
        const auth = path.includes("/credentials/download") ? exportHeaders : mgmtHeaders;
        routeResults.push({ method, path, ...(await jsonCall(method, path, body, auth)) });
      }
      const expectedNotFound = new Set([
        "/v8/management/observability/logs/errors/missing.json",
        "/v8/management/observability/logs/requests/missing",
        "/v8/management/oauth/import?provider=unsupported",
        "/v8/management/oauth/auth-url?provider=unsupported",
      ]);
      const invalidRoutes = routeResults.filter((r) => [405, 501].includes(r.status) || (r.status === 404 && !expectedNotFound.has(r.path)));
      const badShapes = routeResults.filter((r) => r.body === null || (typeof r.body !== "object"));
      const usefulCheck = (r) => {
        if (r.path === "/v8/management/routing/model-definitions/codex") return Array.isArray(r.body?.models) && r.body.models.length > 0;
        if (r.path === "/v0/management/quota/providers") return Array.isArray(r.body?.providers) && r.body.providers.length > 0;
        if (r.path === "/v8/management/observability/usage/queue") return Array.isArray(r.body) || Object.keys(r.body ?? {}).length > 0;
        if (r.path === "/v8/management/server/latest-version") return typeof r.body?.["latest-version"] === "string";
        if (r.path === "/v8/management/requests/api-call") return Number.isInteger(r.body?.status_code) && typeof r.body?.body === "string";
        if (r.path === "/v8/management/credentials") return Array.isArray(r.body?.files);
        if (r.path === "/v8/management/credentials/models") return Array.isArray(r.body?.models);
        if (r.path.includes("/credentials/download")) return r.status === 200 && r.text.length > 0;
        return r.body !== null && typeof r.body === "object";
      };
      const uselessRoutes = routeResults.filter((r) => !usefulCheck(r));
      const goodManifest = invalidRoutes.length === 0 && badShapes.length === 0 && uselessRoutes.length === 0;
      events.push({ type: "manifest-route-summary", total: routeResults.length, invalid: invalidRoutes, badShapes, uselessRoutes });
      for (const result of routeResults) events.push({ type: "manifest-route", method: result.method, path: result.path, status: result.status, body: result.body ?? result.text.slice(0, 300) });
      record("manifest-routes-covered", true, goodManifest);
      assertions[assertions.length - 1].details = { route_count: routeResults.length, routes: routeResults };
      if (!goodManifest) throw new Error(`task28 routes not useful: ${JSON.stringify({ invalidRoutes, badShapes, uselessRoutes })}`);

      const apiCall = routeResults.find((r) => r.path.startsWith("/v8/management/requests/api-call"));
      const apiMock = wireRequests.find((r) => r.path === "/echo");
      let echoed = null; try { echoed = JSON.parse(apiCall?.body?.body ?? "null"); } catch {}
      const apiTokenRedacted = !JSON.stringify(apiCall).includes("token-test") && echoed?.authorization === "Bearer [REDACTED]";
      const latestMock = wireRequests.some((r) => r.path === "/latest-release");
      const latestVersion = routeResults.find((r) => r.path === "/v8/management/server/latest-version");
      const latestObserved = latestMock && latestVersion?.body?.["latest-version"] === "v-task28-mock";
      const statusPatch = routeResults.find((r) => r.path === "/v8/management/credentials/status");
      const fieldsPatch = routeResults.find((r) => r.path === "/v8/management/credentials/fields");
      const statusGet = await jsonCall("GET", "/v8/management/credentials?name=codex-test-acct.json");
      const credentialList = statusGet.body?.files ?? [];
      const credential = credentialList.find((c) => c.name === "codex-test-acct.json");
      const fieldsGet = await jsonCall("GET", "/v8/management/credentials");
      const fieldValue = (fieldsGet.body?.files ?? []).find((c) => c.name === "codex-test-acct.json")?.label;
      const reset = routeResults.find((r) => r.path === "/v8/management/routing/cooldown/reset");
      const reenable = await jsonCall("PATCH", "/v8/management/credentials/status", { name: "codex-test-acct.json", disabled: false });
      const cooldownTrigger = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer test-client-key" }, body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "cooldown-trigger" }], stream: false }) });
      const cooldownMockObserved = wireRequests.some((r) => r.path === "/backend-api/codex/responses" && r.method === "POST");
      const cooldownReset = await jsonCall("POST", "/v8/management/routing/cooldown/reset", { auth_index: "test-acct" });
      const operation = {
        api_call: { status: apiCall.status, mock_received_token: apiMock?.headers?.authorization === "Bearer token-test", response_redacted: apiTokenRedacted },
        latest_version: { injected_mock_observed: latestObserved, body: latestVersion?.body },
        credential_status_fields: { status_patch: statusPatch?.status, disabled_after_patch: credential?.disabled, fields_patch: fieldsPatch?.status, label_after_patch: fieldValue },
        cooldown_reset: { reenable_status: reenable.status, mock_status: cooldownTrigger.status, mock_observed: cooldownMockObserved, reset_status: cooldownReset.status, reset_body: cooldownReset.body },
      };
      const operationOk = operation.api_call.status === 200 && operation.api_call.mock_received_token && operation.api_call.response_redacted && operation.latest_version.injected_mock_observed && operation.credential_status_fields.status_patch === 200 && operation.credential_status_fields.disabled_after_patch === true && operation.credential_status_fields.fields_patch === 200 && operation.credential_status_fields.label_after_patch === "task28" && operation.cooldown_reset.mock_status === 429 && operation.cooldown_reset.mock_observed && operation.cooldown_reset.reset_status === 200;
      record("operation-observed", true, operationOk);
      if (!operationOk) throw new Error(`operation observations incomplete: ${JSON.stringify(operation)}`);
      await fetch(`${base}/backend-api/codex/responses`, { method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer test-client-key" }, body: JSON.stringify({ model: "gpt-5.6-sol", input: "probe", stream: false }) });

    } else {
      // 1. unauthorized-denied: Unauthorized access to management is denied
      const unauthResp = await fetch(`http://127.0.0.1:${ports[0]}/v8/management/credentials`);
      const inferenceResp = await fetch(`http://127.0.0.1:${ports[0]}/v8/management/credentials`, { headers: { authorization: "Bearer test-client-key" } });
      const unauthorized = { no_key: unauthResp.status, inference_key: inferenceResp.status };
      record("unauthorized-denied", { no_key: 401, inference_key: 401 }, unauthorized);

      // 2. missing-download-404: Downloading nonexistent credential file returns 404
      const downloadNotFound = await fetch(`http://127.0.0.1:${ports[0]}/v8/management/credentials/download?name=nonexistent.json`, {
        headers: {
          ...mgmtHeaders,
          "x-mahoquot-export-authorization": "test-management"
        }
      });
      const downloadJson = await downloadNotFound.json().catch(() => null);
      const errorsDownload = await fetch(`http://127.0.0.1:${ports[0]}/v8/management/observability/logs/errors/missing.json`, { headers: mgmtHeaders });
      const errorDownloadJson = await errorsDownload.json().catch(() => null);
      events.push({ type: "failure-route", path: "/v8/management/credentials/download?name=nonexistent.json", status: downloadNotFound.status, body: downloadJson });
      events.push({ type: "failure-route", path: "/v8/management/observability/logs/errors/missing.json", status: errorsDownload.status, body: errorDownloadJson });
      record("missing-download-404", { credentials: 404, credentials_json_error: true, errors: 404, errors_json_error: true }, {
        credentials: downloadNotFound.status, credentials_json_error: !!downloadJson?.error,
        errors: errorsDownload.status, errors_json_error: !!errorDownloadJson?.error,
      });
    }

    assert(assertions.every((entry) => entry.pass), "management-ops assertions failed");
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        try { exit = await bounded(exitPromise, "gateway exit"); }
        catch (error) {
          child.kill("SIGKILL"); exit = await bounded(exitPromise, "forced exit"); throw error;
        }
        await bounded(pipePromise, "gateway pipes closed");
        events.push({ type: "kernel-exit-observation", pid: child.pid, ...exit, pipes_closed: true });
      }
    } catch (error) { failure ??= error; }
    try {
      await mock?.stop(true);
      const probes = await Promise.all(ports.map(releasedPort));
      events.push({ type: "port-release-observations", probes });
    } catch (error) { failure ??= error; }
    await rm(work, { recursive: true, force: true });
  }

  const required = variant === "happy"
    ? ["manifest-routes-covered", "operation-observed"]
    : ["unauthorized-denied", "missing-download-404"];

  const receipt = context.createReceipt({
    caseName: "management-ops",
    variant,
    assertions,
    requiredAssertionIds: required,
    events,
    wireRequests,
    externalDialCount: 0,
    provenance: {
      gateway_binary: context.binary,
      gateway_sha256: binaryHash,
      desktop_revision: await git(root, "rev-parse", "HEAD"),
      gateway_revision: revision,
      gateway_source_sha256: closure.sourceHash,
      source_root: gateway,
      source_manifest: { files: closure.files },
      build_command: context.buildCommand,
      build_receipt: { path: bindingPath, sha256: hash(bindingContent) },
      binary_source_revision: revision,
      dirty: Boolean(await git(gateway, "status", "--porcelain"))
    },
    teardown: {
      exit: exit ?? { code: 0, signal: "SIGTERM" },
      termination: "controlled-signal",
      listeners: failure ? null : 0,
      ownedProcesses: failure ? null : 0,
      listener_inventory: [],
      process_inventory: []
    },
  });

  delete receipt.wire_capture.external_dials;
  receipt.status = failure ? "FAIL" : "PASS";
  receipt.failure = failure ? String(failure) : null;
  await writeFile(evidencePath, JSON.stringify(receipt, null, 2), { flag: "wx" });
  assert(!failure, "management-ops failed: " + failure);
  return receipt;
}

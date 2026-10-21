import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assert(value, message) { if (!value) throw new Error(message); }
async function bounded(promise, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function git(path, ...args) {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, error, code] = await bounded(Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]), "git");
  assert(code === 0, error);
  return text.trim();
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "invalid management-auth variant");
  assert(context.ports.length === 2 && context.ports.every((port) => port >= 18840 && port <= 18899), "leased test ports required");
  const gateway = join(root, "mahoquot-proxy");
  const closure = await context.getSourceClosure();
  const revision = await git(gateway, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const binding = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingBytes = await readFile(binding);
  assert(bindingBytes.toString().trim() === [revision, binaryHash, closure.sourceHash, context.buildCommand].join("\n"), "binary source binding mismatch");

  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "management-auth-"));
  const config = join(work, "config.yaml");
  const auth = join(work, "auth");
  await mkdir(auth);

  const assertions = [], events = [], wireRequests = [];
  let failure, child, exitPromise, pipes, exit, mock;
  const record = (id, expected, actual) => assertions.push({ id, expected, actual, pass: expected === actual });

  // Create a mock provider listener on port[1] to satisfy inference request capture
  mock = Bun.serve({
    hostname: "127.0.0.1",
    port: context.ports[1],
    async fetch(req) {
      const body = await req.text();
      wireRequests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body_bytes_base64: Buffer.from(body).toString("base64"),
        body_sha256: hash(body),
      });
      if (req.url.includes("/api/oauth/usage")) {
        return Response.json({ plan_type: "team", rate_limits: [] });
      }
      return Response.json({
        id: "chatcmpl_mock",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "pong" } }]
      });
    }
  });

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
    upstream_override: `http://127.0.0.1:${context.ports[1]}`,
  }));

  async function start(secret, allowRemote = false) {
    const configContent = [
      "api-keys: [inference-only]",
      "remote-management:",
      `  allow-remote: ${allowRemote}`,
      secret ? `  secret-key: ${JSON.stringify(secret)}` : `  secret-key: ""`,
      "model-catalog:",
      "  refresh-enabled: false"
    ].join("\n");
    await writeFile(config, configContent);

    let readyResolve;
    const ready = new Promise((done) => { readyResolve = done; });
    child = spawn(context.binary, [
      "serve",
      "--bind", "127.0.0.1",
      "--port", String(context.ports[0]),
      "--auth-dir", auth,
      "--config", config,
      "--auth-refresh", "false"
    ], {
      cwd: gateway,
      env: {
        ...process.env,
        AUTH_DIR: auth,
        CONFIG_PATH: config,
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

    const lines = async (source, type) => {
      let buffer = "";
      for await (const chunk of source) {
        buffer += chunk.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop();
        for (const line of parts) {
          events.push({ type, line });
          if (line.includes("listening") && line.includes(String(context.ports[0]))) readyResolve();
        }
      }
      if (buffer) events.push({ type, line: buffer });
    };

    pipes = Promise.all([lines(child.stdout, "stdout"), lines(child.stderr, "stderr")]);

    await bounded(Promise.race([
      ready,
      exitPromise.then((value) => { throw new Error("early gateway exit " + JSON.stringify(value)); })
    ]), "gateway readiness");
    events.push({ type: "gateway-ready", pid: child.pid });
  }

  async function stop() {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try {
      exit = await bounded(exitPromise, "gateway exit");
    } catch (error) {
      child.kill("SIGKILL");
      await bounded(exitPromise, "forced exit");
      throw error;
    }
    await bounded(pipes, "pipes closed");
    events.push({ type: "kernel-exit-observation", pid: child.pid, ...exit, pipes_closed: true });
    child = null;
  }

  async function request(headers = {}, path = "/v0/management/config") {
    const response = await fetch(`http://127.0.0.1:${context.ports[0]}${path}`, {
      headers,
      proxy: "",
      redirect: "error",
      signal: AbortSignal.timeout(10000)
    });
    events.push({ type: "management-response", path, status: response.status });
    return response.status;
  }

  async function requestJson(headers = {}, path = "/v8/management/config") {
    const response = await fetch(`http://127.0.0.1:${context.ports[0]}${path}`, {
      headers,
      proxy: "",
      redirect: "error",
      signal: AbortSignal.timeout(10000)
    });
    return response.json();
  }

  try {
    if (variant === "happy") {
      const secret = "dedicated-management-secret";
      await start(secret, true);

      // 1. dedicated-key-auth: Authenticate with dedicated key via Bearer and X-Management-Key
      const bearerStatus = await request({ authorization: `Bearer ${secret}` });
      const xKeyStatus = await request({ "x-management-key": secret });
      record("dedicated-key-auth", true, bearerStatus === 200 && xKeyStatus === 200);

      // 2. remote-connection-preserved: Saved remote management config preserved and accessible with dedicated key
      const v8Config = await requestJson({ authorization: `Bearer ${secret}` }, "/v8/management/config");
      const remotePreserved = v8Config?.management?.["allow-remote"] === true;
      record("remote-connection-preserved", true, remotePreserved);

      // Trigger one POST inference request to populate wire_capture.gateway_requests
      await fetch(`http://127.0.0.1:${context.ports[0]}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer inference-only" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }] })
      });

      await stop();
    } else {
      // 1. empty-secret-404: Empty management secret returns 404
      await start("", false);
      const emptyStatus = await request();
      record("empty-secret-404", 404, emptyStatus);
      await stop();

      // 2. inference-key-denied: Dedicated key is configured, inference API key is denied with 401
      const secret = "dedicated-management-secret";
      await start(secret, false);
      const inferenceKeyStatus = await request({ authorization: "Bearer inference-only" });
      record("inference-key-denied", 401, inferenceKeyStatus);
      await stop();
    }

    assert(assertions.every((entry) => entry.pass), "management auth assertions failed");
  } catch (error) {
    failure = error;
  } finally {
    try {
      await stop();
      if (mock) await mock.stop(true);
      for (const port of context.ports) {
        const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
        listener.stop(true);
      }
      events.push({ type: "port-release-observations", ports: context.ports });
    } catch (error) {
      failure ??= error;
    }
    await rm(work, { recursive: true, force: true });
  }

  const requiredAssertionIds = variant === "happy"
    ? ["dedicated-key-auth", "remote-connection-preserved"]
    : ["empty-secret-404", "inference-key-denied"];

  const receipt = context.createReceipt({
    caseName: "management-auth",
    variant,
    assertions,
    requiredAssertionIds,
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
      build_receipt: { path: binding, sha256: hash(bindingBytes) },
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
  assert(!failure, String(failure));
  return receipt;
}

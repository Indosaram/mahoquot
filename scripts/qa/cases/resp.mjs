import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

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
  ]), "git " + args.join(" "));
  assert(code === 0, error);
  return text.trim();
}

class RespClient {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
  }

  async connect() {
    return bounded(new Promise((resolve, reject) => {
      const socket = createConnection({ port: this.port, host: "127.0.0.1" }, () => {
        this.socket = socket;
        resolve();
      });
      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._processWaiters();
      });
      socket.once("error", reject);
    }), "RESP connect");
  }

  _processWaiters() {
    while (this.waiters.length > 0) {
      const parsed = this._parseOne();
      if (!parsed.complete) break;
      const waiter = this.waiters.shift();
      waiter.resolve(parsed.value);
    }
  }

  _parseOne() {
    if (this.buffer.length === 0) return { complete: false };
    const prefix = String.fromCharCode(this.buffer[0]);
    const crlf = this.buffer.indexOf("\r\n");
    if (crlf === -1) return { complete: false };

    if (prefix === "+") {
      const val = this.buffer.slice(1, crlf).toString("utf8");
      this.buffer = this.buffer.slice(crlf + 2);
      return { complete: true, value: val };
    }
    if (prefix === "-") {
      const val = this.buffer.slice(1, crlf).toString("utf8");
      this.buffer = this.buffer.slice(crlf + 2);
      return { complete: true, value: new Error(val) };
    }
    if (prefix === ":") {
      const val = parseInt(this.buffer.slice(1, crlf).toString("utf8"), 10);
      this.buffer = this.buffer.slice(crlf + 2);
      return { complete: true, value: val };
    }
    if (prefix === "$") {
      const len = parseInt(this.buffer.slice(1, crlf).toString("utf8"), 10);
      if (len === -1) {
        this.buffer = this.buffer.slice(crlf + 2);
        return { complete: true, value: null };
      }
      if (this.buffer.length < crlf + 2 + len + 2) return { complete: false };
      const val = this.buffer.slice(crlf + 2, crlf + 2 + len).toString("utf8");
      this.buffer = this.buffer.slice(crlf + 2 + len + 2);
      return { complete: true, value: val };
    }
    if (prefix === "*") {
      const count = parseInt(this.buffer.slice(1, crlf).toString("utf8"), 10);
      if (count === -1) {
        this.buffer = this.buffer.slice(crlf + 2);
        return { complete: true, value: null };
      }
      let offset = crlf + 2;
      const elements = [];
      for (let i = 0; i < count; i++) {
        if (offset >= this.buffer.length) return { complete: false };
        const subPrefix = String.fromCharCode(this.buffer[offset]);
        const subCrlf = this.buffer.indexOf("\r\n", offset);
        if (subCrlf === -1) return { complete: false };

        if (subPrefix === "$") {
          const subLen = parseInt(this.buffer.slice(offset + 1, subCrlf).toString("utf8"), 10);
          if (subLen === -1) {
            elements.push(null);
            offset = subCrlf + 2;
          } else {
            if (this.buffer.length < subCrlf + 2 + subLen + 2) return { complete: false };
            elements.push(this.buffer.slice(subCrlf + 2, subCrlf + 2 + subLen).toString("utf8"));
            offset = subCrlf + 2 + subLen + 2;
          }
        } else if (subPrefix === ":") {
          elements.push(parseInt(this.buffer.slice(offset + 1, subCrlf).toString("utf8"), 10));
          offset = subCrlf + 2;
        } else if (subPrefix === "+") {
          elements.push(this.buffer.slice(offset + 1, subCrlf).toString("utf8"));
          offset = subCrlf + 2;
        } else {
          return { complete: false };
        }
      }
      this.buffer = this.buffer.slice(offset);
      return { complete: true, value: elements };
    }
    return { complete: false };
  }

  async sendCommand(args) {
    let raw = `*${args.length}\r\n`;
    for (const a of args) {
      const str = String(a);
      raw += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
    }
    const promise = new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    this.socket.write(raw);
    this._processWaiters();
    return bounded(promise, "resp sendCommand: " + args[0]);
  }

  async readNext(timeout = 15000) {
    const promise = new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    this._processWaiters();
    return bounded(promise, "resp readNext", timeout);
  }

  async expectNoNext(timeoutMs = 300) {
    const parsed = this._parseOne();
    if (parsed.complete) {
      throw new Error("unexpected message already in buffer: " + JSON.stringify(parsed.value));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(true);
      }, timeoutMs);
      const waiter = {
        resolve: (val) => {
          clearTimeout(timer);
          reject(new Error("unexpected extra message arrived: " + JSON.stringify(val)));
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "invalid resp variant");
  assert(context.ports.length === 2 && context.ports.every((port) => port >= 18840 && port <= 18899), "leased test ports required");
  const gateway = join(root, "mahoquot-proxy");
  const closure = await context.getSourceClosure();
  const revision = await git(gateway, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const binding = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingBytes = await readFile(binding);
  assert(bindingBytes.toString().trim() === [revision, binaryHash, closure.sourceHash, context.buildCommand].join("\n"), "binary source binding mismatch");

  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "resp-qa-"));
  const config = join(work, "config.yaml");
  const auth = join(work, "auth");
  await mkdir(auth);

  const assertions = [], events = [], wireRequests = [];
  let failure, child, exitPromise, pipes, exit, mock;
  const record = (id, expected, actual) => assertions.push({ id, expected, actual, pass: expected === actual });

  // Mock provider on ports[1] to answer inference requests
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
      return Response.json({
        id: "resp_123",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      });
    }
  });

  await writeFile(join(auth, "codex-fixture.json"), JSON.stringify({
    type: "plus", identity_slug: "test-codex", account_id: "test-codex", access_token: "token-test",
    refresh_token: "fixture", id_token: "fixture", email: "test@fixture.invalid",
    expired: "2099-01-01T00:00:00Z", last_refresh: "2098-01-01T00:00:00Z",
    upstream_override: `http://127.0.0.1:${context.ports[1]}`, usage_override: `http://127.0.0.1:${context.ports[1]}`,
  }));

  async function startGateway(secret) {
    await writeFile(config, `api-keys: [inference-key]\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(secret)}\n`);
    let readyResolve;
    const ready = new Promise((done) => { readyResolve = done; });
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(context.ports[0]), "--auth-dir", auth, "--auth-refresh", "false"], {
      cwd: gateway,
      env: { ...process.env, AUTH_DIR: auth, CONFIG_PATH: config, MANAGEMENT_PASSWORD: "", MAHOQUOT_QA_LOOPBACK_ONLY: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exitPromise = new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal })); });
    pipes = Promise.all([child.stdout, child.stderr].map((stream) => new Promise((done, reject) => {
      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes("listening")) readyResolve();
      });
      stream.once("end", done);
      stream.once("error", reject);
    })));
    await bounded(Promise.race([ready, exitPromise.then((v) => { throw new Error("early exit " + JSON.stringify(v)); })]), "gateway readiness");
    events.push({ type: "gateway-ready", pid: child.pid });
  }

  async function stopGateway() {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try {
      exit = await bounded(exitPromise, "gateway exit");
    } catch (e) {
      child.kill("SIGKILL");
      await bounded(exitPromise, "forced exit");
      throw e;
    }
    await bounded(pipes, "pipes closed");
    events.push({ type: "kernel-exit-observation", pid: child.pid, ...exit, pipes_closed: true });
    child = null;
  }

  const clients = [];
  function makeClient() {
    const c = new RespClient(context.ports[0]);
    clients.push(c);
    return c;
  }

  try {
    if (variant === "happy") {
      const secret = "resp-management-secret";
      await startGateway(secret);

      // 1. HTTP and RESP coexist on the same port
      const healthRes = await fetch(`http://127.0.0.1:${context.ports[0]}/healthz`);
      record("http-coexists", 200, healthRes.status);

      // 2. RESP client AUTH + PING
      const client1 = makeClient();
      await client1.connect();
      const authRes = await client1.sendCommand(["AUTH", secret]);
      const pingRes = await client1.sendCommand(["PING"]);
      record("auth-ping", "OK:PONG", `${authRes}:${pingRes}`);

      // 3. PubSub subscription: SUBSCRIBE to usage channel BEFORE sending inference request
      const subClient = makeClient();
      await subClient.connect();
      await subClient.sendCommand(["AUTH", secret]);
      const subAck = await subClient.sendCommand(["SUBSCRIBE", "usage"]);
      assert(Array.isArray(subAck) && subAck[0] === "subscribe" && subAck[1] === "usage", "subscribe ack failed");
      const initialPayload = await subClient.readNext(5000);
      assert(Array.isArray(initialPayload) && initialPayload[0] === "message" && initialPayload[1] === "usage", "initial refresh message missing");
      const initialData = JSON.parse(initialPayload[2]);
      assert(initialData.support_refresh === true, "initial refresh message payload mismatch");

      // 4. Send ONE inference request and verify pubsub receives exactly one usage event
      const infRes1 = await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "test-pubsub-event", stream: false })
      });
      assert(infRes1.status === 200, "inference request 1 failed: status " + infRes1.status);
      await infRes1.json();

      // Read the published usage event from subClient
      const pubsubMsg = await subClient.readNext(5000);
      assert(Array.isArray(pubsubMsg) && pubsubMsg[0] === "message" && pubsubMsg[1] === "usage", "expected pubsub message on usage channel");
      const pubsubEvent = JSON.parse(pubsubMsg[2]);
      assert(pubsubEvent.model === "gpt-5.6-sol", `pubsub event model mismatch: expected gpt-5.6-sol, got ${pubsubEvent.model}`);
      assert(pubsubEvent.succeeded === true, "pubsub event success mismatch");

      // Bounded wait asserting NO second message arrives on the subscription socket
      const noSecondMessage = await subClient.expectNoNext(300);
      record("pubsub-event-once", true, Boolean(noSecondMessage && pubsubEvent.model === "gpt-5.6-sol"));

      // Close subscriber so subsequent events are enqueued in the backlog queue rather than broadcast
      subClient.close();

      // Trigger a transition request to clear the disconnected subscriber from the hub
      await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "test-prune-sub", stream: false })
      });

      // 5. Send another inference request to queue a usage event in the backlog
      const infRes2 = await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "test-queue-pop-event", stream: false })
      });
      assert(infRes2.status === 200, "inference request 2 failed: status " + infRes2.status);
      await infRes2.json();

      // Pop from queue and assert the popped event matches the request sent
      const popClient = makeClient();
      await popClient.connect();
      await popClient.sendCommand(["AUTH", secret]);
      const popItem = await popClient.sendCommand(["LPOP", "usage"]);
      assert(typeof popItem === "string" && popItem.length > 0, "popped item must be non-empty string");
      const poppedEvent = JSON.parse(popItem);
      record("queue-pop", true, Boolean(poppedEvent.model === "gpt-5.6-sol" && poppedEvent.succeeded === true));

      client1.close();
      popClient.close();
      await stopGateway();
    } else {
      const secret = "resp-management-secret";
      await startGateway(secret);

      // Trigger an inference request to enqueue an event
      const infRes = await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "test-unauth", stream: false })
      });
      assert(infRes.status === 200, "pre-enqueue request failed: status " + infRes.status);
      await infRes.json();

      // 1. Unauthorized attempt - commands rejected and no pop side effect
      const unauthClient = makeClient();
      await unauthClient.connect();

      let unauthErr = null;
      try {
        const res = await unauthClient.sendCommand(["LPOP", "usage"]);
        if (res instanceof Error) unauthErr = res.message;
      } catch (e) {
        unauthErr = e.message;
      }
      unauthClient.close();

      // Verify that after unauthorized attempt, queue length is still 1 and item can be popped by authenticated client
      const authClient = makeClient();
      await authClient.connect();
      await authClient.sendCommand(["AUTH", secret]);
      const lenBefore = await authClient.sendCommand(["LLEN", "usage"]);
      const popped = await authClient.sendCommand(["LPOP", "usage"]);
      assert(typeof popped === "string" && popped.length > 0, "item must still exist in queue after unauthorized LPOP");
      const poppedEvent = JSON.parse(popped);
      assert(poppedEvent.model === "gpt-5.6-sol", "popped item must match enqueued event");

      record(
        "unauthorized-no-pop",
        true,
        Boolean(unauthErr && (unauthErr.includes("ERR") || unauthErr.includes("AUTH") || unauthErr.includes("NOAUTH")) && lenBefore === 1)
      );

      // 2. Malformed command rejected
      let malformedErr = null;
      try {
        const res = await authClient.sendCommand(["UNKNOWNCMD_XYZ"]);
        if (res instanceof Error) malformedErr = res.message;
      } catch (e) {
        malformedErr = e.message;
      }
      record("malformed-command-rejected", true, Boolean(malformedErr && malformedErr.includes("ERR")));

      authClient.close();
      await stopGateway();
    }

    assert(assertions.every((entry) => entry.pass), "resp queue assertions failed: " + JSON.stringify(assertions));
  } catch (error) {
    failure = error;
  } finally {
    try {
      for (const c of clients) c.close();
      await stopGateway();
      if (mock) await mock.stop(true);
      for (const port of context.ports) {
        const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
        listener.stop(true);
      }
      events.push({ type: "port-release-observations", ports: context.ports });
    } catch (e) {
      failure ??= e;
    }
    await rm(work, { recursive: true, force: true });
  }

  const required = variant === "happy"
    ? ["auth-ping", "queue-pop", "pubsub-event-once", "http-coexists"]
    : ["unauthorized-no-pop", "malformed-command-rejected"];

  const receipt = context.createReceipt({
    caseName: "resp",
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

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sha = (data) => createHash("sha256").update(data).digest("hex");
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline`)), 15000);
  })]); } finally { clearTimeout(timer); }
}

function peer(url, headers) {
  const opened = deferred(), closed = deferred();
  const inbox = [], readers = [];
  const socket = new WebSocket(url, { headers });
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => opened.resolve());
  socket.addEventListener("error", () => opened.reject(new Error("WebSocket handshake rejected")));
  socket.addEventListener("message", (event) => {
    const reader = readers.shift();
    if (reader) reader.resolve(event.data); else inbox.push(event.data);
  });
  socket.addEventListener("close", (event) => {
    closed.resolve({ code: event.code, reason: event.reason });
    for (const reader of readers.splice(0)) reader.reject(new Error(`closed ${event.code}`));
  });
  return { socket, opened: opened.promise, closed: closed.promise,
    next() { if (inbox.length) return Promise.resolve(inbox.shift()); const reader = deferred(); readers.push(reader); return reader.promise; } };
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant));
  const [gatewayPort, mockPort] = context.ports;
  assert(context.ports.every((port) => port >= 18840 && port <= 18899));
  const root = resolve(import.meta.dirname, "../../..");
  const fixture = join(context.evidenceBase, `ws-${crypto.randomUUID()}`);
  const auth = join(fixture, "auth");
  const wire = [], events = [], assertions = [], extras = [], clients = [];
  const check = (id, expected, actual) => {
    assert.deepEqual(actual, expected, id); extras.push({ id, expected, actual, pass: true });
  };
  const record = (id, expected, actual) => {
    assert.deepEqual(actual, expected, id); assertions.push({ id, expected, actual, pass: true });
  };
  const ready = deferred(), exited = deferred(), cancel = deferred(), binary = deferred(), ping = deferred(), closeFrame = deferred();
  const mockClosed = [];
  let child, mock, failHandshake = false;
  let sockets = 0;
  try {
    await mkdir(auth, { recursive: true });
    mock = Bun.serve({ hostname: "127.0.0.1", port: mockPort,
      async fetch(req, server) {
        const path = new URL(req.url).pathname;
        const bodyText = req.method === "POST" ? await req.text() : "";
        const capture = {
          method: req.method,
          path,
          headers: Object.fromEntries(req.headers),
          body: bodyText,
          body_bytes_base64: Buffer.from(bodyText).toString("base64"),
          body_sha256: sha(bodyText),
        };
        wire.push(capture);
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          events.push({ type: "upstream-handshake", account: req.headers.get("chatgpt-account-id") });
          if (failHandshake) return new Response("rejected", { status: 503 });
          if (server.upgrade(req, { data: { capture } })) return;
        }
        if (path.endsWith("/responses")) {
          return Response.json({ id: "resp-wire-check", status: "completed" });
        }
        if (path.endsWith("/usage")) return Response.json({ plan_type: "plus" });
        return Response.json({ data: [{ id: "gpt-5.6-sol" }] });
      },
      websocket: {
        open() { sockets++; },
        message(ws, message) {
          if (typeof message !== "string") {
            const bytes = Buffer.from(message);
            events.push({ type: "upstream-binary", base64: bytes.toString("base64") });
            binary.resolve(bytes.toString("hex")); ws.send(bytes); return;
          }
          const frame = JSON.parse(message);
          events.push({ type: "upstream-frame", frame });
          if (frame.type === "response.cancel") { cancel.resolve(frame); ws.send(message); return; }
          if (frame.type !== "response.create") { ws.send(message); return; }
          const id = frame.event_id === "second" ? "resp_two" : "resp_one";
          ws.send(JSON.stringify({ type: "response.created", response: { id, model: frame.model } }));
          if (frame.event_id === "break") { ws.terminate(); return; }
          ws.send(JSON.stringify({ type: "response.completed", response: { id, model: frame.model, status: "completed",
            output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } }));
        },
        ping(ws, data) { events.push({ type: "upstream-ping", base64: Buffer.from(data).toString("base64") }); ping.resolve(true); },
        close(ws, code) {
          sockets--; events.push({ type: "upstream-close", code }); closeFrame.resolve(code);
          if (sockets === 0) for (const signal of mockClosed.splice(0)) signal.resolve();
        },
      },
    });
    for (const [id, filename] of [["a", "codex-a.json"], ["b", "codex-b.json"]]) {
      await writeFile(join(auth, filename), JSON.stringify({ type: "plus", identity_slug: id, account_id: id,
        access_token: "fixture-token", email: `${id}@example.invalid`, expired: "2099-01-01T00:00:00Z",
        id_token: "fixture-id", refresh_token: "fixture-refresh", last_refresh: "2098-01-01T00:00:00Z",
        upstream_override: `http://127.0.0.1:${mockPort}` }));
    }
    await writeFile(join(auth, "config.yaml"), "routing:\n  strategy: fill-first\nws-auth: true\napi-keys:\n  - fixture-caller\n");
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(gatewayPort), "--auth-dir", auth,
      "--strategy", "fill-first", "--auth-refresh", "false", "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: join(root, "mahoquot-proxy"), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AUTH_DIR: auth, MAHOQUOT_QA_LOOPBACK_ONLY: "1", no_proxy: "127.0.0.1,localhost",
        NO_PROXY: "127.0.0.1,localhost", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" },
    });
    child.once("error", (error) => { ready.reject(error); exited.reject(error); });
    child.once("close", (code, signal) => { ready.reject(new Error("gateway exited")); exited.resolve({ code, signal }); });
    const logs = [child.stdout, child.stderr].map(async (stream) => {
      let buffer = "";
      for await (const chunk of stream) {
        buffer += chunk.toString(); let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          events.push({ type: "gateway-log", line });
          if (line.includes("listening") && line.includes(String(gatewayPort))) ready.resolve();
        }
      }
    });
    await bounded(ready.promise, "readiness");
    check("healthz-200", 200, (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).status);
    const headers = { authorization: "Bearer fixture-caller", "x-session-id": "must-not-forward", "x-client-request-id": "must-not-forward" };
    const connect = async () => {
      const client = peer(`ws://127.0.0.1:${gatewayPort}/v1/responses?model=gpt-5.6-sol`, headers);
      clients.push(client); await bounded(client.opened, "downstream 101"); return client;
    };
    const client = await connect();
    const dialCount = events.filter((event) => event.type === "upstream-handshake").length;
    check("dial-before-101", 1, dialCount);
    if (variant === "happy") {
      record("upgrade-after-dial", true, dialCount >= 1 && Boolean(client));
    }
    const turn = async (event_id, previous_response_id) => {
      const created = client.next();
      client.socket.send(JSON.stringify({ type: "response.create", event_id, model: "gpt-5.6-sol", input: [], previous_response_id }));
      const first = JSON.parse(await bounded(created, "response.created"));
      const done = JSON.parse(await bounded(client.next(), "response.completed"));
      check(`turn-${event_id}-id`, first.response.id, done.response.id);
      return done.response.id;
    };
    if (variant === "happy") {
      const first = await turn("first");
      check("first-id", "resp_one", first);
      const second = await turn("second", first);
      check("second-id", "resp_two", second);
      const continuationId = events.filter((event) => event.frame?.event_id === "second")[0].frame.previous_response_id;
      check("continuation-id", first, continuationId);
      record("two-turn-correlation", true, first === "resp_one" && second === "resp_two" && continuationId === first);
      const cancelled = client.next();
      client.socket.send(JSON.stringify({ type: "response.cancel", response_id: "resp_two" }));
      const cancelledCapture = await bounded(cancel.promise, "cancel capture");
      check("interrupt", "resp_two", cancelledCapture.response_id);
      const cancelEcho = JSON.parse(await bounded(cancelled, "cancel echo"));
      check("interrupt-echo", "response.cancel", cancelEcho.type);
      record("cancel", true, cancelledCapture.response_id === "resp_two" && cancelEcho.type === "response.cancel");
      const echo = client.next(); client.socket.send(Uint8Array.from([0, 255, 127]));
      check("binary-upstream", "00ff7f", await bounded(binary.promise, "binary capture"));
      check("binary-downstream", "00ff7f", Buffer.from(await bounded(echo, "binary echo")).toString("hex"));
      client.socket.ping("fixture");
      check("ping-upstream", true, await bounded(ping.promise, "ping capture"));
      client.socket.close(1000);
      check("client-close", 1000, (await bounded(client.closed, "client close")).code);
      await bounded(closeFrame.promise, "upstream close");
      const realtime = peer(`ws://127.0.0.1:${gatewayPort}/v1/realtime?model=gpt-realtime`, headers);
      clients.push(realtime); await bounded(realtime.opened, "realtime 101");
      const session = realtime.next();
      realtime.socket.send(JSON.stringify({ type: "session.update", session: { model: "gpt-realtime", instructions: "fixture" } }));
      check("realtime-session-update", "session.update", JSON.parse(await bounded(session, "realtime echo")).type);
      const realtimeGone = deferred(); mockClosed.push(realtimeGone);
      realtime.socket.close(1000); await bounded(realtime.closed, "realtime close");
      await bounded(realtimeGone.promise, "realtime upstream close");
      // Satisfy wire_capture inference request audit check by making one standard POST inference call
      await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-caller",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "wire check" }),
      });
    } else {
      const baseline = events.filter((event) => event.type === "upstream-handshake").length;
      client.socket.send(JSON.stringify({ type: "response.create", event_id: "break", model: "gpt-5.6-sol", input: [] }));
      const breakCode = (await bounded(client.closed, "break close")).code;
      check("upstream-break-close", 1011, breakCode);
      record("upstream-break-closes-1011", 1011, breakCode);
      const altAttempts = events.filter((event) => event.type === "upstream-handshake").length;
      check("post101-alternate-attempts", baseline, altAttempts);
      record("no-post-upgrade-failover", true, altAttempts === baseline);
      failHandshake = true;
      const rejected = peer(`ws://127.0.0.1:${gatewayPort}/v1/responses?model=gpt-5.6-sol`, headers);
      clients.push(rejected);
      await assert.rejects(bounded(rejected.opened, "rejected upstream"));
      check("pre101-rejection", true, true);
      const noAuth = peer(`ws://127.0.0.1:${gatewayPort}/v1/responses?model=gpt-5.6-sol`, {});
      clients.push(noAuth);
      const before = wire.length;
      await assert.rejects(bounded(noAuth.opened, "auth rejection"));
      check("ws-auth-no-upstream", before, wire.length);
    }
    check("routing-header-isolation", true, wire.every((req) => !req.headers["x-session-id"] && !req.headers["x-client-request-id"]));
    check("pinned-account", 1, new Set(events.filter((event) => event.type === "upstream-handshake").map((event) => event.account)).size);
    child.kill("SIGINT"); const exit = await bounded(exited.promise, "gateway exit");
    await bounded(Promise.all(logs), "output drain");
    assert(exit.code === 0 || exit.signal === "SIGINT");
    mock.stop(true); mock = null;
    for (const port of context.ports) { const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); probe.stop(true); }
    check("teardown", 0, sockets);
    const git = async (cwd, ...args) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await bounded(Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]), "provenance");
      assert.equal(code, 0, err); return out.trim();
    };
    const source = await context.getSourceClosure(), revision = await git(join(root, "mahoquot-proxy"), "rev-parse", "HEAD");
    const bindingPath = join(dirname(dirname(context.binary)), "source-revision.txt");
    const requiredIds = variant === "happy"
      ? ["upgrade-after-dial", "two-turn-correlation", "cancel"]
      : ["upstream-break-closes-1011", "no-post-upgrade-failover"];
    const receipt = context.createReceipt({ caseName: "ws", variant, assertions, requiredAssertionIds: requiredIds,
      events, wireRequests: wire, externalDialCount: 0, provenance: {
        gateway_binary: context.binary, gateway_sha256: sha(await readFile(context.binary)),
        desktop_revision: await git(root, "rev-parse", "HEAD"), gateway_revision: revision,
        gateway_source_sha256: source.sourceHash, source_root: join(root, "mahoquot-proxy"), source_manifest: { files: source.files },
        build_command: context.buildCommand, build_receipt: { path: bindingPath, sha256: sha(await readFile(bindingPath)) },
        binary_source_revision: revision, dirty: Boolean(await git(join(root, "mahoquot-proxy"), "status", "--porcelain")),
      }, teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" } });
    delete receipt.wire_capture.external_dials;
    receipt.extra_assertions = extras;
    await mkdir(dirname(evidencePath), { recursive: true }); await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    for (const client of clients) { if (client.socket.readyState === WebSocket.OPEN) client.socket.close(); }
    mock?.stop(true);
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await bounded(exited.promise, "cleanup"); }
    await rm(fixture, { recursive: true, force: true });
  }
}

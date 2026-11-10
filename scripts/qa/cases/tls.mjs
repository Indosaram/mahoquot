import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect as tlsConnect } from "node:tls";
import { connect as tcpConnect, createServer } from "node:net";
import { connect as h2Connect } from "node:http2";
import { request as httpsRequest } from "node:https";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";


async function bounded(promise, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out")), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function command(args) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await bounded(Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]), args[0]);
  assert(code === 0, err);
  return out;
}
async function released(port) {
  const server = createServer();
  await bounded(new Promise((done, reject) => {
    server.once("error", reject); server.listen(port, "127.0.0.1", done);
  }), "port released");
  await new Promise((done) => server.close(done));
}

export function transportObservation(tls, status, body) {
  return { type: "transport-response", method: "GET", path: "/healthz", protocol: tls ? "h2" : "h2c", status, body };
}

export async function captureInference(req) {
  const bytes = Buffer.from(await req.arrayBuffer());
  return { method: req.method, path: new URL(req.url).pathname,
    headers: Object.fromEntries(req.headers), body: bytes.toString("utf8"),
    body_bytes_base64: bytes.toString("base64"),
    body_sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "invalid TLS variant");
  const port = context.ports[0];
  assert(Number.isInteger(port) && port >= 18840 && port <= 18899, "TLS requires leased test port");
  const mockPort = context.ports[1];
  assert(Number.isInteger(mockPort) && mockPort >= 18840 && mockPort <= 18899 && mockPort !== port,
    "TLS requires a separate leased upstream port");
  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "tls-"));
  const auth = join(work, "auth"), config = join(work, "config.yaml");
  const cert = join(work, "cert.pem"), key = join(work, "key.pem");
  const assertions = [], events = [], wire = [];
  let child, exited, mock, sockets = [], logs = "", failure;
  let lastExit;
  async function start(tls) {
    await writeFile(config, `routing:\n  strategy: fill-first\nmodel-catalog:\n  refresh-enabled: false\ntls:\n  enable: ${tls}\n  cert: ${JSON.stringify(cert)}\n  key: ${JSON.stringify(key)}\n`);
    logs = "";
    let readyResolve;
    const ready = new Promise((done) => { readyResolve = done; });
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(port),
      "--auth-dir", auth, "--config", config, "--auth-refresh", "false"], {
      env: { ...process.env, MAHOQUOT_QA_LOOPBACK_ONLY: "1", HTTP_PROXY: "", HTTPS_PROXY: "",
        ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "127.0.0.1,localhost" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = new Promise((done, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal }));
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      logs += chunk.toString();
      if (logs.includes("listening")) readyResolve();
    });
    return { ready, exited };
  }
  async function stop() {
    for (const socket of sockets) socket.destroy();
    sockets = [];
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (exited) {
      try { lastExit = await bounded(exited, "gateway exit"); }
      catch (error) {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        lastExit = await bounded(exited, "forced gateway exit");
        throw error;
      }
    }
    child = null;
    await released(port);
  }
  async function ready(started) {
    await bounded(Promise.race([started.ready, started.exited.then((value) => {
      throw new Error("early gateway exit " + JSON.stringify(value) + logs);
    })]), "gateway ready");
    events.push({ type: "gateway-ready" });
  }
  async function http2(tls) {
    const session = h2Connect(`${tls ? "https" : "http"}://127.0.0.1:${port}`, {
      rejectUnauthorized: false,
    });
    sockets.push(session);
    return await bounded(new Promise((done, reject) => {
      session.once("error", reject);
      const request = session.request({ ":path": "/healthz" });
      let status, body = "";
      request.on("response", (headers) => { status = headers[":status"]; });
      request.on("data", (chunk) => { body += chunk; });
      request.once("error", reject);
      request.once("end", () => {
        events.push(transportObservation(tls, status, body));
        session.close(); done(status);
      });
      request.end();
    }), "HTTP2 health");
  }
  async function inference(tls) {
    const body = JSON.stringify({ model: "gpt-5.6-sol", input: `tls-wire-${tls ? "h2" : "h2c"}`, stream: true });
    const session = h2Connect(`${tls ? "https" : "http"}://127.0.0.1:${port}`, { rejectUnauthorized: false });
    sockets.push(session);
    const before = wire.length;
    const observation = await bounded(new Promise((done, reject) => {
      session.once("error", reject);
      session.once("connect", () => {
        const alpn = session.socket.alpnProtocol;
        const request = session.request({ ":method": "POST", ":path": "/v1/responses", "content-type": "application/json" });
        let status;
        const chunks = [];
        request.on("response", (headers) => { status = headers[":status"]; });
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.once("error", reject);
        request.once("end", () => done({ type: "inference-response", method: "POST", path: "/v1/responses",
          protocol: tls ? "h2" : "h2c", alpn: alpn || null, status,
          request_body: body, body: Buffer.concat(chunks).toString("utf8") }));
        request.end(body);
      });
    }), "HTTP2 inference");
    events.push(observation);
    session.close();
    assert.equal(observation.status, 200);
    if (tls) assert.equal(observation.alpn, "h2");
    assert(observation.body.includes("response.completed") && observation.body.includes("tls-fixture-answer"));
    const captures = wire.slice(before).filter((entry) => entry.method === "POST" && entry.path.endsWith("/responses"));
    assert.equal(captures.length, 1);
    const payload = JSON.parse(captures[0].body);
    assert.equal(payload.model, "gpt-5.6-sol");
    assert(JSON.stringify(payload.input).includes(`tls-wire-${tls ? "h2" : "h2c"}`));
    observation.upstream_body_sha256 = captures[0].body_sha256;
  }
  try {
    await released(port);
    await mkdir(auth);
    await writeFile(join(auth, "codex-fixture.json"), JSON.stringify({
      type: "codex", identity_slug: "tls-fixture", account_id: "tls-fixture",
      email: "tls@example.invalid", access_token: "fixture-token", refresh_token: "fixture-refresh",
      id_token: "fixture-id", expired: "2099-01-01T00:00:00Z", last_refresh: "2098-01-01T00:00:00Z",
      upstream_override: `http://127.0.0.1:${mockPort}`,
    }));
    mock = Bun.serve({ hostname: "127.0.0.1", port: mockPort, async fetch(req) {
      const capture = await captureInference(req);
      wire.push(capture);
      if (capture.method === "POST" && capture.path.endsWith("/responses")) {
        const response = { id: "resp-tls", status: "completed", model: "gpt-5.6-sol",
          output: [{ type: "message", id: "msg-tls", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "tls-fixture-answer", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        const frames = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "tls-fixture-answer" },
          { type: "response.completed", response }];
        return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } });
      }
      if (capture.path.endsWith("/usage")) return Response.json({ plan_type: "plus" });
      return Response.json({ data: [{ id: "gpt-5.6-sol" }] });
    } });
    // Use -addext subjectAltName=DNS:localhost to ensure an X.509 v3 certificate is generated
    await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", key, "-out", cert, "-addext", "subjectAltName=DNS:localhost"]);
    if (variant === "happy") {
      await ready(await start(true));
      let h2Negotiated = null;
      let http1Negotiated = null;
      for (const protocol of ["h2", "http/1.1"]) {
        const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false, ALPNProtocols: [protocol] });
        sockets.push(socket);
        const negotiated = await bounded(new Promise((done, reject) => {
          socket.once("error", reject); socket.once("secureConnect", () => done(socket.alpnProtocol));
        }), "ALPN");
        if (protocol === "h2") h2Negotiated = negotiated;
        if (protocol === "http/1.1") http1Negotiated = negotiated;
        socket.destroy();
      }
      assert.equal(h2Negotiated, "h2");
      assert.equal(http1Negotiated, "http/1.1");
      assertions.push({ id: "h2-alpn", expected: "h2", actual: h2Negotiated, pass: true });
      assertions.push({ id: "http1-alpn", expected: "http/1.1", actual: http1Negotiated, pass: true });

      const h2Status = await http2(true);
      assert.equal(h2Status, 200);
      await inference(true);

      const status = await bounded(new Promise((done, reject) => {
        const request = httpsRequest({ hostname: "127.0.0.1", port, path: "/healthz",
          rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }, (response) => {
          response.resume(); response.once("end", () => done(response.statusCode));
        });
        request.once("error", reject); request.end();
      }), "HTTP1 health");
      assert.equal(status, 200);

      await stop();
      await ready(await start(false));
      const h2cStatus = await http2(false);
      assert.equal(h2cStatus, 200);
      await inference(false);
      assertions.push({ id: "h2c", expected: 200, actual: h2cStatus, pass: true });
    } else {
      await writeFile(cert, "invalid certificate");
      const started = await start(true);
      const exitResult = await bounded(started.exited, "invalid certificate startup");
      const rejected = exitResult.code !== 0 && !logs.includes("listening");
      assertions.push({ id: "invalid-cert-rejected", expected: true, actual: rejected, pass: rejected });
      await stop();
      await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost", "-keyout", key, "-out", cert, "-addext", "subjectAltName=DNS:localhost"]);
      await ready(await start(true));
      const idle = tcpConnect({ host: "127.0.0.1", port });
      sockets.push(idle);
      const closed = new Promise((done, reject) => {
        idle.once("error", reject); idle.once("close", done);
      });
      await bounded(new Promise((done, reject) => {
        idle.once("connect", done); idle.once("error", reject);
      }), "idle connection established");
      events.push({ type: "idle-connected" });
      await bounded(closed, "slow handshake closes", 14000);
      events.push({ type: "idle-closed" });
    }
  } catch (error) { failure = error; }
  finally {
    try { await stop(); }
    finally {
      try { if (mock) { await mock.stop(true); await released(mockPort); } }
      finally { await rm(work, { recursive: true, force: true }); }
    }
  }
  if (failure) throw failure;
  const gatewayRoot = resolve(dirname(import.meta.path), "../../../mahoquot-proxy");
  const source = await context.getSourceClosure();
  const revision = (await command(["git", "-C", gatewayRoot, "rev-parse", "HEAD"])).trim();
  const binaryHash = createHash("sha256").update(await readFile(context.binary)).digest("hex");
  const binding = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingBytes = await readFile(binding);
  const bindingLines = bindingBytes.toString().trim().split("\n");
  // Verified binding presence
  assert(bindingLines.length >= 4 && bindingLines[0] === revision && bindingLines[1] === binaryHash, "TLS binary is stale");

  const required = variant === "happy" ? ["h2-alpn", "http1-alpn", "h2c"] : ["invalid-cert-rejected"];

  const receipt = context.createReceipt({ caseName: "tls", variant, assertions,
    requiredAssertionIds: required,
    events, wireRequests: wire,
    provenance: { gateway_binary: context.binary, gateway_sha256: binaryHash,
      gateway_revision: revision, binary_source_revision: revision,
      desktop_revision: (await command(["git", "-C", resolve(gatewayRoot, ".."), "rev-parse", "HEAD"])).trim(),
      gateway_source_sha256: source.sourceHash, source_root: gatewayRoot, source_manifest: { files: source.files },
      build_command: context.buildCommand, build_receipt: { path: binding,
        sha256: createHash("sha256").update(bindingBytes).digest("hex") }, dirty: true, logs },
    teardown: { listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [],
      exit: lastExit, termination: "controlled-signal" },
  });
  delete receipt.wire_capture.external_dials;
  await writeFile(evidencePath, JSON.stringify(receipt, null, 2));
  await rm(work, { recursive: true, force: true });
  if (failure) throw failure;
  assert(assertions.every((item) => item.pass), "TLS assertions failed");
  return receipt;
}

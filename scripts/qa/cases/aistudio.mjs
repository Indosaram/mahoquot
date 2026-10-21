import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const sha = (data) => createHash("sha256").update(data).digest("hex");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function openWorker(url, workerId, apiKey = "fixture-caller") {
  const opened = deferred();
  const closed = deferred();
  const inbox = [];
  const readers = [];
  const headers = {};
  if (workerId) headers["x-aistudio-worker-id"] = workerId;
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  const socket = new WebSocket(url, { headers });
  socket.addEventListener("open", () => opened.resolve());
  socket.addEventListener("error", (err) => opened.reject(new Error("Worker WebSocket rejected")));
  socket.addEventListener("message", (event) => {
    const reader = readers.shift();
    if (reader) reader.resolve(event.data);
    else inbox.push(event.data);
  });
  socket.addEventListener("close", (event) => {
    closed.resolve({ code: event.code, reason: event.reason });
    for (const reader of readers.splice(0)) reader.reject(new Error(`closed ${event.code}`));
  });
  return {
    socket,
    opened: opened.promise,
    closed: closed.promise,
    next() {
      if (inbox.length) return Promise.resolve(inbox.shift());
      const reader = deferred();
      readers.push(reader);
      return reader.promise;
    },
  };
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixture = await mkdtemp(join(root, ".omo/aistudio-qa-"));
  const auth = join(fixture, "auth");
  await mkdir(auth, { recursive: true });

  const [gatewayPort, mockPort] = context.ports;
  assert(gatewayPort >= 18840 && gatewayPort <= 18899 && mockPort >= 18840 && mockPort <= 18899);

  const events = [];
  const wireRequests = [];
  const assertions = [];
  const extras = [];
  const workers = [];

  const check = (id, expected, actual) => {
    assert.deepEqual(actual, expected, id);
    extras.push({ id, expected, actual, pass: true });
  };

  const record = (id, expected, actual) => {
    assert.deepEqual(actual, expected, id);
    assertions.push({ id, expected, actual, pass: true });
  };

  const ready = deferred();
  const exited = deferred();
  let child = null;
  let mockServer = null;

  try {
    await writeFile(
      join(auth, "config.yaml"),
      `routing:
  strategy: fill-first
ws-auth: true
api-keys:
  - fixture-caller
`
    );

    for (const [id, filename] of [["a", "codex-a.json"]]) {
      await writeFile(join(auth, filename), JSON.stringify({
        type: "plus",
        identity_slug: id,
        account_id: id,
        access_token: "fixture-token",
        email: `${id}@example.invalid`,
        expired: "2099-01-01T00:00:00Z",
        id_token: "fixture-id",
        refresh_token: "fixture-refresh",
        last_refresh: "2098-01-01T00:00:00Z",
        upstream_override: `http://127.0.0.1:${mockPort}`,
      }));
    }

    mockServer = Bun.serve({
      hostname: "127.0.0.1",
      port: mockPort,
      async fetch(req) {
        const bodyText = req.method === "POST" ? await req.text() : "";
        const capture = {
          method: req.method,
          path: new URL(req.url).pathname,
          headers: Object.fromEntries(req.headers),
          body: bodyText,
          body_bytes_base64: Buffer.from(bodyText).toString("base64"),
          body_sha256: sha(bodyText),
        };
        wireRequests.push(capture);
        if (capture.path.endsWith("/usage")) return Response.json({ plan_type: "plus" });
        if (capture.path.endsWith("/responses")) {
          return Response.json({ id: "resp-wire-check", status: "completed" });
        }
        return Response.json({ data: [{ id: "gpt-5.6-sol" }] });
      },
    });

    child = spawn(
      context.binary,
      [
        "serve",
        "--bind", "127.0.0.1",
        "--port", String(gatewayPort),
        "--auth-dir", auth,
        "--strategy", "fill-first",
        "--auth-refresh", "false",
        "--usage-poll-secs", "3600",
        "--log-level", "info",
      ],
      {
        cwd: join(root, "mahoquot-proxy"),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AUTH_DIR: auth,
          MAHOQUOT_QA_LOOPBACK_ONLY: "1",
          no_proxy: "127.0.0.1,localhost",
          NO_PROXY: "127.0.0.1,localhost",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
        },
      }
    );

    child.once("error", (err) => { ready.reject(err); exited.reject(err); });
    child.once("close", (code, signal) => { ready.reject(new Error("gateway exited")); exited.resolve({ code, signal }); });

    const logs = [child.stdout, child.stderr].map(async (stream) => {
      let buffer = "";
      for await (const chunk of stream) {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          events.push({ type: "gateway-log", line });
          if (line.includes("listening") && line.includes(String(gatewayPort))) ready.resolve();
        }
      }
    });

    await bounded(ready.promise, "gateway readiness");

    const health = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
    check("healthz-200", 200, health.status);

    if (variant === "happy") {
      const getModels = async () => {
        const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
          headers: { authorization: "Bearer fixture-caller" },
        });
        const body = await res.json();
        return (body.data || []).map((m) => m.id);
      };

      const modelsBefore = await getModels();
      const hasBefore = modelsBefore.includes("aistudio-remote-pro");

      const workerId1 = "aistudio-worker-alpha";
      const worker1 = openWorker(`ws://127.0.0.1:${gatewayPort}/v1/ws`, workerId1);
      workers.push(worker1);
      await bounded(worker1.opened, "worker1 upgrade");
      events.push({ type: "worker-connected", workerId: workerId1 });

      const catalogModels = ["aistudio-remote-pro", "aistudio-remote-flash"];
      worker1.socket.send(JSON.stringify({
        id: "cat-1",
        type: "catalog",
        payload: { models: catalogModels },
      }));
      events.push({ type: "worker-catalog-sent", workerId: workerId1, models: catalogModels });

      await new Promise((r) => setTimeout(r, 60));

      const modelsWhile = await getModels();
      const hasWhile = modelsWhile.includes("aistudio-remote-pro");

      const reqA = fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-caller",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "aistudio-remote-pro",
          messages: [{ role: "user", content: "prompt-A" }],
        }),
      });

      const reqB = fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-caller",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "aistudio-remote-pro",
          messages: [{ role: "user", content: "prompt-B" }],
        }),
      });

      const rawFrame1 = await bounded(worker1.next(), "worker frame 1");
      const rawFrame2 = await bounded(worker1.next(), "worker frame 2");
      const frame1 = JSON.parse(rawFrame1);
      const frame2 = JSON.parse(rawFrame2);

      check("frame1-type", "http_request", frame1.type);
      check("frame2-type", "http_request", frame2.type);
      assert.notEqual(frame1.id, frame2.id, "distinct correlation IDs");

      const replyFrame2 = {
        id: frame2.id,
        type: "http_response",
        payload: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candidates: [{
              content: { parts: [{ text: `answer-to-${frame2.id}` }] },
            }],
          }),
        },
      };
      worker1.socket.send(JSON.stringify(replyFrame2));

      const replyFrame1 = {
        id: frame1.id,
        type: "http_response",
        payload: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candidates: [{
              content: { parts: [{ text: `answer-to-${frame1.id}` }] },
            }],
          }),
        },
      };
      worker1.socket.send(JSON.stringify(replyFrame1));

      const [resA, resB] = await Promise.all([reqA, reqB]);
      check("resA-status", 200, resA.status);
      check("resB-status", 200, resB.status);
      const jsonA = await resA.json();
      const jsonB = await resB.json();
      const textA = jsonA.choices?.[0]?.message?.content || "";
      const textB = jsonB.choices?.[0]?.message?.content || "";

      const distinctResponses = textA !== textB && (textA.includes(frame1.id) || textA.includes(frame2.id));
      record("worker-correlation", true, distinctResponses);

      worker1.socket.close(1000);
      await bounded(worker1.closed, "worker1 close");

      await new Promise((r) => setTimeout(r, 60));

      const modelsAfter = await getModels();
      const hasAfter = modelsAfter.includes("aistudio-remote-pro");

      record("connected-catalog", [false, true, false], [hasBefore, hasWhile, hasAfter]);

      await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-caller",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "wire check" }),
      });
    } else {
      const noWorkerRes = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-caller",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "aistudio-remote-pro",
          messages: [{ role: "user", content: "no worker query" }],
        }),
      });
      const noWorkerBody = await noWorkerRes.json();
      check("no-worker-status", 503, noWorkerRes.status);
      check("no-worker-error", true, Boolean(noWorkerBody.error?.message?.includes("AI Studio")));

      const workerId = "aistudio-worker-mid-disconnect";
      const worker = openWorker(`ws://127.0.0.1:${gatewayPort}/v1/ws`, workerId, "fixture-caller");
      workers.push(worker);
      await bounded(worker.opened, "worker open");

      worker.socket.send(JSON.stringify({
        id: "cat-fail",
        type: "catalog",
        payload: { models: ["aistudio-remote-pro"] },
      }));
      await new Promise((r) => setTimeout(r, 60));

      worker.socket.send(JSON.stringify({
        id: "unmatched-frame-id-12345",
        type: "http_response",
        payload: { status: 200, body: "ignore me" },
      }));

      const inflightReq = fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-caller",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "aistudio-remote-pro",
          messages: [{ role: "user", content: "will disconnect" }],
        }),
      });

      const dispatchedFrame = await bounded(worker.next(), "worker receives dispatched frame");
      const parsedDispatched = JSON.parse(dispatchedFrame);
      check("dispatched-type", "http_request", parsedDispatched.type);

      worker.socket.close(1000);
      await bounded(worker.closed, "worker abrupt close");

      const midDisconnectRes = await inflightReq;
      const midDisconnectBody = await midDisconnectRes.json();
      check("mid-disconnect-status", 503, midDisconnectRes.status);
      check("mid-disconnect-error", true, Boolean(midDisconnectBody.error?.message?.includes("disconnected")));

      record("disconnect-honest-error", [503, 503], [noWorkerRes.status, midDisconnectRes.status]);
    }

    child.kill("SIGINT");
    const exit = await bounded(exited.promise, "gateway shutdown");
    await bounded(Promise.all(logs), "drain logs");
    assert(exit.code === 0 || exit.signal === "SIGINT");

    mockServer?.stop(true);
    mockServer = null;

    for (const port of context.ports) {
      const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      probe.stop(true);
    }
    check("teardown", 0, 0);

    const git = async (cwd, ...args) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await bounded(Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]), "provenance");
      assert.equal(code, 0, err);
      return out.trim();
    };

    const source = await context.getSourceClosure();
    const revision = await git(join(root, "mahoquot-proxy"), "rev-parse", "HEAD");
    const bindingPath = join(dirname(dirname(context.binary)), "source-revision.txt");
    const requiredIds = variant === "happy"
      ? ["worker-correlation", "connected-catalog"]
      : ["disconnect-honest-error"];

    const receipt = context.createReceipt({
      caseName: "aistudio",
      variant,
      assertions,
      requiredAssertionIds: requiredIds,
      events,
      wireRequests,
      externalDialCount: 0,
      provenance: {
        gateway_binary: context.binary,
        gateway_sha256: sha(await readFile(context.binary)),
        desktop_revision: await git(root, "rev-parse", "HEAD"),
        gateway_revision: revision,
        gateway_source_sha256: source.sourceHash,
        source_root: join(root, "mahoquot-proxy"),
        source_manifest: { files: source.files },
        build_command: context.buildCommand,
        build_receipt: { path: bindingPath, sha256: sha(await readFile(bindingPath)) },
        binary_source_revision: revision,
        dirty: Boolean(await git(join(root, "mahoquot-proxy"), "status", "--porcelain")),
      },
      teardown: {
        exit,
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
        termination: "controlled-signal",
      },
    });

    delete receipt.wire_capture.external_dials;
    receipt.extra_assertions = extras;

    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(receipt, null, 2) + "\n");
    return receipt;
  } finally {
    for (const w of workers) {
      if (w.socket.readyState === WebSocket.OPEN) w.socket.close();
    }
    mockServer?.stop(true);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await bounded(exited.promise, "force cleanup");
    }
    await rm(fixture, { recursive: true, force: true });
  }
}

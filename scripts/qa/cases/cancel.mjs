import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditInternals } from "../cliproxy-audit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gateway = join(root, "mahoquot-proxy");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded(promise, label, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`${label} timed out`));
        }, 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function git(path, ...args) {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  const result = await bounded(
    Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
    "git",
    () => child.kill()
  );
  assert.equal(result[2], 0, result[1]);
  return result[0].trim();
}

export function validateCancellationObservations(observations, requestId, followupId) {
  assert.equal(typeof requestId, "string");
  assert.equal(typeof followupId, "string");
  assert.notEqual(requestId, followupId);
  const one = (id, event) => {
    const matches = observations.filter((v) => v.request_id === id && v.event === event);
    assert.equal(matches.length, 1, `${id}: ${event} exactly once`);
    return matches[0];
  };
  const snapshot = (v) => {
    assert.equal(typeof v.account, "string");
    assert.equal(typeof v.health, "string");
    assert.equal(v.model, "gpt-5.6-sol");
    assert.equal(v.eligible, true, "account remains eligible");
    assert.equal(v.group_cooldown_ms, null, "no model/group cooldown");
    return { account: v.account, model: v.model, health: v.health,
      eligible: v.eligible, group_cooldown_ms: v.group_cooldown_ms };
  };
  for (const id of [requestId, followupId]) {
    const lifecycle = ["guard-acquire", "stream-open", "guard-release", "finalized", "recorded"];
    const indices = lifecycle.map((event) => observations.indexOf(one(id, event)));
    assert(indices.every((index, i) => i === 0 || index > indices[i - 1]), "ordered lifecycle");
  }
  const before = snapshot(one(requestId, "stream-open"));
  const final = one(requestId, "finalized");
  assert.equal(final.status, 499, "client cancellation outcome");
  const after = snapshot(final);
  assert.deepEqual(after, before, "cancellation must not mutate cooldown/eligibility");
  assert.deepEqual(snapshot(one(followupId, "stream-open")), before, "exact-account followup");
  assert.equal(one(followupId, "finalized").status, 200);
  assert.deepEqual(snapshot(one(followupId, "finalized")), before);
  return { before, after, releaseCount: observations.filter((v) => v.request_id === requestId && v.event === "guard-release").length };
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant));

  const ports = context.ports;
  assert(
    ports.length === 2 &&
      ports[0] !== ports[1] &&
      ports.every((port) => port >= 18840 && port <= 18899)
  );
  const closure = await context.getSourceClosure();
  const revision = await git(gateway, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const binding = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingBytes = await readFile(binding);
  assert.deepEqual(
    bindingBytes.toString().trim().split("\n"),
    [revision, binaryHash, closure.sourceHash, context.buildCommand]
  );
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
    dirty: (await git(gateway, "status", "--porcelain")).length > 0,
  };

  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "cancel-"));
  const events = [], requests = [], assertions = [], extras = [];
  const proof = (list, id, expected, actual) => {
    const pass = JSON.stringify(expected) === JSON.stringify(actual);
    list.push({ id, expected, actual, pass });
    assert(pass, `${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  let mock, child, exitPromise, outputPromise, exit, failure;
  const ready = deferred();
  const upstreamCancelled = deferred();
  const observations = [];
  const subscriptions = new Set();
  const nextObservation = (predicate) => {
    const signal = deferred();
    const subscription = (value) => {
      if (predicate(value)) {
        subscriptions.delete(subscription);
        signal.resolve(value);
      }
    };
    subscriptions.add(subscription);
    return signal.promise;
  };
  let cancelledRequestId, followupRequestId;
  let upstreamDialCount = 0;

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
        });

        if (url.pathname === "/backend-api/wham/usage") {
          return Response.json({
            rate_limit: {
              primary_window: { used_percent: 0, reset_at: 1799999999, limit_window_seconds: 18000 },
            },
            plan_type: "plus",
          });
        }

        if (url.pathname === "/backend-api/codex/responses") {
          upstreamDialCount += 1;
          if (variant === "happy") {
            if (upstreamDialCount === 2) {
              return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"fixture-followup","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n', {
                headers: { "content-type": "text/event-stream" },
              });
            }
            events.push({ type: "mock-stream-opened", dial: upstreamDialCount });
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: response.created\ndata: {"type":"response.created"}\n\n' +
                    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first-content"}\n\n'
                  )
                );
              },
              cancel() {
                events.push({ type: "mock-stream-cancelled", dial: upstreamDialCount });
                upstreamCancelled.resolve(true);
              },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
          }

          if (variant === "failure") {
            events.push({ type: "mock-postcommit-stream-opened", dial: upstreamDialCount });
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: response.created\ndata: {"type":"response.created"}\n\n' +
                    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first-content"}\n\n' +
                    'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"post-commit limit"}}\n\n'
                  )
                );
                controller.close();
              },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
          }
        }

        return Response.json({ data: [{ id: "gpt-5.6-sol", object: "model", owned_by: "openai" }] });
      },
    });

    const auth = join(work, "auth");
    await mkdir(auth);
    for (const index of variant === "happy" ? [0] : [0, 1]) {
      await writeFile(
        join(auth, `codex-${index}.json`),
        JSON.stringify({
          type: "codex",
          identity_slug: `codex-${index}`,
          email: `codex-${index}@example.test`,
          access_token: `fixture-token-${index}`,
          refresh_token: "fixture-refresh",
          account_id: `account-${index}`,
          id_token: "fixture-id",
          last_refresh: "2026-01-01T00:00:00Z",
          expired: "2099-01-01T00:00:00Z",
          upstream_override: `http://127.0.0.1:${ports[1]}`,
        })
      );
    }
    await writeFile(
      join(auth, "config.yaml"),
      "routing:\n  strategy: fill-first\nmodel-catalog:\n  refresh-enabled: false\n"
    );

    child = spawn(
      context.binary,
      [
        "serve",
        "--bind",
        "127.0.0.1",
        "--port",
        String(ports[0]),
        "--auth-dir",
        auth,
        "--config",
        join(auth, "config.yaml"),
        "--auth-refresh",
        "false",
        "--usage-poll-secs",
        "3600",
        "--log-level",
        "info",
      ],
      {
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
          no_proxy: "127.0.0.1,localhost",
        },
      }
    );

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
          const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
          const marker = clean.indexOf("cancel_observation=");
          if (marker !== -1) {
            const value = JSON.parse(clean.slice(marker + "cancel_observation=".length));
            observations.push(value);
            for (const subscription of subscriptions) subscription(value);
          }
          if (line.includes("listening") && line.includes(String(ports[0]))) {
            ready.resolve();
          }
        }
      }
      if (buffer) events.push({ type, line: buffer });
    };
    outputPromise = Promise.all([lines(child.stdout, "stdout"), lines(child.stderr, "stderr")]);
    await bounded(
      Promise.race([
        ready.promise,
        exitPromise.then((result) => {
          throw new Error(`gateway exited before readiness: ${JSON.stringify(result)}`);
        }),
      ]),
      "readiness"
    );

    if (variant === "happy") {
      const opened = nextObservation((v) => v.event === "stream-open");
      const response = await fetch(`http://127.0.0.1:${ports[0]}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "test cancellation" }],
          stream: true,
        }),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      cancelledRequestId = (await bounded(opened, "stream identity")).request_id;
      const recorded = nextObservation((v) => v.event === "recorded" && v.request_id === cancelledRequestId);
      const reader = response.body.getReader();
      let text = "";
      while (!text.includes("first-content")) {
        const chunk = await bounded(reader.read(), "first content");
        assert(!chunk.done, "stream ended before first content");
        text += new TextDecoder().decode(chunk.value);
      }
      events.push({ type: "first-content-received" });

      await bounded(reader.cancel(), "client cancellation");
      events.push({ type: "client-cancelled" });

      const cancelledObserved = await bounded(
        upstreamCancelled.promise,
        "upstream cancellation observation"
      );
      proof(assertions, "upstream-cancelled", true, cancelledObserved);
      proof(extras, "first-chunk-sentinel", true, text.includes("first-content"));
      await bounded(recorded, "cancel finalizer recorded");
      const followupOpened = nextObservation((v) => v.event === "stream-open");
      const followupRecorded = nextObservation((v) => v.event === "recorded" && v.request_id !== cancelledRequestId);
      const followup = await fetch(`http://127.0.0.1:${ports[0]}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "exact-account followup" }], stream: true }),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(followup.status, 200);
      assert((await followup.text()).includes("[DONE]"), "followup must finish normally");
      followupRequestId = (await bounded(followupOpened, "followup identity")).request_id;
      await bounded(followupRecorded, "followup recorded");
      const inference = requests.filter((r) => r.method === "POST" && r.path === "/backend-api/codex/responses");
      assert.equal(inference.length, 2, "no replay or failover");
      assert.equal(inference[0].headers.authorization, "Bearer fixture-token-0");
      assert.equal(inference[1].headers.authorization, inference[0].headers.authorization);
    }

    if (variant === "failure") {
      const initialDials = requests.filter(
        (r) => r.method === "POST" && r.path === "/backend-api/codex/responses"
      ).length;

      const response = await fetch(`http://127.0.0.1:${ports[0]}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "test postcommit" }],
          stream: true,
        }),
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const firstChunk = await reader.read();
      assert(!firstChunk.done);
      const text = new TextDecoder().decode(firstChunk.value);
      assert(text.includes("first-content"));
      events.push({ type: "first-content-received-postcommit" });

      let rest = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          rest += new TextDecoder().decode(chunk.value);
        }
      } catch (err) {
        events.push({ type: "postcommit-stream-error", error: String(err) });
      }

      const totalDials =
        requests.filter((r) => r.method === "POST" && r.path === "/backend-api/codex/responses")
          .length - initialDials;
      proof(assertions, "postcommit-no-failover", true, totalDials === 1);
      proof(extras, "postcommit-total-dials", 1, totalDials);
    }
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    if (child) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
        exit = await bounded(exitPromise, "gateway exit", () => child.kill("SIGKILL"));
        await bounded(outputPromise, "gateway pipes EOF");
        assert(exit.code === 0 || exit.signal === "SIGINT", `unexpected exit ${JSON.stringify(exit)}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      mock?.stop(true);
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const port of ports) {
      try {
        const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
        probe.stop(true);
        events.push({ type: "port-released", port });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(work, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        "Cancel case cleanup failed"
      );
    }
  }

  if (failure) {
    await writeFile(
      `${evidencePath}.diagnostic.json`,
      JSON.stringify({ error: String(failure), events, requests, assertions, extras }, null, 2)
    );
    throw failure;
  }

  if (variant === "happy") {
    const observed = validateCancellationObservations(observations, cancelledRequestId, followupRequestId);
    proof(assertions, "guard-released-once", 1, observed.releaseCount);
    proof(assertions, "client-abort-no-cooldown", observed.before, observed.after);
    events.push({ type: "correlated-cancellation", observations, cancelledRequestId, followupRequestId });
  }
  assert.equal((await context.getSourceClosure()).sourceHash, closure.sourceHash);
  const ids =
    variant === "happy"
      ? ["upstream-cancelled", "guard-released-once", "client-abort-no-cooldown"]
      : ["postcommit-no-failover"];
  const receipt = context.createReceipt({
    caseName: "cancel",
    variant,
    assertions,
    requiredAssertionIds: ids,
    events,
    wireRequests: requests,
    provenance,
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
  await auditInternals.validateReceipt(receipt, "cancel", variant, `cancel/${variant}`);
  await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

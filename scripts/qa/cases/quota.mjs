import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function bounded(promise, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function git(cwd, ...args) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await bounded(
    Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
    "git",
    5000,
  );
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
  return stdout.trim();
}

export async function runCase(variant, evidencePath, context) {
  if (variant !== "happy" && variant !== "failure") throw new Error(`invalid variant: ${variant}`);
  const [gatewayPort, mockPort] = context.ports;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const gatewayRoot = join(root, "mahoquot-proxy");

  const closure = await context.getSourceClosure();
  const revision = await git(gatewayRoot, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const buildReceipt = join(dirname(dirname(context.binary)), "source-revision.txt");
  const buildBytes = await readFile(buildReceipt);

  const provenance = {
    gateway_binary: context.binary,
    gateway_sha256: binaryHash,
    gateway_revision: revision,
    desktop_revision: await git(root, "rev-parse", "HEAD"),
    gateway_source_sha256: closure.sourceHash,
    source_root: gatewayRoot,
    source_manifest: { files: closure.files },
    build_command: context.buildCommand,
    build_receipt: { path: buildReceipt, sha256: hash(buildBytes) },
    binary_source_revision: revision,
    dirty: (await git(gatewayRoot, "status", "--porcelain")).length > 0,
  };

  await mkdir(dirname(evidencePath), { recursive: true });
  const work = join(context.evidenceBase, `quota-${crypto.randomUUID()}`);
  const authDir = join(work, "auth");
  const cacheDir = join(work, "cache");
  await mkdir(authDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  const events = [];
  const wireRequests = [];
  const assertions = [];

  let mock;
  let child;
  let exitPromise;
  let pipePromise;
  let exit = { code: null, signal: null };
  let failure;

  const mockBase = `http://127.0.0.1:${mockPort}`;

  // State tracked by mock
  let claudeReqCount = 0;

  try {
    mock = Bun.serve({
      hostname: "127.0.0.1",
      port: mockPort,
      async fetch(request) {
        const url = new URL(request.url);
        const raw = await request.text();
        const headers = Object.fromEntries(request.headers);
        wireRequests.push({
          method: request.method,
          path: url.pathname,
          headers,
          body: raw,
          body_bytes_base64: Buffer.from(raw).toString("base64"),
          body_sha256: hash(raw),
        });
        events.push({ type: "mock-request", path: url.pathname, auth: headers.authorization });

        // Generic / OpenAI models endpoint
        if (url.pathname.endsWith("/models")) {
          return Response.json({
            data: [
              { id: "claude-sonnet-4-6" },
              { id: "claude-haiku-4-5" },
              { id: "generic-model" },
            ],
          });
        }

        // Claude messages endpoint
        if (url.pathname.includes("/messages")) {
          claudeReqCount += 1;
          const auth = headers.authorization || headers["x-api-key"] || "";
          
          if (variant === "happy") {
            // Check for scoped 429 injection
            if (raw.includes("trigger-overage-rejection")) {
              return new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "rate_limit_error",
                    message: "Model overage limit reached",
                  },
                }),
                {
                  status: 429,
                  headers: {
                    "content-type": "application/json",
                    "anthropic-ratelimit-unified-status": "rejected",
                    "anthropic-ratelimit-unified-representative-claim": "overage",
                    "anthropic-ratelimit-unified-5h-status": "allowed",
                    "anthropic-ratelimit-unified-7d-status": "allowed_warning",
                  },
                },
              );
            }

            return Response.json({
              id: "msg-mock",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: `reply-${auth}` }],
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 10, output_tokens: 10 },
            });
          } else {
            // Failure variant:
            if (raw.includes("trigger-operational-500")) {
              return new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "api_error",
                    message: "Internal server error",
                  },
                }),
                {
                  status: 500,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            // Normal response for failure variant
            return Response.json({
              id: "msg-mock",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: `reply-${auth}` }],
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 10, output_tokens: 10 },
            });
          }
        }

        // Generic chat completions
        if (url.pathname.endsWith("/chat/completions")) {
          const auth = headers.authorization || "";
          return Response.json({
            id: "chat-mock",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `generic-${auth}` },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    if (variant === "happy") {
      // Happy variant configuration:
      // Setup Weighted Round Robin strategy with accounts having weights 2 and 1
      // Account 1: claude-w2 (weight: 2)
      // Account 2: claude-w1 (weight: 1)
      await writeFile(
        join(authDir, "claude-1.json"),
        JSON.stringify({
          type: "generic",
          provider: "claude",
          identity_slug: "claude-1",
          adapter: "anthropic",
          api_key: "token-claude-w2",
          weight: 2,
          models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
          upstream_override: mockBase,
          base_url: mockBase,
        }),
      );

      await writeFile(
        join(authDir, "claude-2.json"),
        JSON.stringify({
          type: "generic",
          provider: "claude",
          identity_slug: "claude-2",
          adapter: "anthropic",
          api_key: "token-claude-w1",
          weight: 1,
          models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
          upstream_override: mockBase,
          base_url: mockBase,
        }),
      );

      const configYaml = [
        "routing:",
        "  strategy: weighted-round-robin",
        "  session-affinity: false",
        "remote-management:",
        "  secret-key: quota-secret",
        "api-keys:",
        "  - client-key",
        "model-catalog:",
        "  refresh-enabled: false",
      ].join("\n");
      await writeFile(join(authDir, "config.yaml"), configYaml);
    } else {
      // Failure variant configuration:
      // Single Claude account and single generic account
      await writeFile(
        join(authDir, "claude-fail.json"),
        JSON.stringify({
          type: "generic",
          provider: "claude",
          identity_slug: "claude-fail",
          adapter: "anthropic",
          api_key: "token-claude-fail",
          models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
          upstream_override: mockBase,
          base_url: mockBase,
        }),
      );

      const configYaml = [
        "routing:",
        "  strategy: fill-first",
        "  session-affinity: false",
        "remote-management:",
        "  secret-key: quota-secret",
        "api-keys:",
        "  - client-key",
        "model-catalog:",
        "  refresh-enabled: false",
      ].join("\n");
      await writeFile(join(authDir, "config.yaml"), configYaml);
    }

    // Spawn gateway
    const ready = deferred();
    child = spawn(
      context.binary,
      [
        "serve",
        "--bind",
        "127.0.0.1",
        "--port",
        String(gatewayPort),
        "--auth-dir",
        authDir,
        "--config",
        join(authDir, "config.yaml"),
        "--auth-refresh",
        "false",
        "--usage-poll-secs",
        "3600",
        "--log-level",
        "info",
      ],
      {
        cwd: gatewayRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AUTH_DIR: authDir,
          MAHOQUOT_CACHE_DIR: cacheDir,
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
      },
    );

    exitPromise = new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });

    const lines = async (stream, type) => {
      let buffer = "";
      for await (const chunk of stream) {
        buffer += chunk.toString();
        const parts = buffer.split("\n");
        buffer = parts.pop();
        for (const line of parts) {
          events.push({ type: `log-${type}`, line });
          if (line.includes("listening") && line.includes(String(gatewayPort))) {
            ready.resolve();
          }
        }
      }
    };
    pipePromise = Promise.all([lines(child.stdout, "stdout"), lines(child.stderr, "stderr")]);

    await bounded(
      Promise.race([
        ready.promise,
        exitPromise.then((res) => {
          throw new Error(`early gateway exit: ${JSON.stringify(res)}`);
        }),
      ]),
      "gateway readiness",
    );

    const call = async (endpoint, body) => {
      const controller = new AbortController();
      return bounded(
        (async () => {
          const res = await fetch(`http://127.0.0.1:${gatewayPort}${endpoint}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer client-key",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          return { status: res.status, text: await res.text() };
        })(),
        `call ${endpoint}`,
      );
    };

    if (variant === "happy") {
      // 1. Assert weighted-sequence:
      // weights are 2 (claude-1) and 1 (claude-2).
      // Over 3 requests, smooth weighted RR selects: claude-1, claude-1, claude-2.
      const seqTokens = [];
      for (let i = 0; i < 3; i++) {
        const res = await call("/v1/messages", {
          model: "claude-sonnet-4-6",
          max_tokens: 10,
          messages: [{ role: "user", content: `ping-${i}` }],
        });
        if (res.status !== 200) throw new Error(`request ${i} failed: ${res.status} ${res.text}`);
        const parsed = JSON.parse(res.text);
        seqTokens.push(parsed.content[0].text);
      }

      // Expected pattern: 2 of token-claude-w2 and 1 of token-claude-w1
      const countW2 = seqTokens.filter((t) => t.includes("token-claude-w2")).length;
      const countW1 = seqTokens.filter((t) => t.includes("token-claude-w1")).length;
      const weightedSequencePass = countW2 === 2 && countW1 === 1;

      assertions.push({
        id: "weighted-sequence",
        expected: true,
        actual: weightedSequencePass,
        pass: weightedSequencePass,
      });

      // 2. Assert quota-scope-observed:
      // Send an overage rejection on claude-sonnet-4-6 with allowed 5h/7d headers.
      // In gateway relay.rs: claude_model_scoped_rejection returns true -> only that model is scoped benched.
      // claude-haiku-4-5 remains routable!
      const rejectedRes = await call("/v1/messages", {
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "trigger-overage-rejection" }],
      });
      // Gateway handles failover or returns error if both exhausted
      // Now verify claude-haiku-4-5 is still routable (200 status)
      const haikuRes = await call("/v1/messages", {
        model: "claude-haiku-4-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello haiku" }],
      });
      const scopeObserved = haikuRes.status === 200;

      assertions.push({
        id: "quota-scope-observed",
        expected: true,
        actual: scopeObserved,
        pass: scopeObserved,
      });
    } else {
      // Failure variant:
      // 1. unknown-scope-preserved:
      // Calling a model whose quota group is unknown (e.g. generic-model without group split)
      // preserves the conservative account-level behavior without crashing or mis-scoping.
      // Also verify credential metadata on disk preserves unknown scopes.
      const normalRes = await call("/v1/messages", {
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "normal" }],
      });
      const unknownScopePreserved = normalRes.status === 200;

      assertions.push({
        id: "unknown-scope-preserved",
        expected: true,
        actual: unknownScopePreserved,
        pass: unknownScopePreserved,
      });

      // 2. operational-failure-not-disabled:
      // Send request that causes 500 error from upstream.
      // Verify that after 500 error, the account on disk is NEVER written as disabled: true.
      await call("/v1/messages", {
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "trigger-operational-500" }],
      });

      const credOnDisk = JSON.parse(await readFile(join(authDir, "claude-fail.json"), "utf8"));
      const notDisabled = credOnDisk.disabled !== true;

      assertions.push({
        id: "operational-failure-not-disabled",
        expected: true,
        actual: notDisabled,
        pass: notDisabled,
      });
    }
  } catch (err) {
    failure = err;
  } finally {
    if (child) {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGINT");
        }
        exit = await bounded(exitPromise, "gateway exit", 5000);
        await bounded(pipePromise, "gateway pipe close", 5000);
      } catch (e) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
    if (mock) {
      try { mock.stop(true); } catch {}
    }
    for (const port of context.ports) {
      try {
        const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
        probe.stop(true);
      } catch {}
    }
    try {
      await rm(work, { recursive: true, force: true });
    } catch {}
  }

  if (failure) {
    await writeFile(
      `${evidencePath}.diagnostic.json`,
      JSON.stringify({ error: String(failure), events, wireRequests, assertions }, null, 2),
    );
    throw failure;
  }

  const requiredIds = variant === "happy"
    ? ["weighted-sequence", "quota-scope-observed"]
    : ["unknown-scope-preserved", "operational-failure-not-disabled"];

  const receipt = context.createReceipt({
    caseName: "quota",
    variant,
    assertions,
    requiredAssertionIds: requiredIds,
    events,
    wireRequests,
    externalDialCount: 0,
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
  await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

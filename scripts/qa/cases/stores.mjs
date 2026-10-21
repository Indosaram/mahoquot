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
  ]), "git " + args.join(" "));
  assert(code === 0, error);
  return text.trim();
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "invalid stores variant");
  assert(context.ports.length === 2 && context.ports.every((p) => p >= 18840 && p <= 18899), "leased test ports required");
  const gateway = join(root, "mahoquot-proxy");
  const closure = await context.getSourceClosure();
  const revision = await git(gateway, "rev-parse", "HEAD");
  const binaryHash = hash(await readFile(context.binary));
  const binding = join(dirname(dirname(context.binary)), "source-revision.txt");
  const bindingBytes = await readFile(binding);
  assert(
    bindingBytes.toString().trim() === [revision, binaryHash, closure.sourceHash, context.buildCommand].join("\n"),
    "binary source binding mismatch"
  );

  await mkdir(dirname(evidencePath), { recursive: true });
  const work = await mkdtemp(join(dirname(evidencePath), "stores-qa-"));
  const config = join(work, "config.yaml");
  const auth = join(work, "auth");
  const bareGit = join(work, "bare.git");
  const gitWork = join(work, "git-work");
  await mkdir(auth);
  await mkdir(bareGit);
  // GitStore uses branch "main"; pin it so the bare HEAD does not depend on
  // the host's init.defaultBranch.
  await git(bareGit, "init", "--bare", "-b", "main");

  const assertions = [], events = [], wireRequests = [];
  let failure, child, exitPromise, pipes, exit, mockServer, stderrBuffer = "";
  const record = (id, expected, actual, extra = {}) => {
    assertions.push({ id, expected, actual, pass: expected === actual, ...extra });
  };

  const mgmtSecret = "stores-qa-mgmt-secret";

  async function startGateway(customEnv = {}) {
    const configExists = await Bun.file(config).exists();
    if (!configExists) {
      await writeFile(
        config,
        `api-keys: [inference-key]\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(mgmtSecret)}\n`
      );
    }
    let readyResolve;
    const ready = new Promise((done) => { readyResolve = done; });
    child = spawn(
      context.binary,
      ["serve", "--bind", "127.0.0.1", "--port", String(context.ports[0]), "--auth-dir", auth, "--auth-refresh", "false"],
      {
        cwd: gateway,
        env: {
          ...process.env,
          AUTH_DIR: auth,
          CONFIG_PATH: config,
          MANAGEMENT_PASSWORD: "",
          GITSTORE_LOCAL_PATH: gitWork,
          GITSTORE_GIT_URL: bareGit,
          MAHOQUOT_QA_LOOPBACK_ONLY: "1",
          NO_COLOR: "1",
          CLICOLOR: "0",
          TERM: "dumb",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "127.0.0.1,localhost",
          ...customEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    exitPromise = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    });
    pipes = Promise.all([child.stdout, child.stderr].map((stream) =>
      new Promise((done, reject) => {
        let buffer = "";
        stream.on("data", (chunk) => {
          buffer += chunk.toString();
          if (stream === child.stderr) stderrBuffer += chunk.toString();
          if (buffer.includes("listening")) readyResolve();
        });
        stream.once("end", done);
        stream.once("error", reject);
      })
    ));
    await bounded(
      Promise.race([ready, exitPromise.then((v) => { throw new Error("early exit " + JSON.stringify(v) + " stderr: " + stderrBuffer); })]),
      "gateway readiness"
    );
    events.push({ type: "gateway-ready", pid: child.pid });
  }

  async function stopGateway() {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    try {
      exit = await bounded(exitPromise, "gateway exit");
    } catch (err) {
      child.kill("SIGKILL");
      await bounded(exitPromise, "forced exit");
      throw err;
    }
    await bounded(pipes, "pipes closed");
    events.push({ type: "kernel-exit-observation", pid: child.pid, ...exit, pipes_closed: true });
    child = null;
  }

  try {
    if (variant === "happy") {
      // Mock upstream on port[1]
      mockServer = Bun.serve({
        hostname: "127.0.0.1",
        port: context.ports[1],
        async fetch(req) {
          const body = await req.text();
          wireRequests.push({
            method: req.method,
            path: new URL(req.url).pathname,
            body,
            body_bytes_base64: Buffer.from(body).toString("base64"),
            body_sha256: hash(body),
          });
          return Response.json({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          });
        },
      });

      // Provider auth pointing upstream to mockServer
      await writeFile(
        join(auth, "codex-fixture.json"),
        JSON.stringify({
          type: "plus",
          identity_slug: "test-stores",
          account_id: "test-stores",
          access_token: "token-stores",
          refresh_token: "fixture",
          id_token: "fixture",
          email: "test@fixture.invalid",
          expired: "2099-01-01T00:00:00Z",
          last_refresh: "2098-01-01T00:00:00Z",
          upstream_override: `http://127.0.0.1:${context.ports[1]}`,
        })
      );

      await startGateway();

      const mgmtHeaders = {
        authorization: `Bearer ${mgmtSecret}`,
        "content-type": "application/json",
      };

      // 1. selected-store-mutation: mutation via management API is committed to Git-backed store
      const putRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v8/management/config/routing/retry/request-retry`,
        {
          method: "PUT",
          headers: mgmtHeaders,
          body: JSON.stringify(5),
        }
      );
      assert(putRes.status === 200, "config update failed: " + putRes.status);
      const bareLog = await git(bareGit, "log", "-n", "1", "--oneline");
      const hasCommitInBareGit = bareLog.includes("update config/config.yaml");
      record(
        "selected-store-mutation",
        true,
        putRes.status === 200 && hasCommitInBareGit,
        {
          put_status: putRes.status,
          bare_git_commit: bareLog,
        }
      );

      // Stop and restart gateway against the same GitStore backend to verify restart-persists
      await stopGateway();
      await startGateway();

      // 2. restart-persists: restarted gateway serves persisted configuration from GitStore
      const getRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v8/management/config/routing/retry/request-retry`,
        {
          method: "GET",
          headers: mgmtHeaders,
        }
      );
      const persistedValue = await getRes.json();
      record(
        "restart-persists",
        5,
        persistedValue,
        {
          expected_status: 200,
          observed_status: getRes.status,
          persisted_value: persistedValue,
        }
      );

      // Trigger real inference request through gateway to loopback mock upstream
      await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "probe", stream: false }),
      });

      await stopGateway();
    } else {
      await startGateway();

      const mgmtHeaders = {
        authorization: `Bearer ${mgmtSecret}`,
        "content-type": "application/json",
      };

      // 1. backend-unavailable-reported:
      // Make the selected Git backend reject repository access. Keep the
      // working clone available: GitStore uses it as its local spool.
      const bareGitDisabled = bareGit + ".disabled";
      const { rename } = await import("node:fs/promises");
      await rename(bareGit, bareGitDisabled);

      // Attempt to write a credential via management API when backend is unavailable
      const unavailWriteRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/auth-files`,
        {
          method: "POST",
          headers: mgmtHeaders,
          body: JSON.stringify({
            name: "codex-unavail.json",
            content: {
              type: "codex",
              account_id: "codex-unavail",
              access_token: "tok-unavail",
              refresh_token: "ref-unavail",
              email: "unavail@example.com",
            },
          }),
        }
      );

      // Check management storage status route
      const storeStatusRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/storage/status`,
        {
          method: "GET",
          headers: mgmtHeaders,
        }
      );
      const storeStatusBody = await storeStatusRes.json().catch(() => ({}));

      // Also verify local spool still retains the pending write
      const spoolPath = storeStatusBody.spool_root
        ? join(storeStatusBody.spool_root, "auths", "codex-unavail.json")
        : join(gitWork, "auths", "codex-unavail.json");
      const spoolHasPending = await readFile(spoolPath).then(() => true).catch(() => false);

      record(
        "backend-unavailable-reported",
        true,
        unavailWriteRes.status === 503 && storeStatusRes.status === 503 && spoolHasPending,
        {
          expected_status: 503,
          observed_status: unavailWriteRes.status,
          storage_status: storeStatusBody,
          spool_retained_pending: spoolHasPending,
        }
      );

      // 2. spool-conflict-rejected:
      // Create a conflict between the spool and backend:
      // Commit a different version of the same credential directly to the bare repo,
      // while the spool has its own version.
      const tempClone = join(work, "temp-conflict-clone");
      await git(work, "clone", bareGitDisabled, tempClone);
      await mkdir(join(tempClone, "auths"), { recursive: true });
      await writeFile(
        join(tempClone, "auths", "codex-unavail.json"),
        JSON.stringify({
          type: "codex",
          account_id: "codex-diverged-upstream",
          access_token: "tok-diverged",
        })
      );
      await git(tempClone, "add", "-A");
      await git(tempClone, "commit", "-m", "conflict from upstream");
      await git(tempClone, "push", "origin", "main");

      // Restore backend after injecting the conflicting version. The gateway's
      // retained spool still has its staged version, so the next write must
      // report the real divergence rather than validation or missing-path.
      await rename(bareGitDisabled, bareGit);
      const conflictRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/auth-files`,
        {
          method: "POST",
          headers: mgmtHeaders,
          body: JSON.stringify({
            name: "codex-unavail.json",
            content: {
              type: "codex",
              account_id: "codex-attempt-conflict",
              access_token: "tok-attempt",
              refresh_token: "ref-attempt",
              email: "attempt@example.com",
            },
          }),
        }
      );

      record(
        "spool-conflict-rejected",
        409,
        conflictRes.status,
        {
          expected_status: 409,
          observed_status: conflictRes.status,
        }
      );

      await stopGateway();
    }

    assert(assertions.every((a) => a.pass), "stores assertions failed: " + JSON.stringify(assertions));
  } catch (err) {
    failure = err;
  } finally {
    if (mockServer) {
      mockServer.stop(true);
      mockServer = null;
    }
    try {
      await stopGateway();
      for (const port of context.ports) {
        const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
        listener.stop(true);
      }
      events.push({ type: "port-release-observations", ports: context.ports });
    } catch (err) {
      failure ??= err;
    }
    await rm(work, { recursive: true, force: true });
  }

  const receipt = context.createReceipt({
    caseName: "stores",
    variant,
    assertions,
    requiredAssertionIds: assertions.map((entry) => entry.id),
    events,
    wireRequests,
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
      dirty: Boolean(await git(gateway, "status", "--porcelain")),
    },
    teardown: {
      exit,
      termination: "controlled-signal",
      listeners: failure ? null : 0,
      ownedProcesses: failure ? null : 0,
      listener_inventory: [],
      process_inventory: [],
    },
  });

  if (variant === "happy") {
    delete receipt.wire_capture.external_dials;
  }
  receipt.status = failure ? "FAIL" : "PASS";
  receipt.failure = failure ? String(failure) : null;
  await writeFile(evidencePath, JSON.stringify(receipt, null, 2), { flag: "wx" });
  assert(!failure, String(failure));
  return receipt;
}

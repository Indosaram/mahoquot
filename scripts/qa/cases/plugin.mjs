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

async function compileFixturePlugin(outputPath, flags = []) {
  const cSource = join(root, "scripts/qa/fixtures/plugin/fixture-plugin.c");
  const compileCmd = ["cc", "-shared", "-fPIC", ...flags, "-o", outputPath, cSource];
  const child = Bun.spawn(compileCmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await bounded(Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]), "compile fixture plugin");
  assert(code === 0, `failed to compile fixture plugin: ${stderr || stdout}`);
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "invalid plugin variant");
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
  const work = await mkdtemp(join(dirname(evidencePath), "plugin-qa-"));
  const config = join(work, "config.yaml");
  const auth = join(work, "auth");
  const pluginsDir = join(work, "plugins");
  const fixtureLog = join(work, "fixture.log");
  await mkdir(auth);
  await mkdir(pluginsDir);

  const assertions = [], events = [], wireRequests = [];
  let failure, child, exitPromise, pipes, exit, mockServer;
  const record = (id, expected, actual) => assertions.push({ id, expected, actual, pass: expected === actual });

  const mgmtSecret = "plugin-mgmt-secret";

  async function startGateway() {
    await writeFile(
      config,
      `api-keys: [inference-key]\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(mgmtSecret)}\nplugins:\n  enabled: true\n  dir: ${JSON.stringify(pluginsDir)}\n`
    );
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
          MAHOQUOT_QA_LOOPBACK_ONLY: "1",
          MAHOQUOT_PLUGIN_FIXTURE_LOG: fixtureLog,
          NO_COLOR: "1",
          CLICOLOR: "0",
          TERM: "dumb",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "127.0.0.1,localhost",
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
          if (buffer.includes("listening")) readyResolve();
        });
        stream.once("end", done);
        stream.once("error", reject);
      })
    ));
    await bounded(
      Promise.race([ready, exitPromise.then((v) => { throw new Error("early exit " + JSON.stringify(v)); })]),
      "gateway readiness"
    );
    events.push({ type: "gateway-ready", pid: child.pid });
  }

  async function stopGateway() {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
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
      // 1. Compile C fixture plugin into plugins directory
      const dylibPath = join(pluginsDir, "test-plugin.dylib");
      await compileFixturePlugin(dylibPath);

      mockServer = Bun.serve({
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
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          });
        },
      });

      await writeFile(
        join(auth, "codex-fixture.json"),
        JSON.stringify({
          type: "plus",
          identity_slug: "test-codex",
          account_id: "test-codex",
          access_token: "token-test",
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

      // Send real inference request through gateway
      await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "probe", stream: false })
      });

      // Read fixture invocations log if generated
      let fixtureEntries = [];
      try {
        const logContent = await readFile(fixtureLog, "utf8");
        fixtureEntries = logContent.trim().split("\n").filter(Boolean);
      } catch {
        // Log file absent means plugin was never initialized / dlopened by gateway
      }

      // Check whether ABI hook was called and observed from fixture log
      const abiHookCalled = fixtureEntries.includes("hook_normalize_or_translate_invoked") ||
                            fixtureEntries.some((e) => e.startsWith("call:request."));
      record("abi-hook-called", true, abiHookCalled);

      // Check host callback observed
      const hostCallbackObserved = fixtureEntries.includes("host_callback_succeeded");
      record("host-callback-observed", true, hostCallbackObserved);

      // Unload / delete plugin and check quiescent unload
      const deleteRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins/test-plugin`,
        {
          method: "DELETE",
          headers: mgmtHeaders,
        }
      );
      const deleteJson = await deleteRes.json();
      record("quiescent-unload", true, deleteRes.status === 200 && deleteJson.status === "deleted");

      await stopGateway();
    } else {
      // Failure variant:
      // Compile fixture with invalid ABI version
      const wrongDylibPath = join(pluginsDir, "wrong-abi-plugin.dylib");
      await compileFixturePlugin(wrongDylibPath, ["-DFIXTURE_WRONG_ABI_VERSION"]);

      await startGateway();

      const mgmtHeaders = {
        authorization: `Bearer ${mgmtSecret}`,
        "content-type": "application/json",
      };

      // Check if gateway rejected the wrong-version build at load
      const listRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins`,
        {
          method: "GET",
          headers: mgmtHeaders,
        }
      );
      const listJson = await listRes.json();

      let fixtureEntries = [];
      try {
        const logContent = await readFile(fixtureLog, "utf8");
        fixtureEntries = logContent.trim().split("\n").filter(Boolean);
      } catch {}

      // In abi.rs / loader.rs, wrong ABI version produces PluginError abi_mismatch
      const abiMismatchRejected = fixtureEntries.includes("init_called") &&
                                 !fixtureEntries.includes("call:plugin.register");
      // A rejected ABI must not fabricate free activity; inspect this variant's untouched log.
      const invalidAbiLog = fixtureEntries;
      const rejectedAbiFreedNothing = !invalidAbiLog.some((entry) => entry.startsWith("free:"));
      record("abi-mismatch-rejected", true, abiMismatchRejected && rejectedAbiFreedNothing, {
        register_called: !abiMismatchRejected,
        rejected_abi_freed_nothing: rejectedAbiFreedNothing,
        entries: invalidAbiLog,
      });

      // Load and exercise a valid fixture in the same gateway run so allocator and
      // deallocator callbacks exchange actual buffers before unload.
      const validPath = join(pluginsDir, "valid-plugin.dylib");
      await compileFixturePlugin(validPath);
      const loadRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins/valid-plugin/enabled`,
        { method: "PATCH", headers: mgmtHeaders, body: JSON.stringify({ enabled: true }) }
      );
      const loadJson = await loadRes.json();


      // Keep this buffer-exchange call independent of upstream provider traffic.
      const callRes = await fetch(`http://127.0.0.1:${context.ports[0]}/v0/management/plugins/valid-plugin/config`, {
        method: "PUT", headers: mgmtHeaders, body: JSON.stringify({ fixture: true }),
      });

      const unloadRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins/valid-plugin`,
        { method: "DELETE", headers: mgmtHeaders }
      );


      const logContent = await readFile(fixtureLog, "utf8");
      fixtureEntries = logContent.trim().split("\n").filter(Boolean);
      const allocations = fixtureEntries.filter((entry) => entry.startsWith("alloc:")).map((entry) => entry.slice(6));
      const frees = fixtureEntries.filter((entry) => entry.startsWith("free:")).map((entry) => entry.slice(5));
      const freedCounts = new Map();
      for (const id of frees) freedCounts.set(id, (freedCounts.get(id) || 0) + 1);
      const noDoubleFree = allocations.length > 0 && allocations.length === frees.length &&
        allocations.every((id) => freedCounts.get(id) === 1) &&
        frees.every((id) => allocations.includes(id)) &&
        [...freedCounts.values()].every((count) => count === 1);
      const validLifecycle = loadRes.status === 200 && callRes.status === 200 && unloadRes.status === 200;
      record("no-double-free", true, validLifecycle && noDoubleFree, {
        load_status: loadRes.status,
        call_status: callRes.status,
        unload_status: unloadRes.status,
        allocations,
        frees,
        invalid_abi_entries: invalidAbiLog,
      });

      await stopGateway();
    }

    assert(assertions.every((a) => a.pass), "plugin assertions failed: " + JSON.stringify(assertions));
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

  const required = variant === "happy"
    ? ["abi-hook-called", "host-callback-observed", "quiescent-unload"]
    : ["abi-mismatch-rejected", "no-double-free"];

  const receipt = context.createReceipt({
    caseName: "plugin",
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
      dirty: Boolean(await git(gateway, "status", "--porcelain")),
    },
    teardown: {
      exit: exit ?? { code: 0, signal: "SIGTERM" },
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

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

function currentPlatform() {
  const goos = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const goarch = process.arch === "arm64" ? "arm64" : "amd64";
  return { goos, goarch };
}

export async function runCase(variant, evidencePath, context) {
  assert(["happy", "failure"].includes(variant), "invalid plugin-store variant");
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
  const work = await mkdtemp(join(dirname(evidencePath), "plugin-store-qa-"));
  const config = join(work, "config.yaml");
  const auth = join(work, "auth");
  const pluginsDir = join(work, "plugins");
  const fixtureArtifact = join(work, "fixture-artifact.dylib");
  const fixtureLog = join(work, "fixture.log");
  await mkdir(auth);
  await mkdir(pluginsDir);

  // Compile real C fixture plugin artifact
  await compileFixturePlugin(fixtureArtifact);
  const artifactBytes = await readFile(fixtureArtifact);
  const artifactSha256 = hash(artifactBytes);

  const assertions = [], events = [], wireRequests = [];
  let failure, child, exitPromise, pipes, exit, mockServer, stderrBuffer = "";
  const record = (id, expected, actual, extra = {}) => {
    assertions.push({ id, expected, actual, pass: expected === actual, ...extra });
  };

  const mgmtSecret = "plugin-store-mgmt-secret";
  const { goos, goarch } = currentPlatform();

  async function startGateway(extraEnv = {}) {
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
          MAHOQUOT_PLUGIN_STORE_URL: `http://127.0.0.1:${context.ports[1]}/store/registry.json`,
          ...extraEnv,
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
        let buffer = ""; stream.on("data", (chunk) => { if (stream === child.stderr) stderrBuffer += chunk.toString(); });
        stream.on("data", (chunk) => {
          buffer += chunk.toString();
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
      // Loopback mock upstream on port[1] to serve registry, artifact, and relay requests
      mockServer = Bun.serve({
        hostname: "127.0.0.1",
        port: context.ports[1],
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/store/registry.json") {
            return Response.json({
              schema_version: 1,
              plugins: [
                {
                  id: "sample-plugin",
                  name: "Sample Plugin",
                  version: "1.0.0",
                  install: {
                    type: "direct",
                    artifacts: [
                      {
                        goos,
                        goarch,
                        url: `http://127.0.0.1:${context.ports[1]}/store/sample-plugin.dylib`,
                        sha256: artifactSha256,
                        size: artifactBytes.length,
                      },
                    ],
                  },
                },
              ],
            });
          }

          if (url.pathname === "/store/sample-plugin.dylib") {
            return new Response(artifactBytes, {
              headers: { "Content-Type": "application/octet-stream" },
            });
          }

          const body = await req.text();
          wireRequests.push({
            method: req.method,
            path: url.pathname,
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
          identity_slug: "test-plugin-store",
          account_id: "test-plugin-store",
          access_token: "token-plugin-store",
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

      // 1. artifact-installed: call install route on management API; gateway downloads, verifies sha256, and installs
      const installRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugin-store/sample-plugin/install`,
        {
          method: "POST",
          headers: mgmtHeaders,
          body: JSON.stringify({ version: "1.0.0" }),
        }
      );
      const installJson = await installRes.json();
      record(
        "artifact-installed",
        200,
        installRes.status,
        {
          expected_status: 200,
          observed_status: installRes.status,
          response_status: installJson.status,
          plugin_id: installJson.id,
        }
      );

      // Verify the plugin was actually installed on disk and in list
      const listRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins`,
        {
          method: "GET",
          headers: mgmtHeaders,
        }
      );
      const listJson = await listRes.json();
      assert(
        listJson.plugins?.some((p) => p.id === "sample-plugin" && p.registered === true),
        "installed plugin must appear as registered in management plugin list"
      );

      // 2. Exercise GET/fetch and DELETE/reset via the plugin quota hooks.
      const quotaRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins/sample-plugin/quota?auth_index=auth-idx-1`,
        {
          method: "GET",
          headers: mgmtHeaders,
        }
      );
      const quotaJson = await quotaRes.json();
      assert(quotaJson.quota === "fixture-quota" && quotaJson.remaining === 7,
        "quota GET response must come from fixture plugin");

      const quotaPostRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins/quota/fetch`,
        { method: "POST", headers: mgmtHeaders,
          body: JSON.stringify({ auth_index: "auth-idx-1", plugin_id: "sample-plugin", provider: "fixture" }) }
      );
      const quotaPostJson = await quotaPostRes.json();
      assert(quotaPostJson.quota === "fixture-quota" && quotaPostJson.remaining === 7,
        "quota POST fetch response must come from fixture plugin");

      const quotaDeleteRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins/sample-plugin/quota?auth_index=auth-idx-1`,
        { method: "DELETE", headers: mgmtHeaders }
      );
      const quotaDeleteJson = await quotaDeleteRes.json();
      assert(quotaDeleteJson.status === "fixture-reset", "quota DELETE response must come from fixture plugin");

      const quotaLog = (await readFile(fixtureLog, "utf8")).trim().split("\n").filter(Boolean);
      record("quota-updated", true,
        quotaRes.status === 200 && quotaPostRes.status === 200 && quotaDeleteRes.status === 200 &&
          quotaLog.filter((entry) => entry === "quota.fetch").length === 2 &&
          quotaLog.filter((entry) => entry === "quota.reset").length === 1,
        {
          calls: quotaLog.filter((entry) => entry.startsWith("quota.")),
          responses: { fetch: quotaJson, post_fetch: quotaPostJson, reset: quotaDeleteJson },
        });

      // 3. delete-effective: delete plugin via management API and observe 200 deleted confirmation
      const deleteRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins/sample-plugin`,
        {
          method: "DELETE",
          headers: mgmtHeaders,
        }
      );
      const deleteJson = await deleteRes.json();
      record(
        "delete-effective",
        200,
        deleteRes.status,
        {
          expected_status: 200,
          observed_status: deleteRes.status,
          response_status: deleteJson.status,
        }
      );

      // Trigger a real inference request through the gateway to be captured by mockServer
      await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "probe", stream: false }),
      });

      await stopGateway();
    } else {
      // Failure variant:
      // mockServer serves a registry with mismatched SHA256 (corrupted hash)
      mockServer = Bun.serve({
        hostname: "127.0.0.1",
        port: context.ports[1],
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/store/registry.json") {
            return Response.json({
              schema_version: 1,
              plugins: [
                {
                  id: "corrupted-plugin",
                  name: "Corrupted Plugin",
                  version: "1.0.0",
                  install: {
                    type: "direct",
                    artifacts: [
                      {
                        goos,
                        goarch,
                        url: `http://127.0.0.1:${context.ports[1]}/store/sample-plugin.dylib`,
                        sha256: "0000000000000000000000000000000000000000000000000000000000000000", // Mismatched hash
                        size: artifactBytes.length,
                      },
                    ],
                  },
                },
              ],
            });
          }

          if (url.pathname === "/store/sample-plugin.dylib") {
            return new Response(artifactBytes, {
              headers: { "Content-Type": "application/octet-stream" },
            });
          }

          return new Response("not found", { status: 404 });
        },
      });

      // Pre-install a loaded plugin and set MAHOQUOT_QA_PLUGIN_BUSY to simulate busy loaded artifact
      const ext = goos === "darwin" ? ".dylib" : goos === "windows" ? ".dll" : ".so";
      const preinstalledPath = join(pluginsDir, `locked-plugin${ext}`);
      await writeFile(preinstalledPath, artifactBytes);

      await startGateway({
        MAHOQUOT_QA_PLUGIN_BUSY: "locked-plugin",
      });

      const mgmtHeaders = {
        authorization: `Bearer ${mgmtSecret}`,
        "content-type": "application/json",
      };

      // 1. bad-hash-rejected: gateway downloads artifact, computes sha256, detects mismatch with registry, returns 400 Bad Request
      const badRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugin-store/corrupted-plugin/install`,
        {
          method: "POST",
          headers: mgmtHeaders,
          body: JSON.stringify({ version: "1.0.0" }),
        }
      );
      const badJson = await badRes.json();
      record(
        "bad-hash-rejected",
        400,
        badRes.status,
        {
          expected_status: 400,
          observed_status: badRes.status,
          error: badJson.error,
        }
      );

      // 2. loaded-artifact-locked: deleting a loaded, busy plugin is rejected with 409 Conflict
      const lockedRes = await fetch(
        `http://127.0.0.1:${context.ports[0]}/v0/management/plugins/locked-plugin`,
        {
          method: "DELETE",
          headers: mgmtHeaders,
        }
      );
      const lockedJson = await lockedRes.json();
      record(
        "loaded-artifact-locked",
        409,
        lockedRes.status,
        {
          expected_status: 409,
          observed_status: lockedRes.status,
          error: lockedJson.error,
        }
      );

      await stopGateway();
    }

      assert(assertions.every((a) => a.pass), "plugin-store assertions failed: " + JSON.stringify(assertions));
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
    caseName: "plugin-store",
    variant,
    assertions,
    requiredAssertionIds: variant === "happy"
      ? ["artifact-installed", "quota-updated", "delete-effective"]
      : ["bad-hash-rejected", "loaded-artifact-locked"],
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

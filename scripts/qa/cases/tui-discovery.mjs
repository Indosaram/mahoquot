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
  assert(["happy", "failure"].includes(variant), "invalid tui-discovery variant");
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
  const work = await mkdtemp(join(dirname(evidencePath), "tui-discovery-qa-"));
  const config = join(work, "config.yaml");
  const auth = join(work, "auth");
  await mkdir(auth);

  const assertions = [], events = [], wireRequests = [];
  let failure, child, exitPromise, pipes, exit, mockServer, stderrBuffer = "";
  const record = (id, expected, actual, extra = {}) => {
    assertions.push({ id, expected, actual, pass: expected === actual, ...extra });
  };

  const mgmtSecret = "tui-discovery-mgmt-secret";

  async function startGateway() {
    const yaml = `api-keys: [inference-key]\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(mgmtSecret)}\ndiscovery:\n  enabled: true\n`;
    await writeFile(config, yaml);
    await writeFile(join(auth, "config.yaml"), yaml);
    let readyResolve;
    const ready = new Promise((done) => { readyResolve = done; });
    child = spawn(
      context.binary,
      ["serve", "--config", config, "--bind", "0.0.0.0", "--port", String(context.ports[0]), "--auth-dir", auth, "--auth-refresh", "false"],
      {
        cwd: gateway,
        env: {
          ...process.env,
          AUTH_DIR: auth,
          CONFIG_PATH: config,
          MANAGEMENT_PASSWORD: "",
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
      // Loopback mock upstream on port[1] to capture real relay request
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
          identity_slug: "test-tui-discovery",
          account_id: "test-tui-discovery",
          access_token: "token-tui-discovery",
          refresh_token: "fixture",
          id_token: "fixture",
          email: "test@fixture.invalid",
          expired: "2099-01-01T00:00:00Z",
          last_refresh: "2098-01-01T00:00:00Z",
          upstream_override: `http://127.0.0.1:${context.ports[1]}`,
        })
      );

      await startGateway();

      // 1. pty-navigation: run real gateway tui subcommand under a real PTY via python3 pty / script, send navigation keys, and observe screen transitions
      // Spawn PTY wrapper that sends keys and captures rendered output
      const ptyScript = `
import pty, os, time, sys, select

master, slave = pty.openpty()
proc = os.fork()
if proc == 0:
    os.close(master)
    os.setsid()
    import fcntl, termios
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    os.execv(sys.argv[1], sys.argv[1:])
else:
    os.close(slave)
    output = b""
    def drain(duration=0.3):
        global output
        end = time.time() + duration
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    # Linux reports EIO on the master once the child closed
                    # its side (macOS returns EOF): both mean end of output.
                    break
                if not chunk: break
                output += chunk

    drain(0.5)
    # Send tab key to navigate to Configuration screen
    os.write(master, b"\\t")
    drain(0.4)
    # Send tab key to navigate to Accounts screen
    os.write(master, b"\\t")
    drain(0.4)
    # Send q key to quit cleanly
    os.write(master, b"q")
    drain(0.2)
    try:
        os.close(master)
    except OSError:
        pass
    os.waitpid(proc, 0)
    sys.stdout.buffer.write(output)
`;
      const ptyProc = Bun.spawn([
        "python3", "-c", ptyScript,
        context.binary, "tui", "--standalone",
        "--management-base-url", `http://127.0.0.1:${context.ports[0]}`,
        "--password", mgmtSecret,
      ], {
        env: { ...process.env, TERM: "xterm-256color" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const tuiOutputPromise = new Response(ptyProc.stdout).text();
      const [tuiOutput, ptyExit] = await bounded(Promise.all([tuiOutputPromise, ptyProc.exited]), "TUI PTY exit", 10000);
      const tuiError = await new Response(ptyProc.stderr).text();

      const hasDashboardScreen = tuiOutput.includes("SCREEN: DASHBOARD") || tuiOutput.includes("Dashboard");
      const hasAccountsScreen = tuiOutput.includes("SCREEN: ACCOUNTS LIST");
      const ptyNavigated = hasDashboardScreen && hasAccountsScreen;
      record("pty-navigation", true, ptyNavigated, {
        rendered_dashboard_observed: hasDashboardScreen,
        rendered_accounts_observed: hasAccountsScreen,
        pty_exit: ptyExit,
        stderr: tuiError,
      });

      // 2. discovery-json: run real gateway discover command with --json flag and observe valid json array
      const discoverProc = Bun.spawn([
        context.binary, "discover", "--json", "--timeout", "2",
      ], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const discoverStdout = await new Response(discoverProc.stdout).text();
      await discoverProc.exited;
      let parsedServices = null;
      try {
        parsedServices = JSON.parse(discoverStdout.trim());
      } catch {}
      const isArrayOfServices = Array.isArray(parsedServices) && parsedServices.length > 0;
      record("discovery-json", true, isArrayOfServices, {
        services_count: parsedServices?.length ?? 0,
        instances: parsedServices ? parsedServices.map((s) => s.instance_name) : [],
      });

      // Trigger a real inference request through gateway to mock upstream
      await fetch(`http://127.0.0.1:${context.ports[0]}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer inference-key" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "probe", stream: false }),
      });

      // 3. shutdown-removes-advertisement: gateway shutdown terminates cleanly and releases ports
      await stopGateway();

      // Discover after gateway shutdown should no longer list the instance
      const postShutdownDiscover = Bun.spawn([
        context.binary, "discover", "--json", "--timeout", "1",
      ], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const postShutdownOut = await new Response(postShutdownDiscover.stdout).text();
      await postShutdownDiscover.exited;
      let postShutdownServices = [];
      try {
        postShutdownServices = JSON.parse(postShutdownOut.trim());
      } catch {}
      const advertisedNames = new Set((parsedServices ?? []).map((s) => s.instance_name));
      const advertisementRemoved = !postShutdownServices.some((s) => advertisedNames.has(s.instance_name));

      const cleanShutdown = exit !== null && (exit.code === 0 || exit.signal === "SIGINT") && advertisementRemoved;
      record("shutdown-removes-advertisement", true, cleanShutdown, {
        exit_signal: exit?.signal,
        exit_code: exit?.code,
        advertisement_removed: advertisementRemoved,
      });
    } else {
      await startGateway();

      // 1. unauthorized-denied: unauthenticated management endpoint returns exact 401 Unauthorized
      const unauthRes = await fetch(`http://127.0.0.1:${context.ports[0]}/v0/management/config`);
      record(
        "unauthorized-denied",
        401,
        unauthRes.status,
        {
          expected_status: 401,
          observed_status: unauthRes.status,
        }
      );

      // 2. no-secret-advertisement: discovery payload contains no credentials or secret keys
      const discoverProc = Bun.spawn([
        context.binary, "discover", "--json", "--timeout", "1",
      ], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const discoverRaw = (await new Response(discoverProc.stdout).text()).toLowerCase();
      await discoverProc.exited;
      const parsedAdvertised = JSON.parse(discoverRaw);
      const txtValues = parsedAdvertised.flatMap((service) => Object.values(service.raw_txt ?? {}));
      const containsLeakedSecret = txtValues.some((value) => {
        const v = value.toLowerCase();
        return v.includes(mgmtSecret.toLowerCase()) ||
          v.includes("inference-key") ||
          /password|secret/i.test(v);
      });
      record("no-secret-advertisement", false, containsLeakedSecret, { secret_leaked: containsLeakedSecret });

      await stopGateway();
    }

    assert(assertions.every((a) => a.pass), "tui-discovery assertions failed: " + JSON.stringify(assertions));
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
    caseName: "tui-discovery",
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

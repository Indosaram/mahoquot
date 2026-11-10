import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { deadline } from "./discovery-pty-contract.mjs";

export function isolatedEnvironment(work) {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", HOME: join(work, "home"), TMPDIR: join(work, "tmp"), XDG_CONFIG_HOME: join(work, "config"), XDG_CACHE_HOME: join(work, "cache"), LANG: "C.UTF-8", TERM: "xterm-256color", NO_COLOR: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
export function acceptSupervisorEvent(entry, event) {
  if (event.event === "app-exited") { entry.code = event.code; entry.signal = event.signal; entry.resolveExit(entry); }
  if (event.event === "group-terminated") entry.terminated = true;
  if (event.event === "cleanup-error") entry.pipeError = new Error(event.error);
}
export function requireTerminated(entry) {
  if (!entry.terminated || !entry.closed || entry.supervisorCode !== 0 || !["stdin", "stdout", "stderr"].every((name) => entry.streamsClosed?.[name] === true) || entry.pipeError || entry.overflow) throw entry.pipeError ?? new Error("missing owned group termination or registered stream closure acknowledgement");
}

// The existing supervisor keeps a live/unreaped group leader until killpg/reap.
// Node never uses recorded PID values as signal authority.
export class DiscoveryOwner {
  constructor(binary, workRoot, gatewayRoot) {
    this.binary = binary; this.workRoot = workRoot; this.gatewayRoot = gatewayRoot;
    this.children = new Set(); this.events = new EventEmitter();
  }
  async prepare() {
    this.work = await mkdtemp(join(this.workRoot, "isolated-discovery-"));
    for (const name of ["home", "tmp", "config", "cache"]) await mkdir(join(this.work, name), { mode: 0o700 });
    this.env = isolatedEnvironment(this.work);
  }
  launch(command, args) {
    if (!this.env) throw new Error("owned environment not prepared");
    const supervisor = new URL("./desktop-process-supervisor.py", import.meta.url).pathname;
    const child = spawn("python3", [supervisor, "--supervise", command, ...args], { cwd: this.gatewayRoot, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    const entry = { id: this.children.size + 1, child, stdout: "", stderr: "", closed: false, streamsClosed: { stdin: false, stdout: false, stderr: false } };
    entry.streamsClosedPromise = Promise.all(["stdin", "stdout", "stderr"].map((name) => new Promise((resolve) => {
      child[name].once("close", () => { entry.streamsClosed[name] = true; resolve(); });
    })));
    this.children.add(entry);
    entry.exited = new Promise((resolve) => { entry.resolveExit = resolve; });
    entry.closedPromise = new Promise((resolve) => {
      child.once("error", (error) => { entry.spawnError = error; });
      child.once("close", (code, signal) => { entry.closed = true; entry.supervisorCode = code; entry.supervisorSignal = signal; resolve(entry); });
    });
    for (const field of ["stdout", "stderr"]) {
      let pending = "";
      child[field].on("data", (chunk) => {
        pending += chunk.toString();
        if (pending.length + entry[field].length > 4 * 1024 * 1024) { entry.overflow = true; child.stdin.end("supervisor-stop\n"); }
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (line.startsWith("MAHOQUOT_QA_SUPERVISOR ")) {
            try { acceptSupervisorEvent(entry, JSON.parse(line.slice("MAHOQUOT_QA_SUPERVISOR ".length))); }
            catch (error) { entry.pipeError = error; }
          } else { entry[field] += line + "\n"; this.events.emit("line", entry, line); }
        }
      });
      child[field].on("end", () => { entry[field] += pending; });
      child[field].on("error", (error) => { entry.pipeError = error; });
    }
    child.stdin.on("error", (error) => { entry.pipeError = error; });
    return entry;
  }
  async finish(entry) {
    if (!entry.closed && !entry.child.stdin.writableEnded) entry.child.stdin.end("supervisor-stop\n");
    await deadline(() => Promise.all([entry.closedPromise, entry.streamsClosedPromise]), "supervisor group termination and registered stream closure");
    if (entry.spawnError && !entry.child.pid) throw entry.spawnError;
    requireTerminated(entry);
  }
  subscription(predicate) {
    let listener;
    const promise = new Promise((resolve, reject) => {
      listener = (entry, line) => { try { const value = predicate(entry, line); if (value !== undefined) resolve(value); } catch (error) { reject(error); } };
      this.events.on("line", listener);
    });
    promise.catch(() => {});
    return { promise, cancel: () => this.events.off("line", listener) };
  }
  async waitApp(entry) {
    return deadline(() => Promise.race([entry.exited, entry.closedPromise.then(() => { throw entry.spawnError ?? new Error("supervisor exited without application acknowledgement"); })]), "application exit");
  }
  async command(command, args) {
    const entry = this.launch(command, args);
    await this.waitApp(entry);
    await this.finish(entry);
    return entry;
  }
  async acquire(launch) {
    this.identity = launch;
    if (!this.work) await this.prepare();
    this.directory = join(this.work, "registry"); this.auth = join(this.work, "auth");
    await mkdir(this.directory, { mode: 0o700 }); await mkdir(this.auth, { mode: 0o700 });
    this.config = join(this.work, "config.yaml");
    this.secret = `qa-${launch.run_id}`;
    await writeFile(join(this.auth, "instance_id"), launch.instance_id, { flag: "wx" });
    await writeFile(this.config, `api-keys: [inference-key]\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(this.secret)}\ndiscovery:\n  enabled: true\n  service-name: ${JSON.stringify(launch.instance_name)}\n`);
    this.env = { ...isolatedEnvironment(this.work), MAHOQUOT_QA_DISCOVERY_DIR: this.directory, MAHOQUOT_QA_DISCOVERY_RUN: launch.run_id, MAHOQUOT_DISCOVERY_FILE_FALLBACK: "0", AUTH_DIR: this.auth, CONFIG_PATH: this.config, MANAGEMENT_PASSWORD: "" };
    return { transport: "isolated-discovery", run_id: launch.run_id, ambient_multicast: false };
  }
  async start(launch) {
    const ready = this.subscription((entry, line) => entry === this.gateway && line.includes("listening") ? true : undefined);
    try {
      this.gateway = this.launch(this.binary, ["serve", "--config", this.config, "--bind", launch.address, "--port", String(launch.port), "--auth-dir", this.auth, "--auth-refresh", "false"]);
      await deadline(() => Promise.race([ready.promise, this.gateway.exited.then(() => { throw new Error(`gateway exited before readiness: ${this.gateway.stderr}`); }), this.gateway.closedPromise.then(() => { throw new Error("supervisor ended before readiness"); })]), "gateway readiness");
    } finally { ready.cancel(); }
  }
  async discover() { return this.command(this.binary, ["discover", "--json"]); }
  async pty() {
    const helper = new URL("../fixtures/discovery-pty-observer.py", import.meta.url).pathname;
    const result = await this.command("python3", [helper, this.binary, "tui", "--standalone", "--management-base-url", `http://${this.identity.address}:${this.identity.port}`, "--password", this.secret]);
    if (result.code !== 0) throw new Error(`PTY failed: ${result.stdout} ${result.stderr}`);
    return JSON.parse(result.stdout);
  }
  subscribeDeregistered() {
    const prefix = "QA_DISCOVERY_DEREGISTERED ";
    return this.subscription((entry, line) => entry === this.gateway && line.startsWith(prefix) ? JSON.parse(line.slice(prefix.length)) : undefined);
  }
  async stop() {
    const response = await fetch(`http://${this.identity.address}:${this.identity.port}/v0/management/shutdown`, { method: "POST", headers: { authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(10000) });
    if (response.status !== 200) throw new Error(`shutdown status ${response.status}`);
    await response.text(); await this.waitApp(this.gateway); await this.finish(this.gateway);
    if (this.gateway.code !== 0) throw new Error(`gateway shutdown failed: ${this.gateway.stderr}`);
  }
  async cleanup() {
    const errors = [];
    // All stop requests are sent before waiting on any supervisor.
    for (const entry of this.children) {
      if (!entry.closed && !entry.child.stdin.writableEnded) {
        try { entry.child.stdin.end("supervisor-stop\n"); }
        catch (error) { errors.push(error); }
      }
    }
    await Promise.all([...this.children].map(async (entry) => {
      try {
        await deadline(() => Promise.all([entry.closedPromise, entry.streamsClosedPromise]), "owned supervisor cleanup");
        // No process was created: close is sufficient for resource cleanup, but
        // the original command still reports its spawn failure.
        if (!(entry.spawnError && !entry.child.pid)) requireTerminated(entry);
      } catch (error) { errors.push(error); }
    }));
    if (this.work && errors.length === 0) { try { await rm(this.work, { recursive: true, force: true }); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "owned cleanup failed");
    return {
      scope: "registered-keeper-groups",
      assumption: "descendants-do-not-setsid",
      independentGuestContainmentRequired: true,
      aggregateCensus: "unobserved",
      ownedProcesses: null, openPipes: null, listeners: null,
      registeredSupervisors: [...this.children].map((entry) => ({
        id: entry.id,
        creation: entry.spawnError && !entry.child.pid ? "failed" : "spawned",
        groupTerminated: entry.terminated === true,
        supervisorClosed: entry.closed,
        supervisorExitCode: entry.supervisorCode,
        registeredStdioClosed: { ...entry.streamsClosed },
      })),
    };
  }
}

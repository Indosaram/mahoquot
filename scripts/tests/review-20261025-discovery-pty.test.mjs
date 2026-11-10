import { test, expect } from "bun:test";
import { collectDiscoveryContract, matchesLaunch, parseDiscovery, requireScopedCleanup } from "../qa/cases/discovery-pty-contract.mjs";
import { DiscoveryOwner, isolatedEnvironment, acceptSupervisorEvent, requireTerminated } from "../qa/cases/discovery-pty-owner.mjs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("stop delivery failure does not bypass other supervisors or erase retained work", async () => {
  const work = await mkdtemp(join(tmpdir(), "discovery-cleanup-"));
  try {
    await writeFile(join(work, "evidence"), "retained");
    const owner = new DiscoveryOwner("unused", work, work);
    owner.work = work;
    const delivered = [];
    const releases = [];
    const deliveryError = new Error("injected stop delivery failure");
    for (const id of [1, 2]) {
      let release;
      const closedPromise = new Promise((resolve) => { release = resolve; });
      const entry = {
        id, closed: false, terminated: false, supervisorCode: null,
        streamsClosed: { stdin: false, stdout: false, stderr: false },
        closedPromise, streamsClosedPromise: closedPromise,
        child: { stdin: { writableEnded: false, end() {
          delivered.push(id);
          if (id === 1) throw deliveryError;
        } } },
      };
      releases.push(() => {
        entry.closed = true; entry.terminated = true; entry.supervisorCode = 0;
        entry.streamsClosed = { stdin: true, stdout: true, stderr: true };
        release();
      });
      owner.children.add(entry);
    }
    let completed = false;
    const result = owner.cleanup();
    const checked = result.then(() => { throw new Error("unexpected success"); }, (error) => {
      completed = true;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toEqual([deliveryError]);
    });
    expect(delivered).toEqual([1, 2]);
    releases[0]();
    await [...owner.children][0].closedPromise;
    expect(completed).toBe(false);
    releases[1]();
    await checked;
    expect(await readFile(join(work, "evidence"), "utf8")).toBe("retained");
  } finally { await rm(work, { recursive: true, force: true }); }
});

test("environment excludes every ambient credential/store/provider override", () => {
  const env = isolatedEnvironment("/owned/run");
  expect(env.HOME).toBe("/owned/run/home");
  expect(env.TMPDIR).toBe("/owned/run/tmp");
  for (const key of ["HOME_JWT", "PGSTORE_DSN", "OBJECTSTORE_ENDPOINT", "GITSTORE_GIT_URL", "OPENAI_API_KEY", "http_proxy", "HTTPS_PROXY", "MAHOQUOT_DISCOVERY_FILE_FALLBACK", "NODE_OPTIONS", "PYTHONPATH"]) expect(env[key]).toBeUndefined();
});

test("app exit and abrupt supervisor death cannot certify owned cleanup", () => {
  let exited = false;
  const entry = { resolveExit() { exited = true; }, supervisorCode: 0, closed: true, streamsClosed: { stdin: true, stdout: true, stderr: true } };
  acceptSupervisorEvent(entry, { event: "app-exited", code: 0, signal: null });
  expect(exited).toBe(true);
  expect(() => requireTerminated(entry)).toThrow();
  acceptSupervisorEvent(entry, { event: "group-terminated", pgid: 999 });
  expect(() => requireTerminated(entry)).not.toThrow();
  expect(() => requireTerminated({ ...entry, supervisorCode: null })).toThrow();
  expect(() => requireTerminated({ ...entry, closed: false })).toThrow();
  for (const name of ["stdin", "stdout", "stderr"]) expect(() => requireTerminated({ ...entry, streamsClosed: { ...entry.streamsClosed, [name]: false } })).toThrow();
  acceptSupervisorEvent(entry, { event: "cleanup-error", error: "injected" });
  expect(() => requireTerminated(entry)).toThrow("injected");
});

const scopedCleanup = () => ({
  scope: "registered-keeper-groups", assumption: "descendants-do-not-setsid", independentGuestContainmentRequired: true,
  aggregateCensus: "unobserved", ownedProcesses: null, openPipes: null, listeners: null,
  registeredSupervisors: [{ id: 1, creation: "spawned", groupTerminated: true, supervisorClosed: true, supervisorExitCode: 0, registeredStdioClosed: { stdin: true, stdout: true, stderr: true } }],
});

test("scoped cleanup rejects aggregate overclaims and incomplete registered observations", () => {
  expect(() => requireScopedCleanup(scopedCleanup())).not.toThrow();
  for (const change of [{ ownedProcesses: 0 }, { listeners: 0 }, { openPipes: 0 }, { aggregateCensus: "observed" }, { independentGuestContainmentRequired: false }, { assumption: undefined }, { registeredSupervisors: undefined }]) expect(() => requireScopedCleanup({ ...scopedCleanup(), ...change })).toThrow();
  for (const change of [{ groupTerminated: false }, { supervisorClosed: false }, { supervisorExitCode: null }, { creation: "failed" }, ...["stdin", "stdout", "stderr"].map((name) => ({ registeredStdioClosed: { stdin: true, stdout: true, stderr: true, [name]: false } }))]) {
    const cleanup = scopedCleanup();
    cleanup.registeredSupervisors[0] = { ...cleanup.registeredSupervisors[0], ...change };
    expect(() => requireScopedCleanup(cleanup)).toThrow();
  }
});

const launch = { run_id: "fixture-run", instance_name: "qa-AB12", instance_id: "AB12", address: "127.0.0.1", port: 18840, service_type: "_ai-gateway._tcp", domain: "local." };
const service = () => ({ instance_name: launch.instance_name, service_type: launch.service_type, domain: launch.domain, host: launch.address, port: launch.port, ipv4: [launch.address], ipv6: [], raw_txt: { instance_id: launch.instance_id } });
const terminal = () => ({ code: 0, output_subscribed_before_exec: true, screens: ["DASHBOARD", "CONFIGURATION", "ACCOUNTS LIST"], raw_entered: true, restored: true, reaped: true, pipes_closed: true, failure: null });
function fixture() {
  let resolveAck, subscribed = false, removed = false;
  const calls = [];
  const promise = new Promise((resolve) => { resolveAck = resolve; });
  const ack = { ...launch, responder_joined: true, transport_removed: true };
  const owner = {
    acquire: async () => ({ transport: "isolated-discovery", run_id: launch.run_id, ambient_multicast: false }),
    start: async () => { calls.push("start"); },
    discover: async () => { calls.push(removed ? "absent" : "present"); return { code: 0, stdout: JSON.stringify(removed ? [] : [service()]) }; },
    pty: async () => terminal(),
    subscribeDeregistered: () => { subscribed = true; calls.push("subscribe"); return { promise, cancel() { calls.push("unsubscribe"); } }; },
    stop: async () => { expect(subscribed).toBe(true); calls.push("stop"); },
    cleanup: async () => { calls.push("cleanup"); return scopedCleanup(); },
  };
  return { owner, calls, acknowledge(change = {}) { removed = true; resolveAck({ ...ack, ...change }); } };
}

test("collector awaits exact deregistration event before testing absence", async () => {
  const f = fixture();
  let stopped;
  const signal = new Promise((resolve) => { stopped = resolve; });
  const stop = f.owner.stop;
  f.owner.stop = async () => { await stop(); stopped(); };
  const collected = collectDiscoveryContract(f.owner, launch);
  await signal;
  expect(f.calls).toEqual(["start", "present", "subscribe", "stop"]);
  f.acknowledge();
  const result = await collected;
  expect(result.cleanup).toEqual(scopedCleanup());
  expect(result.events.map((event) => event.type)).toEqual(["discovered", "deregistered"]);
  expect(f.calls).toEqual(["start", "present", "subscribe", "stop", "absent", "unsubscribe", "cleanup"]);
});

test("identity mismatches and malformed transport output cannot become absence", () => {
  expect(matchesLaunch(service(), launch)).toBe(true);
  for (const changed of [{ instance_name: "other" }, { port: 18841 }, { ipv4: ["127.0.0.2"] }, { ipv4: [launch.address, "127.0.0.2"] }, { host: "elsewhere" }, { raw_txt: { instance_id: "CD34" } }, { service_type: "_other._tcp" }, { domain: "elsewhere." }]) {
    expect(matchesLaunch({ ...service(), ...changed }, launch)).toBe(false);
  }
  for (const [code, stdout] of [[1, "[]"], [0, ""], [0, "{}"], [0, "[{}]"], [0, JSON.stringify([{ ...service(), port: "18840" }])], [0, JSON.stringify([{ ...service(), raw_txt: { secret: 42 } }])], [0, JSON.stringify([{ ...service(), ipv4: ["invalid"] }])]]) {
    expect(() => parseDiscovery(code, stdout)).toThrow();
  }
});

test("wrong acknowledgement fails before absence and still cleans ownership", async () => {
  for (const mutation of [{ run_id: "other" }, { port: 18841 }, { instance_id: "FFFF" }, { responder_joined: false }, { transport_removed: false }]) {
    const f = fixture();
    f.acknowledge(mutation);
    // Preserve initial discovery even when the fixture's event is pre-resolved.
    f.owner.discover = async () => ({ code: 0, stdout: JSON.stringify([service()]) });
    await expect(collectDiscoveryContract(f.owner, launch)).rejects.toThrow();
    expect(f.calls.at(-1)).toBe("cleanup");
    expect(f.calls).toContain("unsubscribe");
  }
});

test("terminal observation requires output subscription, raw entry and restoration", async () => {
  for (const mutation of [{ output_subscribed_before_exec: false }, { raw_entered: false }, { restored: false }, { reaped: false }, { pipes_closed: false }, { screens: ["DASHBOARD"] }, { code: 1 }, { failure: "cleanup failed" }]) {
    const f = fixture();
    f.owner.pty = async () => ({ ...terminal(), ...mutation });
    await expect(collectDiscoveryContract(f.owner, launch)).rejects.toThrow();
    expect(f.calls.at(-1)).toBe("cleanup");
    expect(f.calls).not.toContain("subscribe");
  }
});

test("every acquisition or operational failure retains cleanup and its errors", async () => {
  for (const method of ["acquire", "start", "discover", "pty", "stop"]) {
    const f = fixture();
    f.owner[method] = async () => { throw new Error(`injected ${method}`); };
    await expect(collectDiscoveryContract(f.owner, launch)).rejects.toThrow(`injected ${method}`);
    expect(f.calls.at(-1)).toBe("cleanup");
  }
  const f = fixture();
  f.owner.start = async () => { throw new Error("start failed"); };
  f.owner.cleanup = async () => { throw new Error("cleanup failed"); };
  try { await collectDiscoveryContract(f.owner, launch); throw new Error("unexpected success"); }
  catch (error) { expect(error).toBeInstanceOf(AggregateError); expect(error.errors.map(String)).toEqual(["Error: start failed", "Error: cleanup failed"]); }
});

test("nonisolated transport fails before launch", async () => {
  const f = fixture();
  f.owner.acquire = async () => ({ transport: "isolated-discovery", run_id: launch.run_id, ambient_multicast: true });
  await expect(collectDiscoveryContract(f.owner, launch)).rejects.toThrow();
  expect(f.calls).toEqual(["cleanup"]);
});

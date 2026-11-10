import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGuestProfiles, requireAbsentGuestProfiles } from "../qa/cases/desktop-guest-profiles.mjs";
import { observeGatewayLifecycle } from "../qa/cases/desktop-lifecycle-events.mjs";

test("gateway lifecycle requires creation identity and actual reap event", async () => {
  const child = nativeChild();
  const stream = observeGatewayLifecycle(child);
  const emit = (event, generation = 1, pid = 42) => child.stdout.emit("data", Buffer.from(`MAHOQUOT_NATIVE_LIFECYCLE ${JSON.stringify({event, generation, pid})}\n`));
  const ready = stream.wait("ready", 1);
  emit("spawned"); emit("ready");
  assert.equal((await ready).pid, 42);
  const reaped = stream.wait("reaped", 1);
  emit("reaped");
  assert.equal((await reaped).generation, 1);
  emit("spawned", 2);
  const rejected = assert.rejects(stream.wait("reaped", 2));
  emit("wait-error", 2);
  await rejected;
  child.emit("close");
  assert.equal(child.stdout.listenerCount("data"), 0);
});

test("foreign generation cannot satisfy gateway readiness", async () => {
  const child = nativeChild();
  const stream = observeGatewayLifecycle(child);
  const rejected = assert.rejects(stream.wait("ready", 1));
  child.stdout.emit("data", Buffer.from('MAHOQUOT_NATIVE_LIFECYCLE {"event":"ready","generation":1,"pid":42}\n'));
  await rejected;
  child.emit("close");
});

 test("guest profile restores bytes, mode and absence; rejects symlink escapes", async () => {
  const { realpath } = await import("node:fs/promises");
  const home = await realpath(await mkdtemp(join(tmpdir(), "desktop-profile-test-")));
  try {
    await requireAbsentGuestProfiles(home, [".codex", ".gemini"]);
    await mkdir(join(home, ".codex"));
    await assert.rejects(requireAbsentGuestProfiles(home, [".codex", ".gemini"]));
    const config = join(home, ".codex/config.toml");
    await writeFile(config, "original", { mode: 0o600 });
    const snapshot = await snapshotGuestProfiles(home, [".codex", ".gemini"]);
    await writeFile(config, "changed");
    await writeFile(join(home, ".codex/new"), "owned");
    await mkdir(join(home, ".gemini"));
    await snapshot.restore();
    assert.equal(await readFile(config, "utf8"), "original");
    assert.equal((await lstat(config)).mode & 0o777, 0o600);
    await assert.rejects(lstat(join(home, ".codex/new")), { code: "ENOENT" });
    await assert.rejects(lstat(join(home, ".gemini")), { code: "ENOENT" });
    await symlink("/", join(home, ".codex/escape"));
    await assert.rejects(snapshot.restore(), AggregateError);
    await assert.rejects(snapshotGuestProfiles(home, ["../outside"]));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("supervisor observation correlates lifecycle event before trigger", async () => {
  const child = nativeChild();
  const stopped = observeNativeReport(child, "MAHOQUOT_QA_SUPERVISOR ", (event) => event.event === "group-terminated");
  child.stdout.emit("data", Buffer.from('MAHOQUOT_QA_SUPERVISOR {"event":"app-exited","code":0}\n'));
  assert.equal(child.stdout.listenerCount("data"), 1);
  child.stdout.emit("data", Buffer.from('MAHOQUOT_QA_SUPERVISOR {"event":"group-terminated","pgid":123}\n'));
  assert.equal((await stopped).pgid, 123);
  assert.equal(child.stdout.listenerCount("data"), 0);
});
import { runCase, keychainTransaction, observeNativeReport, parseKeychainPaths, forceStop, collectCommand } from "../qa/cases/desktop-parity.mjs";

test("command output failure still awaits exit and remaining pipe drainage", async () => {
  for (const killFails of [false, true]) {
    const outputError = new Error("injected output failure");
    const killError = new Error("injected kill failure");
    let outputController, errorController, resolveExit, resolveKill;
    const stdout = new ReadableStream({ start(controller) { outputController = controller; } });
    const stderr = new ReadableStream({ start(controller) { errorController = controller; } });
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const killed = new Promise((resolve) => { resolveKill = resolve; });
    const child = { stdout, stderr, exited, kill(signal) {
      assert.equal(signal, "SIGKILL");
      resolveKill();
      if (killFails) throw killError;
    } };
    let completed = false;
    const result = collectCommand(child, "fixture");
    const checked = assert.rejects(result, (error) => {
      completed = true;
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, killFails ? [outputError, killError] : [outputError]);
      return true;
    });
    outputController.error(outputError);
    await killed;
    assert.equal(completed, false);
    resolveExit(1);
    await exited;
    assert.equal(completed, false);
    errorController.close();
    await checked;
  }
});

test("failed stop delivery still observes group ACK and supervisor close before rejecting", async () => {
  for (const ackFails of [false, true]) {
    const signals = new EventEmitter();
    const deliveryError = new Error("injected synchronous send failure");
    const ackError = new Error("injected group cleanup failure");
    let ackObserved = false;
    let closeObserved = false;
    let eof = false;
    const stopped = new Promise((resolve, reject) => signals.once("ack", () => {
      ackObserved = true;
      if (ackFails) reject(ackError); else resolve({ event: "group-terminated" });
    }));
    const supervisorClosed = new Promise((resolve) => signals.once("close", () => {
      closeObserved = true;
      resolve({ code: 0, signal: null });
    }));
    const app = {
      send() { throw deliveryError; },
      child: { stdin: { end() { eof = true; } } },
      stopped, supervisorClosed,
    };
    const result = forceStop(app);
    const checked = assert.rejects(result, (error) => {
      assert.equal(eof, true);
      assert.equal(ackObserved, true);
      assert.equal(closeObserved, true);
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, ackFails ? [deliveryError, ackError] : [deliveryError]);
      return true;
    });
    // Exact deferred signals, not timers: ACK alone cannot end cleanup.
    signals.emit("ack");
    await stopped.catch(() => {});
    signals.emit("close");
    await checked;
  }
});

function securityFixture() {
  const initial = { default: ["/guest/login.keychain-db"], search: ["/guest/login.keychain-db", "/guest/other.keychain-db"] };
  const state = structuredClone(initial);
  const owned = new Set();
  const calls = [];
  let fail = () => false;
  return {
    state, initial, owned, calls,
    failWhen(predicate) { fail = predicate; },
    async run(args) {
      calls.push(args);
      if (fail(args)) throw new Error("injected security failure");
      const [command] = args;
      if (command === "create-keychain") {
        assert(!owned.has(args.at(-1)));
        owned.add(args.at(-1));
      } else if (command === "delete-keychain") {
        assert(!state.default.includes(args[1]) && !state.search.includes(args[1]));
        assert(owned.delete(args[1]));
      } else if (["default-keychain", "list-keychains"].includes(command)) {
        const key = command === "default-keychain" ? "default" : "search";
        if (args[3] === "-s") state[key] = args.slice(4);
        else return state[key].map((path) => `    "${path}"`).join("\n") + "\n";
      }
      return "";
    },
  };
}

test("public admission rejects both variants before accessing any context", async () => {
  const context = new Proxy({}, { get() { assert.fail("resource access before admission"); } });
  for (const variant of ["happy", "failure"]) await assert.rejects(runCase(variant, "/unused", context));
});

test("guest transaction restores exact ordered preferences and deletes only owned keychains", async () => {
  const fixture = securityFixture();
  const tx = await keychainTransaction(fixture.run);
  await tx.create("/guest/qa/a.keychain-db", "fixture-password");
  await tx.create("/guest/qa/b.keychain-db", "fixture-password");
  await tx.restore();
  assert.deepEqual(fixture.state, fixture.initial);
  assert.equal(fixture.owned.size, 0);
  assert.deepEqual(fixture.calls.filter(([name]) => name === "delete-keychain").map((args) => args[1]),
    ["/guest/qa/a.keychain-db", "/guest/qa/b.keychain-db"]);
});

test("failed preference restoration retains owned keychain and rejects cleanup", async () => {
  const fixture = securityFixture();
  const tx = await keychainTransaction(fixture.run);
  await tx.create("/guest/qa/a.keychain-db", "fixture-password");
  fixture.failWhen((args) => args[0] === "default-keychain" && args[3] === "-s");
  await assert.rejects(tx.restore(), AggregateError);
  assert.equal(fixture.owned.size, 1);
  assert.equal(fixture.calls.filter(([name]) => name === "delete-keychain").length, 0);
});

test("partial creation failure remains owned for cleanup; deletion failure stays visible", async () => {
  const fixture = securityFixture();
  const tx = await keychainTransaction(fixture.run);
  fixture.failWhen((args) => args[0] === "unlock-keychain");
  await assert.rejects(tx.create("/guest/qa/a.keychain-db", "fixture-password"));
  fixture.failWhen((args) => args[0] === "delete-keychain");
  await assert.rejects(tx.restore(), AggregateError);
  assert.deepEqual(fixture.state, fixture.initial);
  assert.equal(fixture.owned.size, 1);
  fixture.failWhen(() => false);
  await tx.restore();
  assert.equal(fixture.owned.size, 0);
});

test("snapshot failure and existing paths cannot mutate keychain state", async () => {
  assert.throws(() => parseKeychainPaths("unexpected output"));
  const fixture = securityFixture();
  fixture.failWhen((args) => args[0] === "list-keychains");
  await assert.rejects(keychainTransaction(fixture.run));
  assert.equal(fixture.owned.size, 0);
  fixture.failWhen(() => false);
  const tx = await keychainTransaction(fixture.run);
  await assert.rejects(tx.create(fixture.initial.default[0], "fixture-password"));
  assert.deepEqual(fixture.state, fixture.initial);
});

function nativeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}

test("native report observation handles split frames and unsubscribes after completion", async () => {
  const child = nativeChild();
  const report = observeNativeReport(child);
  child.stdout.emit("data", Buffer.from('noise\nMAHOQUOT_NATIVE_QA {"steps":['));
  assert.equal(child.stdout.listenerCount("data"), 1);
  child.stdout.emit("data", Buffer.from(']}\n'));
  assert.deepEqual(await report, { steps: [] });
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("malformed reports and child failure reject instead of hanging", async () => {
  for (const trigger of [
    (child) => child.stdout.emit("data", Buffer.from("MAHOQUOT_NATIVE_QA not-json\n")),
    (child) => child.emit("error", new Error("spawn failure")),
    (child) => child.emit("exit", 1, null),
  ]) {
    const child = nativeChild();
    const report = observeNativeReport(child);
    const rejected = assert.rejects(report);
    trigger(child);
    await rejected;
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.listenerCount("exit"), 0);
  }
});

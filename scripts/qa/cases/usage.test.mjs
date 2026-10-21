import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditInternals } from "../cliproxy-audit.mjs";
import { cursorUsageFrame, responsesFixture, USAGE_SCENARIOS, readHistoryEvent, mandatoryUsageExtras, validateUsageExtras, validateUsageReceipt, runRepeatAccounting, cleanupStages, selectFixtureGeminiModel } from "./usage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EVIDENCE_BASE = join(ROOT, ".omo/evidence/cliproxy-remediation");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createSyntheticEnvironment(dir) {
  const sourceRoot = join(dir, "mahoquot-proxy");
  await mkdir(join(sourceRoot, "crates/gateway/src"), { recursive: true });
  let proc;
  let timer;
  let cleanupTimer;
  let settlement = Promise.resolve([]);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("synthetic git init timed out after 2000ms")), 2_000);
  });
  try {
    proc = Bun.spawn(["git", "init", "-q"], { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" });
    settlement = Promise.allSettled([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    const results = await Promise.race([settlement, deadline]);
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "synthetic git init exit/pipe failure");
    if (results[0].value !== 0) throw new Error(`synthetic git init failed (${results[0].value}): ${results[2].value}`);
  } catch (primary) {
    const errors = [primary];
    if (proc) {
      try { proc.kill("SIGKILL"); } catch (error) { errors.push(error); }
      const cleanupDeadline = new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error("synthetic git init exit/pipe cleanup timed out after 1000ms")), 1_000);
      });
      try {
        const results = await Promise.race([settlement, cleanupDeadline]);
        errors.push(...results.filter((result) => result.status === "rejected").map((result) => result.reason));
      } catch (error) { errors.push(error); }
    }
    if (errors.length > 1) throw new AggregateError(errors, "synthetic git init and cleanup failed", { cause: primary });
    throw primary;
  } finally {
    clearTimeout(timer);
    clearTimeout(cleanupTimer);
  }
  const inputs = {
    "Cargo.toml": "[workspace]\n",
    "crates/gateway/Cargo.toml": "[package]\nname = 'gateway'\n",
    "crates/types/Cargo.toml": "[package]\nname = 'types'\n",
    "crates/registry/Cargo.toml": "[package]\nname = 'registry'\n",
    "crates/router/Cargo.toml": "[package]\nname = 'router'\n",
    "crates/providers/Cargo.toml": "[package]\nname = 'providers'\n",
    "crates/gateway/src/main.rs": "fn main() {}\n",
    "crates/registry/catalog/models-v1.json": "{}\n",
    "crates/gateway/src/compat/zcode-system-blocks.json": "[]\n",
    "crates/gateway/src/compat/devin.proto": 'syntax = "proto3";\n',
    "ui/index.html": "<html>synthetic</html>\n",
    ".omo/upstream/route-groups.json": "{}\n",
  };
  for (const [path, bytes] of Object.entries(inputs)) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), bytes);
  }
  const lockContent = "# Cargo.lock dummy\n";
  await writeFile(join(sourceRoot, "Cargo.lock"), lockContent);

  const binDir = join(dir, "target/debug");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "mahoquot-gateway");
  const binBytes = Buffer.from("GENUINE-BINARY-FIXTURE-BYTES");
  const binSha = sha256(binBytes);
  await writeFile(binPath, binBytes);

  const sourceRev = "e45abe155cf435f68e6521917828693d66381c5e";
  const cmd = "CARGO_TARGET_DIR=target cargo build -p mahoquot-gateway --bin mahoquot-gateway";
  const { files, sourceHash: treeHash } = await auditInternals.getSourceClosure(sourceRoot);
  const buildReceiptContent = `${sourceRev}\n${binSha}\n${treeHash}\n${cmd}\n`;
  const buildReceiptSha = sha256(Buffer.from(buildReceiptContent));
  const buildReceiptPath = join(binDir, "source-revision.txt");
  await writeFile(buildReceiptPath, buildReceiptContent);

  const provenance = {
    gateway_binary: binPath,
    gateway_sha256: binSha,
    desktop_revision: "92a7dc0b68bf3c13f5e9a1ac7b99dfdaa2f1e2e8",
    gateway_revision: sourceRev,
    gateway_source_sha256: treeHash,
    source_root: sourceRoot,
    source_manifest: { files },
    build_command: cmd,
    build_receipt: {
      path: buildReceiptPath,
      sha256: buildReceiptSha,
    },
    binary_source_revision: sourceRev,
    dirty: false,
  };

  return { sourceRoot, binPath, provenance };
}

describe("usage parity case contract", () => {
  test("Google fixture selection uses live ownership rather than Gemini spelling", () => {
    const catalog = { data: [
      { id: "other-vendor/gemini-model", owned_by: "other-vendor" },
      { id: "native-live-model", owned_by: "google" },
    ] };
    expect(selectFixtureGeminiModel(catalog)).toBe("native-live-model");
    expect(() => selectFixtureGeminiModel({ data: [catalog.data[0]] })).toThrow();
  });

  test("Cursor fixture preserves distinct read and write protobuf fields", () => {
    const frame = cursorUsageFrame();
    expect(frame.readUInt32BE(1)).toBe(frame.length - 5);
    expect([...frame.subarray(9)]).toEqual([8, 30, 16, 2, 24, 7, 32, 3, 40, 1]);
  });

  test("Responses rollover retains final usage after both capture windows", () => {
    const scenario = USAGE_SCENARIOS.find((entry) => entry.id === "responses-rollover");
    const fixture = responsesFixture(scenario);
    expect(Buffer.byteLength(fixture)).toBeGreaterThan(32768);
    const final = JSON.parse(fixture.trim().split("data: ").at(-1));
    expect(final.response.usage).toEqual(scenario.usage);
    expect(final.response.usage.input_tokens_details).toBeUndefined();
  });

  test("history caller cancellation aborts an attached stalled body", async () => {
    let cancel;
    const cancelled = new Promise((resolveCancel) => { cancel = resolveCancel; });
    let timer;
    const boundedCancelled = Promise.race([cancelled, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("cancel event missing")), 1000);
    })]);
    boundedCancelled.catch(() => {});
    const fetchHistory = async (_url, { signal }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          signal.addEventListener("abort", () => { controller.error(signal.reason); cancel(); }, { once: true });
        },
      });
      return new Response(body, { status: 200 });
    };
    try {
      await expect(readHistoryEvent("http://127.0.0.1/history", "event", 1000, fetchHistory,
        (controller) => controller.abort())).rejects.toThrow();
      await expect(boundedCancelled).resolves.toBeUndefined();
    } finally { clearTimeout(timer); }
  });

  test("mandatory extras reject omissions duplicates wrong values and false passes", () => {
    const makeReceipt = () => ({ variant: "happy", required_extra_assertion_ids: mandatoryUsageExtras("happy"),
      extra_assertions: mandatoryUsageExtras("happy").map((id) => ({ id, expected: { value: 1 }, actual: { value: 1 }, pass: true })) });
    expect(() => validateUsageExtras(makeReceipt())).not.toThrow();
    for (const mutate of [
      (receipt) => receipt.extra_assertions.pop(),
      (receipt) => receipt.extra_assertions.push(receipt.extra_assertions[0]),
      (receipt) => { receipt.extra_assertions[0].actual.value = 2; },
      (receipt) => { receipt.extra_assertions[0].pass = false; },
      (receipt) => { receipt.required_extra_assertion_ids = []; receipt.extra_assertions = []; },
    ]) {
      const receipt = makeReceipt(); mutate(receipt);
      expect(() => validateUsageExtras(receipt)).toThrow();
    }
  });

  test("repeat accounting keeps exact checked surfaces outside mandatory publication", async () => {
    const required = mandatoryUsageExtras("happy");
    const previous = { eventId: "first", history: { "total-tokens": 760 } };
    const exercise = async (mutate = () => {}, result = { eventId: "repeat", history: { "total-tokens": 760 } }) => {
      const published = required.filter((id) => id !== "repeat-accounting-deterministic")
        .map((id) => ({ id, expected: { value: 1 }, actual: { value: 1 }, pass: true }));
      const events = [];
      let local;
      await runRepeatAccounting(previous, published, events, async (destination, recordedEvents) => {
        expect(destination).not.toBe(published);
        expect(recordedEvents).toBe(events);
        local = ["wire", "public-history", "sqlite"].map((surface) => ({
          id: `responses-unknown-cache-${surface}`,
          expected: { input: 700, output: 60, total: 760, read_known: false },
          actual: { input: 700, output: 60, total: 760, read_known: false }, pass: true,
        }));
        mutate(local);
        destination.push(...local);
        recordedEvents.push({ type: "accounting-surfaces", eventId: result.eventId });
        return result;
      });
      expect(events).toEqual([
        { type: "accounting-surfaces", eventId: result.eventId },
        { type: "repeat-accounting-assertions", assertions: local },
      ]);
      expect(published).toHaveLength(29);
      expect(() => validateUsageExtras({ variant: "happy", required_extra_assertion_ids: required, extra_assertions: published })).not.toThrow();
    };
    await exercise();
    for (const mutate of [
      (records) => records.pop(),
      (records) => records.push(records[0]),
      (records) => { records[0].id = "wrong-id"; },
      (records) => { records[0].actual.total = 2; },
      (records) => { records[0].pass = false; },
    ]) {
      await expect(exercise(mutate)).rejects.toThrow();
    }
    await expect(exercise(() => {}, previous)).rejects.toThrow("fresh correlated event ID");
    await expect(exercise(() => {}, { eventId: "repeat", history: { "total-tokens": 761 } })).rejects.toThrow("repeat-accounting-deterministic");
  });

  test("cleanup attempts every stage and propagates primary plus cleanup failures", async () => {
    const primary = new Error("request failed");
    const cleanup = new Error("mock stop failed");
    const reached = [];
    const failure = await cleanupStages([
      () => { reached.push("mock"); throw cleanup; },
      () => { reached.push("child"); },
      () => { reached.push("pipes"); },
      () => { reached.push("fixture"); throw new Error("rm failed"); },
      () => { reached.push("rebind"); },
    ], primary).catch((error) => error);
    expect(reached).toEqual(["mock", "child", "pipes", "fixture", "rebind"]);
    expect(failure.errors.slice(0, 2)).toEqual([primary, cleanup]);
    expect(failure.cause).toBe(primary);
  });

  test("cases/usage.mjs exports runCase function", async () => {
    const mod = await import("./usage.mjs");
    expect(typeof mod.runCase).toBe("function");
  });

  test("usage happy receipt with byte-backed provenance passes audit validator", async () => {
    const scratchDir = join(
      EVIDENCE_BASE,
      `scratch-test-usage-happy-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    );
    await mkdir(scratchDir, { recursive: true });

    try {
      const { provenance } = await createSyntheticEnvironment(scratchDir);

      const requestBody = Buffer.from('{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}');
      const receipt = {
        schema: "cliproxy-parity/task1-v1",
        case: "usage",
        variant: "happy",
        created_at: new Date().toISOString(),
        assertions: [
          {
            id: "terminal-usage-once",
            expected: {
              terminal_stop_count: 1,
              usage_present: true,
              prompt_tokens: 700,
              completion_tokens: 60,
              total_tokens: 760,
              reasoning_tokens: 16,
            },
            actual: {
              terminal_stop_count: 1,
              usage_present: true,
              prompt_tokens: 700,
              completion_tokens: 60,
              total_tokens: 760,
              reasoning_tokens: 16,
            },
            pass: true,
          },
          {
            id: "history-usage-equal",
            expected: {
              input_tokens: 700,
              output_tokens: 60,
              reasoning_tokens: 16,
              cached_input_tokens: 0,
              cached_input_tokens_known: 1,
              total_tokens: 760,
              succeeded: 1,
            },
            actual: {
              input_tokens: 700,
              output_tokens: 60,
              reasoning_tokens: 16,
              cached_input_tokens: 0,
              cached_input_tokens_known: 1,
              total_tokens: 760,
              succeeded: 1,
            },
            pass: true,
          },
        ],
        required_assertion_ids: ["terminal-usage-once", "history-usage-equal"],
        events: [
          { id: "event-1", type: "stdout", line: "listening on 18840" },
          { id: "event-2", type: "response-data", data: "data: {\"choices\":[]}\n\n" },
          { id: "event-3", type: "exit", code: 0, signal: null },
        ],
        event_order: ["stdout", "response-data", "exit"],
        wire_capture: {
          gateway_requests: [
            {
              method: "POST",
              path: "/v1internal:streamGenerateContent",
              body_bytes_base64: requestBody.toString("base64"),
              body_sha256: sha256(requestBody),
            },
          ],
        },
        provenance,
        teardown: {
          exit: { code: 0, signal: null },
          listeners: 0,
          ownedProcesses: 0,
          listener_inventory: [],
          process_inventory: [],
          termination: "controlled-signal",
        },
      };

      await auditInternals.validateReceipt(receipt, "usage", "happy", "usage/happy");
      receipt.required_extra_assertion_ids = mandatoryUsageExtras("happy");
      receipt.extra_assertions = mandatoryUsageExtras("happy").map((id) => ({ id, expected: { observed: true }, actual: { observed: true }, pass: true }));
      await validateUsageReceipt(receipt, "usage/happy-expanded");
      expect(receipt.assertions.map((record) => record.id)).toEqual(["terminal-usage-once", "history-usage-equal"]);
      expect(Object.hasOwn(receipt.wire_capture, "external_dials")).toBe(false);
      receipt.extra_assertions[0].actual.observed = false;
      await expect(validateUsageReceipt(receipt)).rejects.toThrow();
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("usage failure receipt with byte-backed provenance passes audit validator", async () => {
    const scratchDir = join(
      EVIDENCE_BASE,
      `scratch-test-usage-fail-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    );
    await mkdir(scratchDir, { recursive: true });

    try {
      const { provenance } = await createSyntheticEnvironment(scratchDir);

      const receipt = {
        schema: "cliproxy-parity/task1-v1",
        case: "usage",
        variant: "failure",
        created_at: new Date().toISOString(),
        assertions: [
          {
            id: "truncated-stream-unsuccessful",
            expected: {
              completed_emitted: false,
              unsuccessful: true,
              db_succeeded: 0,
            },
            actual: {
              completed_emitted: false,
              unsuccessful: true,
              db_succeeded: 0,
            },
            pass: true,
          },
        ],
        required_assertion_ids: ["truncated-stream-unsuccessful"],
        events: [
          { id: "event-1", type: "stdout", line: "listening on 18840" },
          { id: "event-2", type: "response-data", data: "data: {\"error\":{}}\n\n" },
          { id: "event-3", type: "exit", code: 0, signal: null },
        ],
        event_order: ["stdout", "response-data", "exit"],
        wire_capture: {
          gateway_requests: [],
        },
        provenance,
        teardown: {
          exit: { code: 0, signal: null },
          listeners: 0,
          ownedProcesses: 0,
          listener_inventory: [],
          process_inventory: [],
          termination: "controlled-signal",
        },
      };

      await auditInternals.validateReceipt(receipt, "usage", "failure", "usage/failure");
      receipt.required_extra_assertion_ids = mandatoryUsageExtras("failure");
      receipt.extra_assertions = mandatoryUsageExtras("failure").map((id) => ({ id, expected: { observed: true }, actual: { observed: true }, pass: true }));
      await validateUsageReceipt(receipt, "usage/failure-expanded");
      expect(Object.hasOwn(receipt.wire_capture, "external_dials")).toBe(false);
      receipt.extra_assertions.pop();
      await expect(validateUsageReceipt(receipt)).rejects.toThrow();
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("audit validator rejects invalid or missing assertion IDs for usage case", async () => {
    const invalidReceipt = {
      schema: "cliproxy-parity/task1-v1",
      case: "usage",
      variant: "happy",
      created_at: new Date().toISOString(),
      assertions: [
        { id: "wrong-id", expected: true, actual: true, pass: true },
      ],
      events: [],
      wire_capture: { gateway_requests: [], external_dials: 0 },
      provenance: {
        gateway_binary: "/bin/false",
        gateway_sha256: "0".repeat(64),
        desktop_revision: "a".repeat(40),
        gateway_revision: "a".repeat(40),
        binary_source_revision: "a".repeat(40),
        gateway_source_sha256: "0".repeat(64),
        dirty: false,
      },
      teardown: { exit: { code: 0 }, listeners: 0, ownedProcesses: 0 },
    };

    await expect(
      auditInternals.validateReceipt(invalidReceipt, "usage", "happy", "usage/invalid")
    ).rejects.toThrow();
  });

  test("audit validator rejects mismatched expected/actual in usage assertions", async () => {
    const mismatchedReceipt = {
      schema: "cliproxy-parity/task1-v1",
      case: "usage",
      variant: "happy",
      created_at: new Date().toISOString(),
      assertions: [
        {
          id: "terminal-usage-once",
          expected: { total_tokens: 760 },
          actual: { total_tokens: 700 },
          pass: false,
        },
        {
          id: "history-usage-equal",
          expected: { total_tokens: 760 },
          actual: { total_tokens: 760 },
          pass: true,
        },
      ],
      required_assertion_ids: ["terminal-usage-once", "history-usage-equal"],
      events: [],
      wire_capture: { gateway_requests: [], external_dials: 0 },
      provenance: {
        gateway_binary: "/bin/false",
        gateway_sha256: "0".repeat(64),
        desktop_revision: "a".repeat(40),
        gateway_revision: "a".repeat(40),
        binary_source_revision: "a".repeat(40),
        gateway_source_sha256: "0".repeat(64),
        dirty: false,
      },
      teardown: { exit: { code: 0 }, listeners: 0, ownedProcesses: 0 },
    };

    await expect(
      auditInternals.validateReceipt(mismatchedReceipt, "usage", "happy", "usage/mismatch")
    ).rejects.toThrow();
  });
});

describe("preserved W1 history body cancellation", () => {
  test("stalled history body is aborted and the server observes connection close", async () => {
    const { readHistoryEvent } = await import("./usage.mjs");
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.once("close", () => resolveClosed());
      response.write('{"event":');
    });
    let resolveClosed;
    const closed = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });

    try {
      const address = server.address();
      const port = address.port;
      const outcome = await readHistoryEvent(`http://127.0.0.1:${port}/v0/management/history/events/stalled-event`, "stalled-event", 50)
        .then(() => ({ resolved: true }), (error) => ({ resolved: false, message: error.message }));
      expect(outcome.resolved).toBe(false);
      expect(outcome.message).toContain("timed out");
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

});

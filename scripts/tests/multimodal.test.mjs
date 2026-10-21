import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditInternals } from "../qa/cliproxy-audit.mjs";
import { assertAdversarialAssertions, assertCodexImageToolWire, assertEventSequence, assertSnapshotsEqual, runHeldPermutation, selectCodexCatalogEntry, snapshotFiles } from "../qa/cases/multimodal.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE_BASE = join(ROOT, ".omo/evidence/cliproxy-remediation");

async function createSyntheticProvenance(scratchDir, sourceBytes, binBytes) {
  const sourceRoot = join(scratchDir, "mahoquot-proxy");
  await mkdir(sourceRoot, { recursive: true });
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
    "Cargo.lock": "# Cargo.lock dummy\n",
    "crates/gateway/Cargo.toml": "[package]\nname = 'gateway'\n",
    "crates/types/Cargo.toml": "[package]\nname = 'types'\n",
    "crates/registry/Cargo.toml": "[package]\nname = 'registry'\n",
    "crates/router/Cargo.toml": "[package]\nname = 'router'\n",
    "crates/providers/Cargo.toml": "[package]\nname = 'providers'\n",
    "crates/registry/catalog/models-v1.json": "{}\n",
    "crates/gateway/src/compat/zcode-system-blocks.json": "[]\n",
    "crates/gateway/src/compat/devin.proto": 'syntax = "proto3";\n',
    "ui/index.html": "<html>synthetic</html>\n",
    ".omo/upstream/route-groups.json": "{}\n",
    "crates/gateway/src/compat/claude.rs": sourceBytes,
  };
  for (const [path, bytes] of Object.entries(inputs)) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), bytes);
  }
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const { files, sourceHash } = await auditInternals.getSourceClosure(sourceRoot);
  const binPath = join(scratchDir, "bin/mahoquot-gateway");
  await mkdir(dirname(binPath), { recursive: true });
  await writeFile(binPath, binBytes);
  const binSha = sha256(binBytes);
  const rev = "e45abe155cf435f68e6521917828693d66381c5e";
  const cmd = "CARGO_TARGET_DIR=target cargo build -p mahoquot-gateway --bin mahoquot-gateway";
  const receiptContent = `${rev}\n${binSha}\n${sourceHash}\n${cmd}\n`;
  const receiptPath = join(scratchDir, "source-revision.txt");
  await writeFile(receiptPath, receiptContent);
  return {
    gateway_binary: binPath,
    gateway_sha256: binSha,
    desktop_revision: rev,
    gateway_revision: rev,
    binary_source_revision: rev,
    gateway_source_sha256: sourceHash,
    source_root: sourceRoot,
    source_manifest: { files },
    build_command: cmd,
    build_receipt: { path: receiptPath, sha256: sha256(Buffer.from(receiptContent)) },
    dirty: false,
  };
}

describe("multimodal parity case contract", () => {
  for (const owner of ["openai", "codex"]) {
    test(`selects the public catalog entry owned by ${owner} without changing its ID`, () => {
      // Given an unrelated entry and a dynamically named owned entry.
      const owned = { id: "runtime-vendor-model", owned_by: owner };
      const catalog = { data: [{ id: "gpt-5.5", owned_by: "anthropic" }, owned] };
      // When selecting for the fixture's sole OpenAI/Codex provider.
      const selected = selectCodexCatalogEntry(catalog);
      // Then the actual catalog object and ID are retained verbatim.
      expect(selected).toBe(owned);
      expect(selected.id).toBe("runtime-vendor-model");
    });
  }

  test("rejects a public catalog with no OpenAI/Codex-owned candidate", () => {
    // Given a catalog containing only another vendor.
    const catalog = { data: [{ id: "runtime-other-model", owned_by: "anthropic" }] };
    // When selecting, then absence is an explicit failure rather than a fixed-ID fallback.
    expect(() => selectCodexCatalogEntry(catalog)).toThrow();
  });

  test("cases/multimodal.mjs exports runCase function", async () => {
    const mod = await import("../qa/cases/multimodal.mjs");
    expect(typeof mod.runCase).toBe("function");
  });

  test("multimodal happy receipt with byte-backed provenance passes audit validator", async () => {
    const scratchDir = join(EVIDENCE_BASE, `scratch-test-multimodal-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const sha256 = (b) => createHash("sha256").update(b).digest("hex");
    const validProv = await createSyntheticProvenance(
      scratchDir, Buffer.from("// genuine byte-backed test fixture"), Buffer.from("GENUINE-BINARY-FIXTURE-BYTES")
    );

    const receipt = {
      schema: "cliproxy-parity/task1-v1",
      case: "multimodal",
      variant: "happy",
      created_at: new Date().toISOString(),
      assertions: [
        { id: "image-bytes-preserved", expected: true, actual: true, pass: true },
        { id: "document-fields-preserved", expected: true, actual: true, pass: true },
        { id: "cache-ttl-preserved", expected: true, actual: true, pass: true },
      ],
      required_assertion_ids: ["image-bytes-preserved", "document-fields-preserved", "cache-ttl-preserved"],
      events: [
        { id: "event-1", type: "stdout", line: "listening on 18860" },
        { id: "event-2", type: "response-data", data: "ok" },
        { id: "event-3", type: "exit", code: 0, signal: null },
      ],
      event_order: ["stdout", "response-data", "exit"],
      wire_capture: {
        gateway_requests: [
          {
            method: "POST",
            path: "/v1/messages",
            body_bytes_base64: "e30=",
            body_sha256: sha256(Buffer.from("{}")),
          },
        ],
      },
      provenance: validProv,
      teardown: {
        exit: { code: 0, signal: null },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
        termination: "controlled-signal",
      },
    };

    try {
      await auditInternals.validateReceipt(receipt, "multimodal", "happy", "multimodal/happy");
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("multimodal failure receipt with byte-backed provenance passes audit validator", async () => {
    const scratchDir = join(EVIDENCE_BASE, `scratch-test-multimodal-fail-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const sha256 = (b) => createHash("sha256").update(b).digest("hex");
    const validProv = await createSyntheticProvenance(
      scratchDir, Buffer.from("// genuine byte-backed test fixture failure"), Buffer.from("GENUINE-BINARY-FIXTURE-BYTES-FAIL")
    );

    const receipt = {
      schema: "cliproxy-parity/task1-v1",
      case: "multimodal",
      variant: "failure",
      created_at: new Date().toISOString(),
      assertions: [
        { id: "unsupported-media-400", expected: true, actual: true, pass: true },
        { id: "no-upstream-call", expected: 0, actual: 0, pass: true },
      ],
      required_assertion_ids: ["unsupported-media-400", "no-upstream-call"],
      events: [
        { id: "event-1", type: "stdout", line: "listening on 18860" },
        { id: "event-2", type: "response-data", data: "error: unsupported media" },
        { id: "event-3", type: "exit", code: 0, signal: null },
      ],
      event_order: ["stdout", "response-data", "exit"],
      wire_capture: {
        gateway_requests: [],
      },
      provenance: validProv,
      teardown: {
        exit: { code: 0, signal: null },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
        termination: "controlled-signal",
      },
    };

    try {
      await auditInternals.validateReceipt(receipt, "multimodal", "failure", "multimodal/failure");
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("audit validator rejects invalid assertion IDs for multimodal case", async () => {
    const invalidReceipt = {
      schema: "cliproxy-parity/task1-v1",
      case: "multimodal",
      variant: "happy",
      created_at: new Date().toISOString(),
      assertions: [
        { id: "wrong-id", expected: true, actual: true, pass: true },
      ],
      events: [],
      wire_capture: { gateway_requests: [] },
      provenance: { gateway_binary: "/bin/false", gateway_sha256: "0".repeat(64), desktop_revision: "a".repeat(40), gateway_revision: "a".repeat(40), binary_source_revision: "a".repeat(40), gateway_source_sha256: "0".repeat(64), dirty: false },
      teardown: { exit: { code: 0 }, listeners: 0, ownedProcesses: 0 },
    };

    await expect(
      auditInternals.validateReceipt(invalidReceipt, "multimodal", "happy", "multimodal/invalid")
    ).rejects.toThrow();
  });

  test("multimodal happy receipt with native Anthropic document and cache TTL assertions passes audit validator", async () => {
    const scratchDir = join(EVIDENCE_BASE, `scratch-test-multimodal-native-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const sha256 = (b) => createHash("sha256").update(b).digest("hex");
    const validProv = await createSyntheticProvenance(
      scratchDir, Buffer.from("// genuine byte-backed test fixture native"), Buffer.from("GENUINE-BINARY-FIXTURE-BYTES-NATIVE")
    );

    const receipt = {
      schema: "cliproxy-parity/task1-v1",
      case: "multimodal",
      variant: "happy",
      created_at: new Date().toISOString(),
      assertions: [
        { id: "image-bytes-preserved", expected: true, actual: true, pass: true },
        { id: "document-fields-preserved", expected: true, actual: true, pass: true },
        { id: "cache-ttl-preserved", expected: true, actual: true, pass: true },
      ],
      adversarial_assertions: [
        { id: "native-anthropic-image-preserved", expected: true, actual: true, pass: true },
        { id: "native-anthropic-document-preserved", expected: true, actual: true, pass: true },
        { id: "native-anthropic-cache-ttl-preserved", expected: true, actual: true, pass: true },
        { id: "prompt-injection-inert", expected: true, actual: true, pass: true },
        { id: "cancel-resume-clean", expected: true, actual: true, pass: true },
      ],
      required_assertion_ids: ["image-bytes-preserved", "document-fields-preserved", "cache-ttl-preserved"],
      events: [
        { id: "event-1", type: "stdout", line: "listening on 18860" },
        { id: "event-2", type: "response-data", data: "ok" },
        { id: "event-3", type: "exit", code: 0, signal: null },
      ],
      event_order: ["stdout", "response-data", "exit"],
      wire_capture: {
        gateway_requests: [
          {
            method: "POST",
            path: "/v1/messages",
            body_bytes_base64: "e30=",
            body_sha256: sha256(Buffer.from("{}")),
          },
        ],
      },
      provenance: validProv,
      teardown: {
        exit: { code: 0, signal: null },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
        termination: "controlled-signal",
      },
    };

    try {
      await auditInternals.validateReceipt(receipt, "multimodal", "happy", "multimodal/happy");
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("multimodal failure receipt with unsupported Codex and malformed zero-dial assertions passes audit validator", async () => {
    const scratchDir = join(EVIDENCE_BASE, `scratch-test-multimodal-codex-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const sha256 = (b) => createHash("sha256").update(b).digest("hex");
    const validProv = await createSyntheticProvenance(
      scratchDir, Buffer.from("// genuine byte-backed test fixture codex failure"), Buffer.from("GENUINE-BINARY-FIXTURE-BYTES-CODEX-FAIL")
    );

    const receipt = {
      schema: "cliproxy-parity/task1-v1",
      case: "multimodal",
      variant: "failure",
      created_at: new Date().toISOString(),
      assertions: [
        { id: "unsupported-media-400", expected: true, actual: true, pass: true },
        { id: "no-upstream-call", expected: 0, actual: 0, pass: true },
      ],
      adversarial_assertions: [
        { id: "codex-unsupported-document-400-zero-dial", expected: { status: 400, rejected: true, upstream_calls: 0 }, actual: { status: 400, rejected: true, upstream_calls: 0 }, pass: true },
        { id: "claude-invalid-media-400-zero-dial", expected: { status: 400, upstream_calls: 0 }, actual: { status: 400, upstream_calls: 0 }, pass: true },
        { id: "malformed-content-400-zero-dial", expected: { status: 400, upstream_calls: 0 }, actual: { status: 400, upstream_calls: 0 }, pass: true },
      ],
      required_assertion_ids: ["unsupported-media-400", "no-upstream-call"],
      events: [
        { id: "event-1", type: "stdout", line: "listening on 18860" },
        { id: "event-2", type: "response-data", data: "error: unsupported document" },
        { id: "event-3", type: "exit", code: 0, signal: null },
      ],
      event_order: ["stdout", "response-data", "exit"],
      wire_capture: {
        gateway_requests: [],
      },
      provenance: validProv,
      teardown: {
        exit: { code: 0, signal: null },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
        termination: "controlled-signal",
      },
    };

    try {
      await auditInternals.validateReceipt(receipt, "multimodal", "failure", "multimodal/failure");
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("audit validator rejects failure receipt when mock external dials are nonzero", async () => {
    const scratchDir = join(EVIDENCE_BASE, `scratch-test-multimodal-leak-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const sha256 = (b) => createHash("sha256").update(b).digest("hex");
    const validProv = await createSyntheticProvenance(
      scratchDir, Buffer.from("// genuine byte-backed test fixture leak"), Buffer.from("GENUINE-BINARY-FIXTURE-BYTES-LEAK")
    );

    const invalidReceipt = {
      schema: "cliproxy-parity/task1-v1",
      case: "multimodal",
      variant: "failure",
      created_at: new Date().toISOString(),
      assertions: [
        { id: "unsupported-media-400", expected: true, actual: true, pass: true },
        { id: "no-upstream-call", expected: 0, actual: 0, pass: true },
      ],
      required_assertion_ids: ["unsupported-media-400", "no-upstream-call"],
      events: [
        { id: "event-1", type: "stdout", line: "listening on 18860" },
        { id: "event-2", type: "response-data", data: "error" },
        { id: "event-3", type: "exit", code: 0, signal: null },
      ],
      event_order: ["stdout", "response-data", "exit"],
      wire_capture: {
        gateway_requests: [],
        external_dials: 1, // Nonzero external dials must fail audit
      },
      provenance: validProv,
      teardown: {
        exit: { code: 0, signal: null },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
        termination: "controlled-signal",
      },
    };

    try {
      await expect(
        auditInternals.validateReceipt(invalidReceipt, "multimodal", "failure", "multimodal/failure-leak")
      ).rejects.toThrow("mock external dials occurred during failure test: 1");
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("dirty snapshot rejects changed bytes, modes, and inventory", async () => {
    // Given actual files, including binary bytes and a non-default mode.
    await mkdir(EVIDENCE_BASE, { recursive: true });
    const scratch = await mkdtemp(join(EVIDENCE_BASE, "dirty-snapshot-"));
    try {
      await writeFile(join(scratch, "dirty.bin"), Buffer.from([0, 255, 10, 13]));
      await chmod(join(scratch, "dirty.bin"), 0o640);
      const before = await snapshotFiles(scratch, ["dirty.bin"]);
      assertSnapshotsEqual(before, await snapshotFiles(scratch, ["dirty.bin"]));
      expect(before[0].mode).toBe(0o640);
      expect(before[0].bytes_base64).toBe(Buffer.from([0, 255, 10, 13]).toString("base64"));
      // When bytes change, then restoration of mode alone cannot hide it.
      await writeFile(join(scratch, "dirty.bin"), Buffer.from([0, 254, 10, 13]));
      expect(() => assertSnapshotsEqual(before, [{ ...before[0], mode: 0o600 }])).toThrow();
      expect(() => assertSnapshotsEqual(before, [])).toThrow();
      const changed = await snapshotFiles(scratch, ["dirty.bin"]);
      expect(() => assertSnapshotsEqual(before, changed)).toThrow();
      await writeFile(join(scratch, "dirty.bin"), Buffer.from([0, 255, 10, 13]));
      await chmod(join(scratch, "dirty.bin"), 0o600);
      const changedMode = await snapshotFiles(scratch, ["dirty.bin"]);
      expect(() => assertSnapshotsEqual(before, changedMode)).toThrow();
      expect(() => assertSnapshotsEqual(before, [{ ...before[0], mode: 0o640, sha256: changed[0].sha256 }])).toThrow();
      expect(() => assertSnapshotsEqual(before, [{ ...before[0], mode: 0o600 }])).toThrow();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("adversarial inventory rejects absent, duplicate, failed, and mismatched observations", () => {
    const ids = ["native-anthropic-image-preserved", "native-anthropic-document-preserved", "native-anthropic-cache-ttl-preserved",
      "image-url-field-preserved", "anthropic-to-codex-image-tool-wire",
      "prompt-injection-inert", "cancel-resume-clean", "stale-state-rotation-01", "stale-state-rotation-10",
      "causal-event-permutations", "hung-body-deadline-socket-cancel", "dirty-bytes-modes-preserved", "two-incarnation-sigint-teardown"];
    const valid = ids.map((id) => ({ id, expected: true, actual: true, pass: true }));
    expect(assertAdversarialAssertions("happy", valid)).toEqual(ids);
    expect(() => assertAdversarialAssertions("happy", valid.slice(1))).toThrow();
    for (const id of ["image-url-field-preserved", "anthropic-to-codex-image-tool-wire"]) {
      expect(() => assertAdversarialAssertions("happy", valid.filter((item) => item.id !== id))).toThrow();
      expect(() => assertAdversarialAssertions("happy", valid.map((item) => item.id === id ? { ...item, actual: false } : item))).toThrow();
    }
    expect(() => assertAdversarialAssertions("happy", [...valid, valid[0]])).toThrow();
    expect(() => assertAdversarialAssertions("happy", valid.map((item, index) => index === 0 ? { ...item, pass: false } : item))).toThrow();
    expect(() => assertAdversarialAssertions("happy", valid.map((item, index) => index === 0 ? { ...item, actual: false } : item))).toThrow();
  });

  test("required failure inventory rejects omitted or false Anthropic document refusal", () => {
    const ids = ["gemini-missing-file-data-400-zero-dial", "gemini-null-file-data-400-zero-dial", "gemini-non-string-file-data-400-zero-dial",
      "gemini-identical-inline-payload-400-zero-dial", "codex-unsupported-document-400-zero-dial", "anthropic-document-400-no-upstream",
      "claude-invalid-media-400-zero-dial", "malformed-content-400-zero-dial", "dirty-bytes-modes-preserved", "two-incarnation-sigint-teardown"];
    const valid = ids.map((id) => ({ id, expected: true, actual: true, pass: true }));
    expect(assertAdversarialAssertions("failure", valid)).toEqual(ids);
    expect(() => assertAdversarialAssertions("failure", valid.filter((item) => item.id !== "anthropic-document-400-no-upstream"))).toThrow();
    expect(() => assertAdversarialAssertions("failure", valid.map((item) => item.id === "anthropic-document-400-no-upstream"
      ? { ...item, actual: false } : item))).toThrow();
  });

  test("Codex wire validator rejects image loss MIME corruption and tool image relocation", () => {
    const wire = { model: "gpt-5.5", stream: true, input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "image" },
        { type: "input_image", image_url: "data:image/png;base64,dXNlcg==" }] },
      { type: "function_call", call_id: "toolu_native_1", name: "take_screenshot", arguments: "{}" },
      { type: "function_call_output", call_id: "toolu_native_1", output: "Native tool result text" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "tool images" },
        { type: "input_image", image_url: "data:image/png;base64,dG9vbA==" }] },
    ] };
    expect(() => assertCodexImageToolWire(wire, "gpt-5.5", "dXNlcg==", "dG9vbA==")).not.toThrow();
    for (const mutate of [
      (value) => { value.input[0].content.pop(); },
      (value) => { value.input[0].content[1].image_url = "data:image/jpeg;base64,dXNlcg=="; },
      (value) => { value.input[3].content[1].image_url = "data:image/png;base64,Y29ycnVwdA=="; },
      (value) => { value.input[2].call_id = "wrong-tool"; },
      (value) => { value.input[2].output = value.input[3].content; value.input.pop(); },
      (value) => { value.input.reverse(); },
    ]) {
      const changed = structuredClone(wire);
      mutate(changed);
      expect(() => assertCodexImageToolWire(changed, "gpt-5.5", "dXNlcg==", "dG9vbA==")).toThrow();
    }
  });

  for (const order of [[0, 1], [1, 0]]) {
    test(`held requests observe mutation before release order ${order.join("/")}`, async () => {
      // Given subscriptions installed before the send actions.
      const makeDeferred = () => {
        let resolve;
        const promise = new Promise((res) => { resolve = res; });
        return { promise, resolve };
      };
      const gates = [0, 1].map(() => ({ arrived: makeDeferred(), release: makeDeferred() }));
      const sequence = [];
      let revision = 0;
      const snapshots = [];
      // When both requests are held across the acknowledged mutation.
      const results = await runHeldPermutation(gates, async (index) => {
        snapshots[index] = revision;
        gates[index].arrived.resolve();
        await gates[index].release.promise;
        return { snapshot: snapshots[index], current: revision };
      }, async () => {
        expect(snapshots).toEqual([0, 0]);
        revision = 1;
      }, order, (type) => sequence.push({ type }));
      // Then old snapshots survive and the requested causal order is exact.
      expect(results).toEqual([{ snapshot: 0, current: 1 }, { snapshot: 0, current: 1 }]);
      expect(sequence.map((event) => event.type)).toEqual([
        "mutation-ack", `release-${order[0]}`, `response-${order[0]}`, `release-${order[1]}`, `response-${order[1]}`,
      ]);
      assertEventSequence(sequence, ["mutation-ack", `release-${order[0]}`, `response-${order[0]}`,
        `release-${order[1]}`, `response-${order[1]}`]);
      expect(() => assertEventSequence(sequence, [`response-${order[1]}`, "mutation-ack"])).toThrow();
      expect(() => assertEventSequence(sequence, ["socket-close"])).toThrow();
    });
  }

});

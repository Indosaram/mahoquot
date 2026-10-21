import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createReceipt, REQUIRED_ASSERTIONS, getSourceClosure, dispatchCase } from "../qa/cliproxy-parity.mjs";
import { auditInternals } from "../qa/cliproxy-audit.mjs";
import { validateExtendedScenarios } from "../qa/cases/retry.mjs";
import { finalizeReceipt } from "../qa/cases/models.mjs";

const root = resolve(import.meta.dir, "../..");
const evidenceRoot = `${root}/.omo/evidence/cliproxy-remediation/6417c774-c554-4c53-880b-d8355082043e`;

describe("retry required adversarial extras", () => {
  test("rejects missing duplicate failed and equal-false adversarial proofs", () => {
    const ids = ["dirty-byte-mode-preservation", "source-closure-preservation", "binary-byte-preservation",
      "retry-round-sequence-status", "retry-round-sequence-nonstub-success", "credential-cap-status", "credential-cap-nonstub-success",
      "zero-retry-same-round-failover", "zero-retry-same-round-failover-status", "zero-retry-same-round-failover-nonstub-success",
      "interval-zero-ready-round", "interval-zero-ready-round-status", "interval-zero-ready-round-nonstub-success",
      "held-settings-snapshot", "held-settings-snapshot-status", "prompt-injection-inert", "prompt-injection-inert-status",
      "prompt-injection-inert-nonstub-success", "held-settings-release-first", "held-settings-release-first-status",
      "prompt-injection-text-preserved", "prompt-injection-settings-unchanged", "held-settings-order-equivalence"];
    const assertions = ids.map((id) => ({ id, expected: true, actual: true, pass: true }));
    expect(validateExtendedScenarios("happy", assertions)).toHaveLength(ids.length);
    for (const id of ["prompt-injection-text-preserved", "prompt-injection-settings-unchanged", "held-settings-order-equivalence"]) {
      expect(() => validateExtendedScenarios("happy", assertions.filter((entry) => entry.id !== id))).toThrow();
      expect(() => validateExtendedScenarios("happy", [...assertions, assertions.find((entry) => entry.id === id)])).toThrow();
      expect(() => validateExtendedScenarios("happy", assertions.map((entry) => entry.id === id ? { ...entry, actual: false, pass: false } : entry))).toThrow();
      expect(() => validateExtendedScenarios("happy", assertions.map((entry) => entry.id === id ? { ...entry, actual: false, pass: true } : entry))).toThrow();
      expect(() => validateExtendedScenarios("happy", assertions.map((entry) => entry.id === id ? { ...entry, expected: false, actual: false, pass: true } : entry))).toThrow();
    }
    expect(() => validateExtendedScenarios("happy", [...assertions, { id: "optional-adversarial-label", expected: true, actual: true, pass: true }])).toThrow();
  });
});

describe("models receipt finalization", () => {
  for (const variant of ["happy", "failure"]) {
    test(`${variant} publishes exact base and auxiliary proofs only after validation`, async () => {
      const catalog = { id: "anthropic/claude-sonnet-4-6", object: "model", owned_by: "anthropic", created: 1791738794 };
      const transition = { before: { collection: true, detail: 200 }, after: { collection: false, detail: 404 } };
      const baseId = variant === "happy" ? "detail-matches-catalog" : "hidden-or-removed-model-404";
      const proof = (id, expected, actual = structuredClone(expected)) => ({ id, expected, actual, pass: true });
      const assertions = [
        proof("fetch-deadline-aborts-upstream", { path: "/deadline-probe", event: "response-body cancellation" }),
        proof(baseId, variant === "happy" ? catalog : transition),
      ];
      if (variant === "failure") assertions.push(
        proof("scoped-collection-hides-model", "model absent"),
        proof("account-removal-detail-before", "detail present"),
        proof("account-removal-detail", 404),
        proof("account-removal-detail-transition", { before: "detail present", after: "detail absent" }),
        proof("account-removal-collection-before", "model present"),
        proof("account-removal-collection-after", "model absent"),
        proof("account-removal-collection-transition", { before: "model present", after: "model absent" }),
        proof("account-removal-detail-error-shape", { code: "model_not_found", type: "invalid_request_error" }),
        proof("missing-model-detail", { status: 404, code: "model_not_found", type: "invalid_request_error" }),
      );
      const expected = { incarnations: 2, binary_sha256: "a".repeat(64), health_status: 200, signal: "SIGINT", pipes_closed: true, port_released: 18885 };
      assertions.push({
        id: "repeated-interruption-incarnations",
        expected,
        actual: [1, 2].map((incarnation) => ({ ...expected, incarnation, ready: true, accepted: true, exit: { code: 0, signal: null } })),
        pass: true,
      });

      const records = { variant, assertions, events: [{ type: "exit", code: null, signal: "SIGINT" }], wireRequests: [], externalDialCount: 0 };
      const published = [];
      const receipt = await finalizeReceipt(records, createReceipt, async (value) => { published.push(value); });
      expect(receipt.required_assertion_ids).toEqual([baseId]);
      expect(receipt.assertions).toEqual([assertions[1]]);
      expect(receipt.auxiliary_assertions).toEqual(assertions.filter((entry) => entry.id !== baseId));
      expect(published).toEqual([receipt]);
      const rejectWithoutPublication = async (invalid) => {
        const rejectedPublications = [];
        await expect(finalizeReceipt({ ...records, assertions: invalid }, createReceipt, async (value) => { rejectedPublications.push(value); })).rejects.toThrow();
        expect(rejectedPublications).toEqual([]);
      };
      for (let index = 0; index < assertions.length; index += 1) {
        await rejectWithoutPublication(assertions.filter((_, item) => item !== index));
        const failed = structuredClone(assertions);
        failed[index].pass = false;
        await rejectWithoutPublication(failed);
      }
      await rejectWithoutPublication([...assertions, assertions[0]]);
      await rejectWithoutPublication([...assertions, assertions[1]]);
      const mismatched = structuredClone(assertions);
      mismatched[0].actual.path = "/wrong-probe";
      await rejectWithoutPublication(mismatched);
      const baseMismatch = structuredClone(assertions);
      baseMismatch[1].actual = { status: 404 };
      await rejectWithoutPublication(baseMismatch);
      const interrupted = structuredClone(assertions);
      interrupted.at(-1).actual[1].pipes_closed = false;
      await rejectWithoutPublication(interrupted);
    });
  }
});

async function invoke(args, env = {}) {
  const proc = Bun.spawn(["bun", "scripts/qa/cliproxy-parity.mjs", ...args], {
    cwd: root,
    env: {
      ...process.env,
      MAHOQUOT_QA_EVIDENCE_ROOT: evidenceRoot,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutTask = new Response(proc.stdout).text();
  const stderrTask = new Response(proc.stderr).text();
  let status;
  let timer;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("invoke timed out after 5000ms")), 5000);
    });
    status = await Promise.race([proc.exited, timeoutPromise]);
  } catch (err) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const [stdout, stderr] = await Promise.all([stdoutTask, stderrTask]);
  return { status, stdout, stderr };
}

describe("cliproxy parity CLI boundaries", () => {
  test("lists the exact approved task inventory matching canonical plan", async () => {
    const result = await invoke(["--list-cases"]);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(38);
    expect(lines[0]).toBe("fixture");
    expect(lines[1]).toBe("proxy");
    expect(lines[2]).toBe("retry");
    expect(lines[3]).toBe("multimodal");
    expect(lines[4]).toBe("options");
    expect(lines[5]).toBe("usage");
    expect(lines[6]).toBe("settings");
    expect(lines[7]).toBe("affinity");
    expect(lines[8]).toBe("responses");
    expect(lines[9]).toBe("cancel");
    expect(lines[10]).toBe("payload");
    expect(lines[11]).toBe("models");
    expect(lines[12]).toBe("hierarchy");
    expect(lines[13]).toBe("quota");
    expect(lines[14]).toBe("meta");
    expect(lines[15]).toBe("xai");
    expect(lines[16]).toBe("kimi");
    expect(lines[17]).toBe("tls");
    expect(lines[18]).toBe("ws");
    expect(lines[19]).toBe("aistudio");
    expect(lines[20]).toBe("realtime");
    expect(lines[21]).toBe("audio-image");
    expect(lines[22]).toBe("video");
    expect(lines[23]).toBe("interactions");
    expect(lines[24]).toBe("compact-search");
    expect(lines[25]).toBe("management-auth");
    expect(lines[26]).toBe("v8-config");
    expect(lines[27]).toBe("management-ops");
    expect(lines[28]).toBe("resp");
    expect(lines[29]).toBe("plugin");
    expect(lines[30]).toBe("plugin-store");
    expect(lines[31]).toBe("home");
    expect(lines[32]).toBe("stores");
    expect(lines[33]).toBe("tui-discovery");
    expect(lines[34]).toBe("bench-core");
    expect(lines[35]).toBe("bench-locality");
    expect(lines[36]).toBe("bench-resilience");
    expect(lines[37]).toBe("desktop-parity");

    const planPath = process.env.MAHOQUOT_CLIPROXY_PLAN ?? "/Volumes/T9-Mac/project/mahoquot/.omo/plans/cliproxy-remediation-plan.md";
    const planText = await Bun.file(planPath).text();
    const planCases = auditInternals.taskCasesFromPlan(planText).map((c) => c.case);
    expect(lines).toEqual(planCases);
  });

  test("strict flag parsing rejects unknown, missing value, and duplicate flags", async () => {
    const unknown = await invoke(["--unknown-flag"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown flag: --unknown-flag");

    const missingVal = await invoke(["--case"]);
    expect(missingVal.status).toBe(1);
    expect(missingVal.stderr).toContain("flag --case requires a value");

    const duplicate = await invoke(["--case", "fixture", "--case", "proxy", "--variant", "happy", "--evidence", "t.json"]);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("duplicate flag: --case");

    const positional = await invoke(["positional_arg"]);
    expect(positional.status).toBe(1);
    expect(positional.stderr).toContain("unexpected positional argument: positional_arg");
  });

  test("unknown registered cases cannot claim success", async () => {
    const result = await invoke(["--case", "retry", "--variant", "happy", "--evidence", "task-3-happy.json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("case module not implemented: cases/retry.mjs");
  });

  test("dispatchCase rejects invalid receipt via awaited validateReceipt", async () => {
    const scratchDir = join(evidenceRoot, "scratch-dispatch-invalid");
    await mkdir(scratchDir, { recursive: true });
    const caseFile = join(scratchDir, "proxy.mjs");
    const evidencePath = join(evidenceRoot, "test-invalid-scratch.json");

    try {
      await writeFile(caseFile, `
export async function runCase(variant, destination, context) {
  return {
    provenance: { build_command: context.buildCommand }
  };
}
`);
      await expect(
        dispatchCase("proxy", "happy", evidencePath, {
          casesDir: scratchDir,
          build: { command: "cargo build -p test" },
        })
      ).rejects.toThrow("wrong receipt schema: proxy/happy");
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
      await rm(evidencePath, { force: true }).catch(() => {});
    }
  });

  test("dispatchCase accepts valid byte-backed receipt with synthetic files and passes awaited validateReceipt", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "parity-dispatch-valid-"));
    const sourceRoot = join(scratchDir, "mahoquot-proxy");
    await mkdir(join(sourceRoot, "crates/gateway/src"), { recursive: true });
    await mkdir(join(scratchDir, "bin"), { recursive: true });
    await mkdir(join(scratchDir, "cases"), { recursive: true });

    const sha256 = (b) => createHash("sha256").update(b).digest("hex");
    const proc = Bun.spawn(["git", "init", "-q"], { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    await output;
    const inputs = [
      "Cargo.toml", "Cargo.lock", "crates/gateway/Cargo.toml", "crates/types/Cargo.toml",
      "crates/registry/Cargo.toml", "crates/router/Cargo.toml", "crates/providers/Cargo.toml",
      "crates/registry/catalog/models-v1.json", "crates/gateway/src/compat/zcode-system-blocks.json",
      "crates/gateway/src/compat/devin.proto", "ui/index.html", ".omo/upstream/route-groups.json",
    ];
    for (const path of inputs) {
      await mkdir(resolve(sourceRoot, path, ".."), { recursive: true });
      await writeFile(join(sourceRoot, path), "synthetic build input\n");
    }
    const sourcePath = "crates/gateway/src/lib.rs";
    const sourceBytes = Buffer.from("pub fn synthetic() {}");
    await writeFile(join(sourceRoot, sourcePath), sourceBytes);
    const { files, sourceHash: treeHash } = await getSourceClosure(sourceRoot);

    const binPath = join(scratchDir, "bin/test-bin");
    const binBytes = Buffer.from("SYNTHETIC-BINARY-FIXTURE");
    const binSha = sha256(binBytes);
    await writeFile(binPath, binBytes);

    const rev = "a".repeat(40);
    const cmd = "cargo build -p test";
    const receiptContent = `${rev}\n${binSha}\n${treeHash}\n${cmd}\n`;
    const receiptPath = join(scratchDir, "source-revision.txt");
    const receiptSha = sha256(Buffer.from(receiptContent));
    await writeFile(receiptPath, receiptContent);

    const validProv = {
      gateway_binary: binPath,
      gateway_sha256: binSha,
      desktop_revision: rev,
      gateway_revision: rev,
      binary_source_revision: rev,
      gateway_source_sha256: treeHash,
      source_root: sourceRoot,
      source_manifest: { files },
      build_command: cmd,
      build_receipt: { path: receiptPath, sha256: receiptSha },
      dirty: false,
    };

    const body = "{}";
    const bodyBase64 = Buffer.from(body).toString("base64");
    const bodySha = sha256(body);

    const caseFile = join(scratchDir, "cases/proxy.mjs");
    const evidencePath = join(scratchDir, "test-valid-out.json");

    try {
      await writeFile(caseFile, `
export async function runCase(variant, destination, context) {
  const receipt = {
    schema: "cliproxy-parity/task1-v1",
    case: "proxy",
    variant,
    created_at: new Date().toISOString(),
    assertions: [
      { id: "reload-applies", expected: true, actual: true, pass: true },
      { id: "direct-bypasses-environment-proxy", expected: true, actual: true, pass: true },
    ],
    required_assertion_ids: ["reload-applies", "direct-bypasses-environment-proxy"],
    events: [
      { id: "event-1", type: "stdout", line: "proxy test" },
      { id: "event-2", type: "exit", code: 0, signal: null },
    ],
    event_order: ["stdout", "exit"],
    wire_capture: {
      gateway_requests: [{ method: "POST", path: "/test", body_bytes_base64: "${bodyBase64}", body_sha256: "${bodySha}" }],
      external_dials: 0,
    },
    provenance: ${JSON.stringify(validProv)},
    teardown: {
      exit: { code: 0, signal: null },
      listeners: 0,
      ownedProcesses: 0,
      listener_inventory: [],
      process_inventory: [],
      termination: "controlled-exit",
    },
  };
  await Bun.write(destination, JSON.stringify(receipt, null, 2) + "\\n");
  return receipt;
}
`);
      const receipt = await dispatchCase("proxy", "happy", evidencePath, {
        casesDir: join(scratchDir, "cases"),
        build: { command: cmd },
      });
      expect(receipt.schema).toBe("cliproxy-parity/task1-v1");
      expect(receipt.case).toBe("proxy");
      expect(receipt.variant).toBe("happy");
      expect(receipt.assertions).toHaveLength(2);
      expect(receipt.assertions.every((a) => a.pass)).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("evidence cannot escape the required root", async () => {
    const result = await invoke([
      "--case", "fixture",
      "--variant", "happy",
      "--evidence", "../escape.json",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("evidence path escapes evidence root");
  });

  test("audit refuses incomplete task receipts", async () => {
    const result = await invoke(["--audit", "F1", "--evidence-root", `${root}/.omo/evidence/cliproxy-remediation/test-run`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must match the approved run evidence path");
  });

  test("source closure collects full workspace build inputs dynamically", async () => {
    expect(getSourceClosure).toBe(auditInternals.getSourceClosure);
    const closure = await getSourceClosure();
    expect(closure.files.length).toBeGreaterThan(150);
    expect(closure.files.some((f) => f.path === "Cargo.lock")).toBe(true);
    expect(closure.files.some((f) => f.path === "Cargo.toml")).toBe(true);
    expect(closure.files.some((f) => f.path === "ui/index.html")).toBe(true);
    expect(closure.files.some((f) => f.path === ".omo/upstream/route-groups.json")).toBe(true);
    expect(closure.files.some((f) => f.path === "crates/gateway/src/main.rs")).toBe(true);
    expect(closure.files.some((f) => f.path === "crates/gateway/src/loopback_guard.rs")).toBe(true);
    expect(closure.files.some((f) => f.path === "crates/gateway/src/proxy_policy.rs")).toBe(true);
    expect(closure.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("receipt construction produces complete valid schema for happy variant", () => {
    const receipt = createReceipt({
      caseName: "fixture",
      variant: "happy",
      assertions: [
        { id: "healthz-200", expected: 200, actual: 200, pass: true },
        { id: "chat-status", expected: 200, actual: 200, pass: true },
        { id: "sentinel", expected: "sentinel-text", actual: "sentinel-text", pass: true },
        { id: "wire-payload-model", expected: "gpt-5.6-sol", actual: "gpt-5.6-sol", pass: true },
        { id: "wire-body-sha256", expected: "64 lowercase hex characters", actual: "a".repeat(64), pass: true },
        { id: "teardown", expected: { controlled: true, listeners: 0, ownedProcesses: 0 }, actual: { controlled: true, listeners: 0, ownedProcesses: 0 }, pass: true },
      ],
      requiredAssertionIds: REQUIRED_ASSERTIONS.happy,
      events: [
        { type: "stdout", line: "ready" },
        { type: "response-data", data: "data: sentinel-text" },
        { type: "exit", code: null, signal: "SIGINT" },
      ],
      wireRequests: [
        { method: "POST", path: "/backend-api/codex/responses", body_bytes_base64: "e30=", body_sha256: "b".repeat(64) },
      ],
      externalDialCount: 0,
      provenance: {
        gateway_binary: "/fake/path/debug/mahoquot-gateway",
        gateway_sha256: "c".repeat(64),
        desktop_revision: "rev1",
        gateway_revision: "rev2",
        gateway_source_sha256: "d".repeat(64),
        source_root: "/fake/path",
        source_manifest: { files: [{ path: "Cargo.lock", sha256: "e".repeat(64) }] },
        build_command: "cargo build",
        binary_source_revision: "rev2",
        dirty: false,
      },
      teardown: {
        exit: { code: null, signal: "SIGINT" },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
        termination: "controlled-signal",
      },
    });

    expect(receipt.schema).toBe("cliproxy-parity/task1-v1");
    expect(receipt.case).toBe("fixture");
    expect(receipt.variant).toBe("happy");
    expect(receipt.wire_capture.external_dials).toBe(0);
    expect(receipt.wire_capture.gateway_requests.length).toBe(1);
    expect(receipt.wire_capture.gateway_requests[0].body_bytes_base64).toBe("e30=");
    expect(receipt.event_order).toEqual(["stdout", "response-data", "exit"]);
    expect(receipt.events.length).toBe(3);
    expect(receipt.events[0].id).toBe("event-1");
    expect(receipt.required_assertion_ids).toEqual(REQUIRED_ASSERTIONS.happy);
    expect(receipt.assertions.map((a) => a.id).sort()).toEqual([...REQUIRED_ASSERTIONS.happy].sort());
    expect(receipt.teardown.listeners).toBe(0);
    expect(receipt.teardown.ownedProcesses).toBe(0);
    expect(receipt.teardown.listener_inventory).toEqual([]);
    expect(receipt.teardown.process_inventory).toEqual([]);
  });

  test("receipt construction produces complete valid schema for failure variant with zero external dials", () => {
    const rejectionEvidence = {
      status: 502,
      mock_redirect: { method: "POST", path: "/backend-api/codex/responses", location: "https://external.invalid/backend-api/codex/responses" },
      guard_decision: { decision: "deny", target: "https://external.invalid/backend-api/codex/responses", reason: "non-literal-loopback redirect target", guard_logged: true, log_excerpt: "outbound loopback guard rejected redirect" },
      body: "{\"error\":{\"message\":\"all failover attempts failed\",\"type\":\"invalid_request_error\"}}"
    };

    const receipt = createReceipt({
      caseName: "fixture",
      variant: "failure",
      assertions: [
        { id: "healthz-200", expected: 200, actual: 200, pass: true },
        { id: "external-url-rejected", expected: rejectionEvidence, actual: rejectionEvidence, pass: true },
        { id: "mock-external-dial-zero", expected: 0, actual: 0, pass: true },
        { id: "teardown", expected: { controlled: true, listeners: 0, ownedProcesses: 0 }, actual: { controlled: true, listeners: 0, ownedProcesses: 0 }, pass: true },
      ],
      requiredAssertionIds: REQUIRED_ASSERTIONS.failure,
      events: [
        { type: "stdout", line: "ready" },
        { type: "exit", code: null, signal: "SIGINT" },
      ],
      wireRequests: [],
      externalDialCount: 0,
      provenance: {
        gateway_binary: "/fake/path/debug/mahoquot-gateway",
        gateway_sha256: "c".repeat(64),
        desktop_revision: "rev1",
        gateway_revision: "rev2",
        gateway_source_sha256: "d".repeat(64),
        source_root: "/fake/path",
        source_manifest: { files: [{ path: "Cargo.lock", sha256: "e".repeat(64) }] },
        build_command: "cargo build",
        binary_source_revision: "rev2",
        dirty: false,
      },
      teardown: {
        exit: { code: null, signal: "SIGINT" },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
        termination: "controlled-signal",
      },
    });

    expect(receipt.schema).toBe("cliproxy-parity/task1-v1");
    expect(receipt.case).toBe("fixture");
    expect(receipt.variant).toBe("failure");
    expect(receipt.wire_capture.external_dials).toBe(0);
    expect(receipt.wire_capture.gateway_requests).toEqual([]);
    expect(receipt.event_order).toEqual(["stdout", "exit"]);
    expect(receipt.required_assertion_ids).toEqual(REQUIRED_ASSERTIONS.failure);
    expect(receipt.assertions.map((a) => a.id).sort()).toEqual([...REQUIRED_ASSERTIONS.failure].sort());
    expect(receipt.teardown.listeners).toBe(0);
    expect(receipt.teardown.ownedProcesses).toBe(0);
  });

  test("Task 2 hung-command and stalled-fixture probe verifies bounded timeout produces non-success and teardown", async () => {
    const { runHungAdversarialProbe } = await import("./helpers/task2-hung-probe.mjs");
    const receipt = await runHungAdversarialProbe();
    expect(receipt.schema).toBe("cliproxy-parity/adversarial-hung-v1");
    expect(receipt.task).toBe("task-2");
    expect(receipt.verdict).toBe("HUNG_COMMAND_ADVERSARIAL_PASS");
    for (const assertion of receipt.assertions) {
      expect(assertion.pass).toBe(true);
    }
    expect(receipt.observed_cleanup.subprocess_reaped).toBe(true);
    expect(receipt.observed_cleanup.stream_cancelled).toBe(true);
    expect(receipt.observed_cleanup.port_unbound).toBe(true);
    expect(receipt.observed_cleanup.active_listeners).toBe(0);
    expect(receipt.observed_cleanup.owned_processes).toBe(0);
  });
});

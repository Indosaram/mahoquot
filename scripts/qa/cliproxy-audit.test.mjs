import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditInternals } from "./cliproxy-audit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const approvedPlan = process.env.MAHOQUOT_APPROVED_PLAN || resolve(ROOT, ".omo/plans/cliproxy-remediation-plan.approved.md");
const livePlan = process.env.MAHOQUOT_CLIPROXY_PLAN || resolve(ROOT, ".omo/plans/cliproxy-remediation-plan.md");

async function syntheticGit(sourceRoot, ...args) {
  const proc = Bun.spawn(["git", ...args], { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const code = await proc.exited;
  const [, error] = await Promise.all([stdout, stderr]);
  expect(code).toBe(0);
  if (code !== 0) throw new Error(error);
}

async function bindSyntheticManifest(provenance, files) {
  provenance.source_manifest.files = files;
  provenance.gateway_source_sha256 = createHash("sha256")
    .update([...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
      .map((file) => `${file.path}\0${file.sha256}`).join("\n")).digest("hex");
  const content = `${provenance.gateway_revision}\n${provenance.gateway_sha256}\n${provenance.gateway_source_sha256}\n${provenance.build_command}\n`;
  await writeFile(provenance.build_receipt.path, content);
  provenance.build_receipt.sha256 = createHash("sha256").update(content).digest("hex");
}

async function createSyntheticSSDEnvironment(dir) {
  const sourceRoot = join(dir, "mahoquot-proxy");
  await mkdir(join(sourceRoot, "crates/gateway/src"), { recursive: true });
  await syntheticGit(sourceRoot, "init", "-q");
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
  const binContent = "#!/bin/sh\necho gateway\n";
  const binSha = createHash("sha256").update(binContent).digest("hex");
  await writeFile(binPath, binContent);

  const sourceRev = "e45abe155cf435f68e6521917828693d66381c5e";
  const buildReceiptPath = join(binDir, "source-revision.txt");
  const { files, sourceHash: treeHash } = await auditInternals.getSourceClosure(sourceRoot);
  const buildCommand = "cargo build -p mahoquot-gateway --bin mahoquot-gateway";
  const buildReceiptContent = `${sourceRev}\n${binSha}\n${treeHash}\n${buildCommand}\n`;
  const buildReceiptSha = createHash("sha256").update(buildReceiptContent).digest("hex");
  await writeFile(buildReceiptPath, buildReceiptContent);

  const provenance = {
    gateway_binary: binPath,
    gateway_sha256: binSha,
    desktop_revision: "92a7dc0b68bf3c13f5e9a1ac7b99dfdaa2f1e2e8",
    gateway_revision: sourceRev,
    gateway_source_sha256: treeHash,
    source_root: sourceRoot,
    source_manifest: { files },
    build_command: buildCommand,
    build_receipt: {
      path: buildReceiptPath,
      sha256: buildReceiptSha,
    },
    binary_source_revision: sourceRev,
    dirty: false,
  };

  return { sourceRoot, binPath, buildReceiptPath, provenance, files, binSha, treeHash, sourceRev };
}

describe("approved task audit plan", () => {
  test("parses the pinned 38-case inventory and exact task evidence paths", async () => {
    const bytes = await readFile(approvedPlan);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(auditInternals.approvedPlanSha256);
    const cases = auditInternals.taskCasesFromPlan(bytes.toString("utf8"));
    expect(cases).toHaveLength(38);
    expect(cases[0]).toEqual({ taskId: 1, case: "fixture", happyPath: "task-1-happy.json", failurePath: "task-1-failure.json" });
    expect(cases[1].happyPath).toBe("task-2-happy.json");
    expect(cases[37].failurePath).toBe("task-38-failure.json");
    for (let i = 0; i < 38; i++) {
      expect(cases[i].taskId).toBe(i + 1);
      expect(cases[i].happyPath).toBe(`task-${i + 1}-happy.json`);
      expect(cases[i].failurePath).toBe(`task-${i + 1}-failure.json`);
    }
  });

  test("regression vuln_plan_checkbox_breaks_parser: parses 38 tasks when checkboxes are completed", async () => {
    const bytes = await readFile(approvedPlan);
    const checkedText = bytes.toString("utf8")
      .replace("- [ ] 1.", "- [x] 1.")
      .replace("- [ ] 2.", "- [X] 2.");
    const cases = auditInternals.taskCasesFromPlan(checkedText);
    expect(cases).toHaveLength(38);
    expect(cases[0].taskId).toBe(1);
    expect(cases[1].taskId).toBe(2);
  });

  test("live execution contract accepts checkbox progress and operational appendices", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const liveText = (await readFile(livePlan)).toString("utf8");
    expect(() => auditInternals.validatePlanContract(liveText, approvedText)).not.toThrow();
  });

  test("live execution contract rejects mutated task acceptance criteria even when 38 cases unchanged", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const mutated = approvedText.replace(
      /Acceptance criteria \(agent-executable\): [^\n]+/,
      "Acceptance criteria (agent-executable): TAMPERED_ACCEPTANCE_CRITERIA"
    );
    expect(auditInternals.taskCasesFromPlan(mutated)).toHaveLength(38);
    expect(() => auditInternals.validatePlanContract(mutated, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects mutated F1 verification wave even when 38 cases unchanged", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const mutated = approvedText.replace(
      "- [ ] F1. Plan compliance audit",
      "- [ ] F1. Tampered plan compliance audit"
    );
    expect(auditInternals.taskCasesFromPlan(mutated)).toHaveLength(38);
    expect(() => auditInternals.validatePlanContract(mutated, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects mutated invariant in scope even when 38 cases unchanged", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const mutated = approvedText.replace(
      "runtime 설정이 다음 요청부터 원자적으로 적용",
      "TAMPERED_INVARIANT_NOT_ATOMIC"
    );
    expect(auditInternals.taskCasesFromPlan(mutated)).toHaveLength(38);
    expect(() => auditInternals.validatePlanContract(mutated, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects mutated suffix section even when 38 cases unchanged", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const mutated = approvedText.replace(
      "No git commits/push in planning or execution without explicit user request.",
      "UNAUTHORIZED COMMITS PERMITTED."
    );
    expect(auditInternals.taskCasesFromPlan(mutated)).toHaveLength(38);
    expect(() => auditInternals.validatePlanContract(mutated, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects renamed recovery marker", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const mutated = approvedText.replace(
      "\n## Commit strategy\n",
      "\n## Recovery checklist\n- [ ] item\n\n## Commit strategy\n"
    );
    expect(() => auditInternals.validatePlanContract(mutated, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects recovery marker misplaced inside numbered tasks", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const mutated = approvedText.replace(
      "- [ ] 2. Atomic proxy reload and direct policy",
      "## Execution recovery checklist\n- [ ] rogue\n\n- [ ] 2. Atomic proxy reload and direct policy"
    );
    expect(() => auditInternals.validatePlanContract(mutated, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects recovery marker misplaced after Commit strategy", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const mutated = approvedText.replace(
      "\n## Success criteria\n",
      "\n## Execution recovery checklist\n- [ ] rogue\n\n## Success criteria\n"
    );
    expect(() => auditInternals.validatePlanContract(mutated, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects preparation recovery without execution recovery checklist", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const mutated = approvedText.replace(
      "\n## Commit strategy\n",
      "\n## Commit strategy\n### Verification preparation recovery\n- [ ] rogue\n\n"
    );
    expect(() => auditInternals.validatePlanContract(mutated, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects duplicate execution recovery checklist", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const validRecovery = approvedText.replace(
      "\n## Commit strategy\n",
      "\n## Execution recovery checklist\n- [ ] item1\n\n## Commit strategy\n### Verification preparation recovery\n- [ ] prep1\n\n"
    );
    const duplicate = validRecovery.replace(
      "\n## Execution recovery checklist\n",
      "\n## Execution recovery checklist\n- [ ] item1\n\n## Execution recovery checklist\n"
    );
    expect(() => auditInternals.validatePlanContract(duplicate, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects duplicate verification preparation recovery", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const validRecovery = approvedText.replace(
      "\n## Commit strategy\n",
      "\n## Execution recovery checklist\n- [ ] item1\n\n## Commit strategy\n### Verification preparation recovery\n- [ ] prep1\n\n"
    );
    const duplicate = validRecovery.replace(
      "### Verification preparation recovery\n",
      "### Verification preparation recovery\n- [ ] p\n\n### Verification preparation recovery\n"
    );
    expect(() => auditInternals.validatePlanContract(duplicate, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects reordered recovery markers", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const reordered = approvedText.replace(
      "\n## Commit strategy\n",
      "\n### Verification preparation recovery\n- [ ] prep1\n\n## Execution recovery checklist\n- [ ] item1\n\n## Commit strategy\n"
    );
    expect(() => auditInternals.validatePlanContract(reordered, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects hidden substantive section inside execution recovery checklist", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const injected = approvedText.replace(
      "\n## Commit strategy\n",
      "\n## Execution recovery checklist\n- [ ] item1\n\n## Injected Substantive Section\nSome mutation\n\n## Commit strategy\n### Verification preparation recovery\n- [ ] prep1\n\n"
    );
    expect(() => auditInternals.validatePlanContract(injected, approvedText)).toThrow("substantive");
  });

  test("live execution contract rejects hidden substantive section inside verification preparation recovery", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const injected = approvedText.replace(
      "\n## Commit strategy\n",
      "\n## Execution recovery checklist\n- [ ] item1\n\n## Commit strategy\n### Verification preparation recovery\n- [ ] prep1\n\n## Injected Substantive Section\n\n"
    );
    expect(() => auditInternals.validatePlanContract(injected, approvedText)).toThrow("substantive");
  });

  test("live execution contract accepts newly discovered recovery checklist item addition", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const withAddition = approvedText.replace(
      "\n## Commit strategy\n",
      "\n## Execution recovery checklist\n" +
      "These discovered repairs preserve the 38 numbered deliverables and F1-F4 acceptance requirements.\n\n" +
      "- [x] Repair corrupted verification worktree import files\n" +
      "- [ ] Repair publication barrier test compilation without weakening assertions\n" +
      "  Actual v12 library test compilation exited 101.\n\n" +
      "## Commit strategy\n" +
      "### Verification preparation recovery\n" +
      "- [ ] Repair mutable plan digest audit binding\n\n"
    );
    expect(() => auditInternals.validatePlanContract(withAddition, approvedText)).not.toThrow();
  });

  for (const block of ["execution", "preparation"]) {
    test(`recovery ${block} rejects hidden contract declarations and non-operational records`, async () => {
      const approvedText = (await readFile(approvedPlan)).toString("utf8");
      const forbidden = [
        "- [ ] 1. Replacement task", "- [x] 38. Replacement task",
        "- [ ] F1. Replacement audit", "- [X] F4. Replacement fidelity",
        "  2. Replacement task", "  - [ ] F2. Replacement audit",
        "  Acceptance criteria: skip checks", "  Acceptance criteria (agent-executable): skip checks",
        "  QA scenarios: skip failure", "  Recommended executor category: quick",
        "# Hidden heading", "### Hidden heading", "###### Hidden heading",
        "  ## Hidden heading", "  # Hidden heading", "  ### Hidden heading",
        "  <h2>Hidden heading</h2>", "  ===", "  ---",
        "  Commit without approval.", "  Push is now permitted.", "  Deployment is authorized.",
        "- [ ] Authorize commits", "- [ ] Enable pushing", "- [ ] Deploy release",
        "Unindented hidden prose", "    Over-indented hidden prose",
      ];
      for (const line of forbidden) {
        const execution = "- [ ] Repair import\n  Preserve source hashes.\n" + (block === "execution" ? `${line}\n` : "");
        const preparation = "- [ ] Repair audit binding\n  Preserve provenance.\n" + (block === "preparation" ? `${line}\n` : "");
        const mutated = approvedText.replace(
          "\n## Commit strategy\n",
          `\n## Execution recovery checklist\n${execution}\n## Commit strategy\n### Verification preparation recovery\n${preparation}\n`
        );
        expect(mutated).not.toBe(approvedText);
        expect(() => auditInternals.validatePlanContract(mutated, approvedText)).toThrow("substantive");
      }
    });
  }

  test("current operational descriptions preserve Task2 references and publication commit state", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const operational = approvedText.replace(
      "\n## Commit strategy\n",
      "\n## Execution recovery checklist\n" +
      "These discovered repairs preserve the 38 numbered deliverables and F1-F4 acceptance requirements. A repair checkbox does not substitute for its numbered task's DoneClaim, independent verification, or runtime evidence.\n\n" +
      "- [ ] Correct proxy consumer silent direct fallback\n" +
      "  Task2 state convenience wrappers fall back to direct on client construction errors; quota and warmup have actual callers.\n" +
      "- [ ] Repair catalog publication barrier and QA containment\n" +
      "  Existing Task12 owner corrects the newly introduced publication test: readers during commit must observe the old coherent pair, after publication the new coherent pair.\n\n" +
      "## Commit strategy\n### Verification preparation recovery\n" +
      "- [ ] Repair mutable plan digest audit binding\n" +
      "  Preserve fail-closed source and binary provenance.\n\n"
    );
    expect(() => auditInternals.validatePlanContract(operational, approvedText)).not.toThrow();
    expect(auditInternals.stripOperationalAppendices(approvedText)).toBe(approvedText);
    expect(auditInternals.normalizeCheckboxes(auditInternals.stripOperationalAppendices(operational)))
      .toBe(auditInternals.normalizeCheckboxes(approvedText));
  });

  test("taskCasesFromPlan parses 38 cases from live text with completed tasks", async () => {
    const approvedText = (await readFile(approvedPlan)).toString("utf8");
    const liveWithCompleted = approvedText.replace("- [ ] 1. Loopback parity QA harness", "- [x] 1. Loopback parity QA harness");
    const cases = auditInternals.taskCasesFromPlan(liveWithCompleted);
    expect(cases).toHaveLength(38);
    expect(cases[0].taskId).toBe(1);
  });
});

describe("receipt assertion operators", () => {
  test("requires semantic sentinel and byte-backed wire hash values", () => {
    const receipt = {
      case: "fixture", variant: "happy", assertions: [
        { id: "healthz-200", expected: 200, actual: 200, pass: true },
        { id: "chat-status", expected: 200, actual: 200, pass: true },
        { id: "sentinel", expected: "unique-sentinel", actual: true, pass: true },
        { id: "wire-payload-model", expected: "gpt-5.4", actual: "gpt-5.4", pass: true },
        { id: "wire-body-sha256", expected: "64 lowercase hex characters", actual: "a".repeat(64), pass: true },
        { id: "teardown", expected: "clean", actual: "clean", pass: true },
      ],
    };
    expect(() => auditInternals.validateAssertionSet(receipt, "synthetic test only")).not.toThrow();
  });

  test("rejects omitted assertion from required set", () => {
    const receipt = {
      case: "fixture", variant: "happy", assertions: [
        { id: "healthz-200", expected: 200, actual: 200, pass: true },
        { id: "chat-status", expected: 200, actual: 200, pass: true },
        { id: "sentinel", expected: "unique-sentinel", actual: true, pass: true },
        { id: "wire-payload-model", expected: "gpt-5.4", actual: "gpt-5.4", pass: true },
        { id: "teardown", expected: "clean", actual: "clean", pass: true },
      ],
    };
    expect(() => auditInternals.validateAssertionSet(receipt, "synthetic test only")).toThrow("wrong exact required assertion IDs");
  });

  test("rejects pass:true with wrong actual status (semantic verification)", () => {
    const receipt = {
      case: "fixture", variant: "happy", assertions: [
        { id: "healthz-200", expected: 200, actual: 500, pass: true },
        { id: "chat-status", expected: 200, actual: 200, pass: true },
        { id: "sentinel", expected: "unique-sentinel", actual: true, pass: true },
        { id: "wire-payload-model", expected: "gpt-5.4", actual: "gpt-5.4", pass: true },
        { id: "wire-body-sha256", expected: "64 lowercase hex characters", actual: "a".repeat(64), pass: true },
        { id: "teardown", expected: "clean", actual: "clean", pass: true },
      ],
    };
    expect(() => auditInternals.validateAssertionSet(receipt, "synthetic test only")).toThrow("HTTP status assertion mismatch");
  });

  test("rejects unknown variant", () => {
    const receipt = {
      case: "fixture", variant: "unknown-variant", assertions: [
        { id: "healthz-200", expected: 200, actual: 200, pass: true },
      ],
    };
    expect(() => auditInternals.validateAssertionSet(receipt, "synthetic test only")).toThrow("no derived assertion contract");
  });

  test("rejects self-declared pass when required ID missing from audit contract", () => {
    const receipt = {
      case: "fixture", variant: "happy",
      required_assertion_ids: ["healthz-200", "chat-status"],
      assertions: [
        { id: "healthz-200", expected: 200, actual: 200, pass: true },
        { id: "chat-status", expected: 200, actual: 200, pass: true },
      ],
    };
    expect(() => auditInternals.validateAssertionSet(receipt, "synthetic test only")).toThrow("declared required assertion IDs differ from audit contract");
  });

  test("rejects nonfixture case with missing assertions against validator contract", () => {
    const receipt = {
      case: "proxy", variant: "happy",
      required_assertion_ids: ["reload-applies"],
      assertions: [
        { id: "reload-applies", expected: true, actual: true, pass: true },
      ],
    };
    expect(() => auditInternals.validateAssertionSet(receipt, "synthetic test only")).toThrow("declared required assertion IDs differ from audit contract");
  });
});

describe("provenance verification with real SSD files", () => {
  test("accepts valid matching provenance with real files on disk", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-test-"));
    try {
      const { provenance } = await createSyntheticSSDEnvironment(tmp);
      await expect(auditInternals.validateProvenance(provenance, "ssd-test")).resolves.toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("regression vuln_test_only_bypasses_disk: rejects missing disk files even with test_only: true", async () => {
    const provenance = {
      gateway_binary: "/nonexistent/binary",
      gateway_sha256: "a".repeat(64),
      gateway_revision: "rev1",
      desktop_revision: "rev2",
      dirty: false,
      gateway_source_sha256: "b".repeat(64),
      build_command: "cargo build",
      binary_source_revision: "rev1",
      source_manifest: {
        files: [{ path: "Cargo.lock", sha256: "c".repeat(64) }],
      },
      test_only: true,
    };
    await expect(auditInternals.validateProvenance(provenance, "testonly")).rejects.toThrow();
  });

  test("regression vuln_enoent_silently_swallowed: absent source file is fatal", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-enoent-"));
    try {
      const { provenance, sourceRoot } = await createSyntheticSSDEnvironment(tmp);
      await rm(join(sourceRoot, "Cargo.lock"));
      await expect(auditInternals.validateProvenance(provenance, "enoent-test")).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("regression vuln_enoent_silently_swallowed: absent binary is fatal", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-bin-"));
    try {
      const { provenance, binPath } = await createSyntheticSSDEnvironment(tmp);
      await rm(binPath);
      await expect(auditInternals.validateProvenance(provenance, "bin-test")).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("regression vuln_build_receipt_optional_shape_only: missing build_receipt is fatal", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-nobuild-"));
    try {
      const { provenance } = await createSyntheticSSDEnvironment(tmp);
      delete provenance.build_receipt;
      await expect(auditInternals.validateProvenance(provenance, "nobuild-test")).rejects.toThrow("missing mandatory build_receipt");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("regression vuln_build_receipt_optional_shape_only: build_receipt hash mismatch is fatal", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-badhash-"));
    try {
      const { provenance } = await createSyntheticSSDEnvironment(tmp);
      provenance.build_receipt.sha256 = "0".repeat(64);
      await expect(auditInternals.validateProvenance(provenance, "badhash-test")).rejects.toThrow("build receipt hash mismatch");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("regression vuln_build_receipt_optional_shape_only: build_receipt content revision mismatch is fatal", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-revmismatch-"));
    try {
      const { provenance, buildReceiptPath, binSha, treeHash } = await createSyntheticSSDEnvironment(tmp);
      const wrongContent = `wrongrevision\n${binSha}\n${treeHash}\n${provenance.build_command}\n`;
      await writeFile(buildReceiptPath, wrongContent);
      provenance.build_receipt.sha256 = createHash("sha256").update(wrongContent).digest("hex");
      await expect(auditInternals.validateProvenance(provenance, "revmismatch-test")).rejects.toThrow("build receipt source revision mismatch");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("complete source closure provenance", () => {
  test("rejects truncated self-consistent manifest and four-line binding", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-truncated-"));
    try {
      const { provenance } = await createSyntheticSSDEnvironment(tmp);
      await bindSyntheticManifest(provenance, provenance.source_manifest.files.filter((file) => file.path === "Cargo.lock"));
      await expect(auditInternals.validateProvenance(provenance, "truncated")).rejects.toThrow("source manifest file count mismatch");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects duplicate, absolute, traversal and noncanonical paths", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-paths-"));
    try {
      const { provenance, files } = await createSyntheticSSDEnvironment(tmp);
      await bindSyntheticManifest(provenance, [...files, { ...files[0] }]);
      await expect(auditInternals.validateProvenance(provenance, "duplicate")).rejects.toThrow("duplicate manifest path");
      for (const path of ["/Cargo.lock", "../Cargo.lock", "crates/../Cargo.lock", "./Cargo.lock", "crates//main.rs", "C:\\Cargo.lock"]) {
        await bindSyntheticManifest(provenance, [{ ...files[0], path }, ...files.slice(1)]);
        await expect(auditInternals.validateProvenance(provenance, path)).rejects.toThrow("canonical relative");
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects same-count self-consistent extraneous path replacing required input", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-extraneous-"));
    try {
      const { provenance, sourceRoot, files } = await createSyntheticSSDEnvironment(tmp);
      await writeFile(join(sourceRoot, "README.md"), "not a build input\n");
      const hash = createHash("sha256").update(await readFile(join(sourceRoot, "README.md"))).digest("hex");
      await bindSyntheticManifest(provenance, [{ path: "README.md", sha256: hash }, ...files.slice(1)]);
      await expect(auditInternals.validateProvenance(provenance, "extraneous")).rejects.toThrow("source manifest path set mismatch");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects changed listed source and deleted tracked optional or required input", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-disk-"));
    try {
      const { provenance, sourceRoot } = await createSyntheticSSDEnvironment(tmp);
      const main = join(sourceRoot, "crates/gateway/src/main.rs");
      await writeFile(main, "fn main() { panic!(); }\n");
      await expect(auditInternals.validateProvenance(provenance, "changed")).rejects.toThrow("does not match manifest");
      await writeFile(main, "fn main() {}\n");
      await writeFile(join(sourceRoot, "build.rs"), "fn main() {}\n");
      await syntheticGit(sourceRoot, "add", "build.rs");
      await rm(join(sourceRoot, "build.rs"));
      await expect(auditInternals.getSourceClosure(sourceRoot)).rejects.toThrow("ENOENT");
      await syntheticGit(sourceRoot, "rm", "--cached", "build.rs");
      await rm(join(sourceRoot, "ui/index.html"));
      await expect(auditInternals.getSourceClosure(sourceRoot)).rejects.toThrow("ENOENT");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects changed embedded assets and newly added crate asset", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-assets-"));
    try {
      const { provenance, sourceRoot } = await createSyntheticSSDEnvironment(tmp);
      for (const path of ["ui/index.html", ".omo/upstream/route-groups.json"]) {
        const original = await readFile(join(sourceRoot, path));
        await writeFile(join(sourceRoot, path), Buffer.concat([original, Buffer.from("changed\n")]));
        await expect(auditInternals.validateProvenance(provenance, path)).rejects.toThrow("does not match manifest");
        await writeFile(join(sourceRoot, path), original);
      }
      await writeFile(join(sourceRoot, "crates/gateway/src/extra.json"), "{}\n");
      await expect(auditInternals.validateProvenance(provenance, "asset addition")).rejects.toThrow("source manifest file count mismatch");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("accepts complete closure with optional configs, NUL paths, dedup and raw bytes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-complete-"));
    try {
      const { provenance, sourceRoot } = await createSyntheticSSDEnvironment(tmp);
      const additions = ["rust-toolchain.toml", "build.rs", ".cargo/config.toml", "crates/gateway/src/space newline\nasset.json"];
      const bytes = Buffer.from([0, 255, 13, 10]);
      for (const path of additions) {
        await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
        await writeFile(join(sourceRoot, path), bytes);
      }
      await syntheticGit(sourceRoot, "add", "Cargo.lock");
      const closure = await auditInternals.getSourceClosure(sourceRoot);
      expect(closure.files.filter((file) => file.path === "Cargo.lock")).toHaveLength(1);
      for (const path of additions) {
        expect(closure.files.find((file) => file.path === path)?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
      expect(closure.files.map((file) => file.path)).toEqual([...closure.files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map((file) => file.path));
      await bindSyntheticManifest(provenance, closure.files);
      await expect(auditInternals.validateProvenance(provenance, "complete")).resolves.toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects source hash, command and line-count binding mismatches", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "prov-binding-"));
    try {
      const { provenance, buildReceiptPath } = await createSyntheticSSDEnvironment(tmp);
      const original = await readFile(buildReceiptPath, "utf8");
      const cases = [
        [original.replace(provenance.gateway_source_sha256, "0".repeat(64)), "build receipt source hash mismatch"],
        [original.replace(provenance.build_command, "cargo build -p other"), "build receipt command mismatch"],
        [original + "extra\n", "exactly 4 lines"],
        [original.split("\n").slice(0, 2).join("\n") + "\n", "exactly 4 lines"],
      ];
      for (const [content, error] of cases) {
        await writeFile(buildReceiptPath, content);
        provenance.build_receipt.sha256 = createHash("sha256").update(content).digest("hex");
        await expect(auditInternals.validateProvenance(provenance, error)).rejects.toThrow(error);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("validateWire sentinel verification", () => {
  test("regression vuln_sentinel_wire_includes_fallback: rejects sentinel in log line only", async () => {
    const receipt = {
      case: "fixture",
      variant: "happy",
      assertions: [{ id: "sentinel", expected: "target-sentinel", actual: true, pass: true }],
      events: [{ id: "e1", type: "stdout", line: "target-sentinel in stdout log" }],
      wire_capture: {
        gateway_requests: [{
          method: "POST",
          path: "/v1/chat/completions",
          body_bytes_base64: Buffer.from("dummy").toString("base64"),
          body_sha256: createHash("sha256").update("dummy").digest("hex"),
        }],
      },
    };
    await expect(auditInternals.validateWire(receipt, "sentinel-log-test")).rejects.toThrow("sentinel assertion is not backed by captured response-data bytes");
  });

  test("regression vuln_sentinel_wire_includes_fallback: rejects sentinel in request body only", async () => {
    const reqBody = JSON.stringify({ prompt: "target-sentinel" });
    const receipt = {
      case: "fixture",
      variant: "happy",
      assertions: [{ id: "sentinel", expected: "target-sentinel", actual: true, pass: true }],
      events: [{ id: "e1", type: "stdout", line: "unrelated log" }],
      wire_capture: {
        gateway_requests: [{
          method: "POST",
          path: "/v1/chat/completions",
          body_bytes_base64: Buffer.from(reqBody).toString("base64"),
          body_sha256: createHash("sha256").update(reqBody).digest("hex"),
        }],
      },
    };
    await expect(auditInternals.validateWire(receipt, "sentinel-echo-test")).rejects.toThrow("sentinel assertion is not backed by captured response-data bytes");
  });

  test("accepts sentinel in actual response-data event", async () => {
    const reqBody = JSON.stringify({ prompt: "prompt" });
    const receipt = {
      case: "fixture",
      variant: "happy",
      assertions: [{ id: "sentinel", expected: "target-sentinel", actual: true, pass: true }],
      events: [
        { id: "e1", type: "response-data", data: 'data: {"delta":"target-sentinel"}' },
      ],
      wire_capture: {
        gateway_requests: [{
          method: "POST",
          path: "/v1/chat/completions",
          body_bytes_base64: Buffer.from(reqBody).toString("base64"),
          body_sha256: createHash("sha256").update(reqBody).digest("hex"),
        }],
      },
    };
    await expect(auditInternals.validateWire(receipt, "sentinel-valid-test")).resolves.toBeUndefined();
  });
});

describe("teardown verification", () => {
  test("accepts clean exit code 0 with zero listeners and processes", () => {
    const receipt = {
      teardown: {
        exit: { code: 0, signal: null },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
      },
    };
    expect(() => auditInternals.validateTeardown(receipt, "testonly")).not.toThrow();
  });

  test("accepts controlled SIGINT with intentional termination receipt and zero resources", () => {
    const receipt = {
      teardown: {
        exit: { code: null, signal: "SIGINT" },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
        termination: "controlled-signal",
      },
    };
    expect(() => auditInternals.validateTeardown(receipt, "testonly")).not.toThrow();
  });

  test("rejects unexpected crash signal (e.g. SIGSEGV)", () => {
    const receipt = {
      teardown: {
        exit: { code: null, signal: "SIGSEGV" },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
      },
    };
    expect(() => auditInternals.validateTeardown(receipt, "testonly")).toThrow("process terminated by unexpected signal SIGSEGV");
  });

  test("rejects SIGINT without recorded intentional termination", () => {
    const receipt = {
      teardown: {
        exit: { code: null, signal: "SIGINT" },
        listeners: 0,
        ownedProcesses: 0,
        listener_inventory: [],
        process_inventory: [],
      },
    };
    expect(() => auditInternals.validateTeardown(receipt, "testonly")).toThrow("without recorded intentional termination");
  });

  test("rejects teardown with remaining listeners or owned processes", () => {
    const receipt = {
      teardown: {
        exit: { code: 0, signal: null },
        listeners: 1,
        ownedProcesses: 0,
        listener_inventory: [{ port: 18840 }],
        process_inventory: [],
      },
    };
    expect(() => auditInternals.validateTeardown(receipt, "testonly")).toThrow("resources remain after teardown");
  });
});

describe("inventory verification", () => {
  test("regression vuln_inventory_required_ids_bypass: required_ids: [] cannot bypass mandatory coverage", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "inv-bypass-"));
    try {
      const inv = {
        kind: "route",
        source_revision: "rev1",
        source_sha256: "a".repeat(64),
        required_ids: [], // tries to bypass mandatory coverage
        entries: [
          { id: "custom-route", source_path: "src/routes.rs", observed: true, pass: true },
        ],
      };
      await writeFile(join(tmp, "route-inventory.json"), JSON.stringify(inv));
      await expect(auditInternals.validateInventory(tmp, "route")).rejects.toThrow("missing mandatory route inventory entry");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects inventory missing required entry even when nonempty", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "inv-test-"));
    try {
      const inv = {
        kind: "route",
        source_revision: "rev1",
        source_sha256: "a".repeat(64),
        entries: [
          { id: "custom-route", source_path: "src/routes.rs", observed: true, pass: true },
        ],
      };
      await writeFile(join(tmp, "route-inventory.json"), JSON.stringify(inv));
      await expect(auditInternals.validateInventory(tmp, "route")).rejects.toThrow("missing mandatory route inventory entry");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("F3 behavior verification", () => {
  test("rejects F3 missing required channels even when nonempty", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "f3-test-"));
    try {
      const artifactBytes = Buffer.from(JSON.stringify({ kind: "wire-peer", trigger: "req", observed_event: "resp", outcome: "observed" }));
      const artifactSha = createHash("sha256").update(artifactBytes).digest("hex");
      await writeFile(join(tmp, "artifact.json"), artifactBytes);

      const f3 = {
        behaviors: [
          { id: "b1", kind: "wire-peer", trigger: "req", observed_event: "resp", artifact: "artifact.json", artifact_sha256: artifactSha },
        ],
      };
      await writeFile(join(tmp, "F3-behavior.json"), JSON.stringify(f3));
      await expect(auditInternals.validateF3(tmp)).rejects.toThrow("F3 missing required behavior channel");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects F3 screenshot-only artifact", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "f3-test-"));
    try {
      const f3 = {
        behaviors: [
          { id: "b1", kind: "app-interaction", trigger: "req", observed_event: "resp", artifact: "screen.png", artifact_sha256: "a".repeat(64) },
        ],
      };
      await writeFile(join(tmp, "F3-behavior.json"), JSON.stringify(f3));
      await expect(auditInternals.validateF3(tmp)).rejects.toThrow("F3 screenshot cannot serve as behavioral capture");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("F4 fidelity verification", () => {
  test("rejects F4 with unpaired benchmark sample counts", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "f4-test-"));
    try {
      const metricSet = { ttfb_ms: 10, content_ttft_ms: 12, completion_ms: 100, errors: 0, rss_bytes: 1000, fd_count: 5 };
      const f4 = {
        provenance: {},
        is_rows: Object.fromEntries(
          ["IS-1", "IS-2", "IS-3", "IS-4", "IS-5", "IS-6", "IS-7"].map(id => [id, { pass: true, evidence: [{ path: "ev.txt", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", pass: true }] }])
        ),
        benchmarks: Object.fromEntries(
          Array.from({ length: 14 }, (_, i) => `B${i}`).map(id => [
            id,
            {
              baseline: { samples: 10, ...metricSet },
              candidate: { samples: id === "B0" ? 8 : 10, ...metricSet },
              seed: 12345,
              config_sha256: "a".repeat(64),
            },
          ])
        ),
      };
      await writeFile(join(tmp, "ev.txt"), "");
      await writeFile(join(tmp, "F4-fidelity.json"), JSON.stringify(f4));
      await expect(auditInternals.validateF4(tmp)).rejects.toThrow("sample count mismatch between baseline");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects F4 with corrupt metric type", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "f4-test-"));
    try {
      const metricSet = { ttfb_ms: "invalid_not_number", content_ttft_ms: 12, completion_ms: 100, errors: 0, rss_bytes: 1000, fd_count: 5 };
      const f4 = {
        provenance: {},
        is_rows: Object.fromEntries(
          ["IS-1", "IS-2", "IS-3", "IS-4", "IS-5", "IS-6", "IS-7"].map(id => [id, { pass: true, evidence: [{ path: "ev.txt", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", pass: true }] }])
        ),
        benchmarks: Object.fromEntries(
          Array.from({ length: 14 }, (_, i) => `B${i}`).map(id => [
            id,
            {
              baseline: { samples: 10, ...metricSet },
              candidate: { samples: 10, ...metricSet },
              seed: 12345,
              config_sha256: "a".repeat(64),
            },
          ])
        ),
      };
      await writeFile(join(tmp, "ev.txt"), "");
      await writeFile(join(tmp, "F4-fidelity.json"), JSON.stringify(f4));
      await expect(auditInternals.validateF4(tmp)).rejects.toThrow("invalid metric ttfb_ms");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects F4 with failing IS row", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "f4-test-"));
    try {
      const metricSet = { ttfb_ms: 10, content_ttft_ms: 12, completion_ms: 100, errors: 0, rss_bytes: 1000, fd_count: 5 };
      const f4 = {
        provenance: {},
        is_rows: Object.fromEntries(
          ["IS-1", "IS-2", "IS-3", "IS-4", "IS-5", "IS-6", "IS-7"].map(id => [
            id,
            { pass: id !== "IS-1", evidence: [{ path: "ev.txt", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", pass: true }] },
          ])
        ),
        benchmarks: Object.fromEntries(
          Array.from({ length: 14 }, (_, i) => `B${i}`).map(id => [
            id,
            {
              baseline: { samples: 10, ...metricSet },
              candidate: { samples: 10, ...metricSet },
              seed: 12345,
              config_sha256: "a".repeat(64),
            },
          ])
        ),
      };
      await writeFile(join(tmp, "ev.txt"), "");
      await writeFile(join(tmp, "F4-fidelity.json"), JSON.stringify(f4));
      await expect(auditInternals.validateF4(tmp)).rejects.toThrow("F4 row IS-1 pass is not true");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("negative receipt testing suite with real SSD files", () => {
  test("generates and verifies 5 rejected mutations from task-1 receipt", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "neg-test-"));
    try {
      const { provenance, binSha } = await createSyntheticSSDEnvironment(tmp);
      const reqBody = JSON.stringify({ model: "gpt-5.4" });
      const reqSha = createHash("sha256").update(reqBody).digest("hex");
      const dummyHappy = {
        schema: "cliproxy-parity/task1-v1",
        case: "fixture",
        variant: "happy",
        created_at: new Date().toISOString(),
        required_assertion_ids: ["healthz-200", "chat-status", "sentinel", "wire-payload-model", "wire-body-sha256", "teardown"],
        assertions: [
          { id: "healthz-200", expected: 200, actual: 200, pass: true },
          { id: "chat-status", expected: 200, actual: 200, pass: true },
          { id: "sentinel", expected: "unique-sentinel", actual: true, pass: true },
          { id: "wire-payload-model", expected: "gpt-5.4", actual: "gpt-5.4", pass: true },
          { id: "wire-body-sha256", expected: "64 lowercase hex characters", actual: reqSha, pass: true },
          { id: "teardown", expected: "clean", actual: "clean", pass: true },
        ],
        events: [
          { id: "event-1", type: "response-data", data: 'data: {"delta":"unique-sentinel"}' },
        ],
        event_order: ["response-data"],
        wire_capture: {
          gateway_requests: [{
            method: "POST",
            path: "/v1/chat/completions",
            body_bytes_base64: Buffer.from(reqBody).toString("base64"),
            body_sha256: reqSha,
          }],
        },
        provenance,
        teardown: {
          exit: { code: 0, signal: null },
          listeners: 0,
          ownedProcesses: 0,
          listener_inventory: [],
          process_inventory: [],
        },
      };

      await writeFile(join(tmp, "task-1-happy.json"), JSON.stringify(dummyHappy, null, 2));
      const cases = [{ taskId: 1, case: "fixture", happyPath: "task-1-happy.json", failurePath: "task-1-failure.json" }];
      const result = await auditInternals.negativeReceiptTest(tmp, cases);
      expect(result.copies).toBe(5);
      expect(result.rejected).toEqual([
        "omitted-assertion",
        "pass-true-wrong-actual",
        "unknown-variant",
        "stale-source-binary",
        "missing-teardown"
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("runGate process-group lifecycle and signal teardown", () => {
  const root = "/Volumes/T9-Mac/project/mahoquot-wt/cliproxy-remediation-w1";

  const awaitProcessDead = async (pid, timeoutMs = 2000) => {
    if (!pid) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") return true;
      }
      await new Promise((r) => setImmediate(r));
    }
    return false;
  };

  test("tears down detached process group on timeout deadline without leaking descendants", async () => {
    let subPid = null;
    let stdoutBuffer = "";
    const controller = new AbortController();
    const mockScript = `
      import { spawn } from "node:child_process";
      const sub = spawn("sh", ["-c", "echo READY:\$\$; while true; do sleep 1; done"]);
      sub.stdout.on("data", (c) => process.stdout.write(c));
    `;

    let resolveReady, rejectReady;
    const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    const readyTimer = setTimeout(() => rejectReady(new Error("Timeout waiting for mock ready")), 5000);

    let resultPromise;
    try {
      resultPromise = auditInternals.runGate(
        ["bun", "-e", mockScript],
        root,
        30000,
        {
          signal: controller.signal,
          onStdout: (chunk) => {
            stdoutBuffer += chunk.toString();
            const match = stdoutBuffer.match(/READY:(\d+)\n/);
            if (match) {
              subPid = Number(match[1]);
              clearTimeout(readyTimer);
              resolveReady(subPid);
            }
          },
        }
      );

      await readyPromise;
      expect(subPid).not.toBeNull();

      controller.abort("TIMEOUT");

      const result = await resultPromise;
      expect(result.signal).toBe("TIMEOUT");
      expect(result.code).toBeNull();

      const dead = await awaitProcessDead(subPid);
      expect(dead).toBe(true);
    } finally {
      if (subPid) {
        try { process.kill(subPid, "SIGKILL"); } catch {}
        await awaitProcessDead(subPid);
      }
    }
  });

  test("a direct child closing must not cancel cleanup of TERM-ignoring descendants", async () => {
    let subPid = null;
    let stdoutBuffer = "";
    const controller = new AbortController();
    const mockScript = `
      import { spawn } from "node:child_process";
      const descendant = spawn("sh", ["-c", "trap '' TERM; echo READY:\$\$; while true; do sleep 1; done"]);
      descendant.stdout.on("data", (c) => process.stdout.write(c));
      process.on("SIGTERM", () => {
        process.exit(0);
      });
    `;

    let resolveReady, rejectReady;
    const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    const readyTimer = setTimeout(() => rejectReady(new Error("Timeout waiting for mock ready")), 5000);

    let resultPromise;
    try {
      resultPromise = auditInternals.runGate(
        ["bun", "-e", mockScript],
        root,
        30000,
        {
          signal: controller.signal,
          onStdout: (chunk) => {
            stdoutBuffer += chunk.toString();
            const match = stdoutBuffer.match(/READY:(\d+)\n/);
            if (match) {
              subPid = Number(match[1]);
              clearTimeout(readyTimer);
              resolveReady(subPid);
            }
          },
        }
      );

      await readyPromise;
      expect(subPid).not.toBeNull();

      controller.abort("TIMEOUT");

      const result = await resultPromise;
      expect(result.signal).toBe("TIMEOUT");
      expect(result.code).toBeNull();

      const dead = await awaitProcessDead(subPid);
      expect(dead).toBe(true);
    } finally {
      if (subPid) {
        try { process.kill(subPid, "SIGKILL"); } catch {}
        await awaitProcessDead(subPid);
      }
    }
  });

  test("repeated SIGINT/SIGTERM must never turn interruption into success", async () => {
    let parent = null;
    let subPid = null;
    let exitCode = null;
    let stdoutBuffer = "";

    const parentScript = `
      import { auditInternals } from "./scripts/qa/cliproxy-audit.mjs";
      try {
        await auditInternals.runGate(
          ["sh", "-c", "trap 'exit 0' TERM INT; echo READY:\$\$; while true; do sleep 1; done"],
          "${root}",
          30000,
          {
            onStdout: (chunk) => process.stdout.write(chunk),
          }
        );
      } catch (e) {
        process.exit(1);
      }
    `;

    try {
      parent = spawn("bun", ["-e", parentScript], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const parentClosePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for parent close")), 5000);
        parent.once("close", (code) => {
          clearTimeout(timer);
          exitCode = code;
          resolve(code);
        });
      });

      let resolveReady, rejectReady;
      const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
      const readyTimer = setTimeout(() => rejectReady(new Error("Timeout waiting for parent READY")), 5000);

      parent.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const match = stdoutBuffer.match(/READY:(\d+)\n/);
        if (match) {
          subPid = Number(match[1]);
          clearTimeout(readyTimer);
          resolveReady(subPid);
        }
      });

      await readyPromise;
      expect(subPid).not.toBeNull();

      parent.kill("SIGINT");
      parent.kill("SIGTERM");
      parent.kill("SIGINT");

      await parentClosePromise;
      expect(exitCode).not.toBe(0);

      const dead = await awaitProcessDead(subPid);
      expect(dead).toBe(true);
    } finally {
      if (subPid) {
        try { process.kill(subPid, "SIGKILL"); } catch {}
        await awaitProcessDead(subPid);
      }
      if (parent?.pid) {
        try { process.kill(parent.pid, "SIGKILL"); } catch {}
        await awaitProcessDead(parent.pid);
      }
    }
  });

  test("rejects when command exits code 0 but leaks a live detached descendant", async () => {
    let subPid = null;
    let stdoutBuffer = "";
    const mockScript = `
      import { spawn } from "node:child_process";
      const sub = spawn("sh", ["-c", "echo READY:\$\$; while true; do sleep 1; done"]);
      sub.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        process.exit(0);
      });
    `;

    let resolveReady, rejectReady;
    const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    const readyTimer = setTimeout(() => rejectReady(new Error("Timeout waiting for mock ready")), 5000);

    let gatePromise;
    try {
      gatePromise = auditInternals.runGate(
        ["bun", "-e", mockScript],
        root,
        30000,
        {
          onStdout: (chunk) => {
            stdoutBuffer += chunk.toString();
            const match = stdoutBuffer.match(/READY:(\d+)\n/);
            if (match) {
              subPid = Number(match[1]);
              clearTimeout(readyTimer);
              resolveReady(subPid);
            }
          },
        }
      );

      await readyPromise;
      expect(subPid).not.toBeNull();

      let threw = false;
      try {
        await gatePromise;
      } catch (e) {
        if (e.message.includes("leaked live detached process group")) threw = true;
      }
      expect(threw).toBe(true);

      const dead = await awaitProcessDead(subPid);
      expect(dead).toBe(true);
    } finally {
      if (subPid) {
        try { process.kill(subPid, "SIGKILL"); } catch {}
        await awaitProcessDead(subPid);
      }
    }
  });

  test("tears down detached process group on CLI interruption (SIGINT exit 130) without orphaning descendants", async () => {
    let subPid = null;
    let parent = null;
    let exitCode = null;
    let stdoutBuffer = "";

    const parentScript = `
      import { auditInternals } from "./scripts/qa/cliproxy-audit.mjs";
      await auditInternals.runGate(
        ["sh", "-c", "trap '' TERM; echo READY:\$\$; while true; do sleep 1; done"],
        "${root}",
        30000,
        {
          onStdout: (chunk) => process.stdout.write(chunk),
        }
      );
    `;

    try {
      parent = spawn("bun", ["-e", parentScript], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const parentClosePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for parent close")), 5000);
        parent.once("close", (code) => {
          clearTimeout(timer);
          exitCode = code;
          resolve(code);
        });
      });

      let resolveReady, rejectReady;
      const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
      const readyTimer = setTimeout(() => rejectReady(new Error("Timeout waiting for parent READY")), 5000);

      parent.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const match = stdoutBuffer.match(/READY:(\d+)\n/);
        if (match) {
          subPid = Number(match[1]);
          clearTimeout(readyTimer);
          resolveReady(subPid);
        }
      });

      await readyPromise;
      expect(subPid).not.toBeNull();

      parent.kill("SIGINT");

      await parentClosePromise;
      expect(exitCode).toBe(130);

      const dead = await awaitProcessDead(subPid);
      expect(dead).toBe(true);
    } finally {
      if (subPid) {
        try { process.kill(subPid, "SIGKILL"); } catch {}
        await awaitProcessDead(subPid);
      }
      if (parent?.pid) {
        try { process.kill(parent.pid, "SIGKILL"); } catch {}
        await awaitProcessDead(parent.pid);
      }
    }
  });

  test("tears down detached process group on CLI interruption (SIGTERM exit 143) without orphaning descendants", async () => {
    let subPid = null;
    let parent = null;
    let exitCode = null;
    let stdoutBuffer = "";

    const parentScript = `
      import { auditInternals } from "./scripts/qa/cliproxy-audit.mjs";
      await auditInternals.runGate(
        ["sh", "-c", "trap '' TERM; echo READY:\$\$; while true; do sleep 1; done"],
        "${root}",
        30000,
        {
          onStdout: (chunk) => process.stdout.write(chunk),
        }
      );
    `;

    try {
      parent = spawn("bun", ["-e", parentScript], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const parentClosePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for parent close")), 5000);
        parent.once("close", (code) => {
          clearTimeout(timer);
          exitCode = code;
          resolve(code);
        });
      });

      let resolveReady, rejectReady;
      const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
      const readyTimer = setTimeout(() => rejectReady(new Error("Timeout waiting for parent READY")), 5000);

      parent.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const match = stdoutBuffer.match(/READY:(\d+)\n/);
        if (match) {
          subPid = Number(match[1]);
          clearTimeout(readyTimer);
          resolveReady(subPid);
        }
      });

      await readyPromise;
      expect(subPid).not.toBeNull();

      parent.kill("SIGTERM");

      await parentClosePromise;
      expect(exitCode).toBe(143);

      const dead = await awaitProcessDead(subPid);
      expect(dead).toBe(true);
    } finally {
      if (subPid) {
        try { process.kill(subPid, "SIGKILL"); } catch {}
        await awaitProcessDead(subPid);
      }
      if (parent?.pid) {
        try { process.kill(parent.pid, "SIGKILL"); } catch {}
        await awaitProcessDead(parent.pid);
      }
    }
  });

  test("tears down detached process group when parent exits before descendants", async () => {
    let subPid = null;
    let parent = null;
    let stdoutBuffer = "";

    const parentScript = `
      import { auditInternals } from "./scripts/qa/cliproxy-audit.mjs";
      let innerBuf = "";
      const gatePromise = auditInternals.runGate(
        ["sh", "-c", "trap '' TERM; echo READY:\$\$; while true; do sleep 1; done"],
        "${root}",
        30000,
        {
          onStdout: (chunk) => {
            process.stdout.write(chunk);
            innerBuf += chunk.toString();
            if (innerBuf.includes("READY")) {
              process.exit(0);
            }
          },
        }
      );
      await gatePromise;
    `;

    try {
      parent = spawn("bun", ["-e", parentScript], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const parentClosePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for parent close")), 5000);
        parent.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      let resolveReady, rejectReady;
      const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
      const readyTimer = setTimeout(() => rejectReady(new Error("Timeout waiting for parent exit ready")), 5000);

      parent.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const match = stdoutBuffer.match(/READY:(\d+)\n/);
        if (match) {
          subPid = Number(match[1]);
          clearTimeout(readyTimer);
          resolveReady(subPid);
        }
      });

      await readyPromise;
      expect(subPid).not.toBeNull();

      await parentClosePromise;

      const dead = await awaitProcessDead(subPid);
      expect(dead).toBe(true);
    } finally {
      if (subPid) {
        try { process.kill(subPid, "SIGKILL"); } catch {}
        await awaitProcessDead(subPid);
      }
      if (parent?.pid) {
        try { process.kill(parent.pid, "SIGKILL"); } catch {}
        await awaitProcessDead(parent.pid);
      }
    }
  });

  test("preserves non-zero exit codes without swallowing failures", async () => {
    const result = await auditInternals.runGate(
      ["sh", "-c", "exit 42"],
      root,
      5000
    );
    expect(result.code).toBe(42);
    expect(result.signal).toBeNull();
  });

  test("preserves spawn rejection errors without swallowing", async () => {
    await expect(
      auditInternals.runGate(["/nonexistent/binary/path/which/fails"], root, 5000)
    ).rejects.toThrow();
  });
});

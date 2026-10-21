import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APPROVED_PLAN_SHA256 = "1646c34e737781170951ed2b65b7be8516d46f6db9e6a3dd0e89dce78d85cf36";
const SCHEMA = "cliproxy-parity/task1-v1";
const VARIANTS = ["happy", "failure"];
const IS_ROWS = ["IS-1", "IS-2", "IS-3", "IS-4", "IS-5", "IS-6", "IS-7"];
const BENCHMARKS = Array.from({ length: 14 }, (_, index) => `B${index}`);
const GATE_TIMEOUT_MS = 30 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/i;
const REQUIRED_F3_CHANNELS = ["app-interaction", "pty-interaction", "media-peer", "wire-peer"];
const REQUIRED_INVENTORIES = {
  route: ["healthz", "models", "chat-completions"],
  setting: ["proxy", "retry", "quota"],
};

const FIXTURE_ASSERTIONS = {
  happy: ["healthz-200", "chat-status", "sentinel", "wire-payload-model", "wire-body-sha256", "teardown"],
  failure: ["healthz-200", "external-url-rejected", "mock-external-dial-zero", "teardown"],
};

const RECEIPT_ASSERTIONS = Object.fromEntries([
  ["fixture", FIXTURE_ASSERTIONS],
  ["proxy", { happy: ["reload-applies", "direct-bypasses-environment-proxy"], failure: ["invalid-proxy-rejected", "settings-unchanged"] }],
  ["retry", { happy: ["retry-round-sequence", "credential-cap"], failure: ["no-retry-after-commit", "nonretryable-no-extra-round"] }],
  ["multimodal", { happy: ["image-bytes-preserved", "document-fields-preserved", "cache-ttl-preserved"], failure: ["unsupported-media-400", "no-upstream-call"] }],
  ["options", { happy: ["reasoning-effort-wire", "json-schema-wire"], failure: ["unsupported-combination-400", "no-upstream-call"] }],
  ["usage", { happy: ["terminal-usage-once", "history-usage-equal"], failure: ["truncated-stream-unsuccessful"] }],
  ["settings", { happy: ["yaml-setting-applied"], failure: ["failed-persist-not-published"] }],
  ["affinity", { happy: ["route-binding-restored", "routing-header-not-forwarded"], failure: ["removed-binding-evicted"] }],
  ["responses", { happy: ["ordered-events", "joined-content-preserved"], failure: ["unsupported-capability-rejected"] }],
  ["cancel", { happy: ["upstream-cancelled", "guard-released-once", "client-abort-no-cooldown"], failure: ["postcommit-no-failover"] }],
  ["payload", { happy: ["payload-rule-applied-once"], failure: ["invalid-rule-rejected"] }],
  ["models", { happy: ["detail-matches-catalog"], failure: ["hidden-or-removed-model-404"] }],
  ["hierarchy", { happy: ["prefix-growth-locality", "explicit-session-precedence"], failure: ["cross-tenant-isolation", "expired-binding-evicted"] }],
  ["quota", { happy: ["weighted-sequence", "quota-scope-observed"], failure: ["unknown-scope-preserved", "operational-failure-not-disabled"] }],
  ["meta", { happy: ["device-flow", "remote-catalog", "relay"], failure: ["expired-token-remint"] }],
  ["xai", { happy: ["remote-catalog", "native-header", "media-relay"], failure: ["replay-isolated"] }],
  ["kimi", { happy: ["remote-catalog-refresh", "native-format"], failure: ["replay-isolated"] }],
  ["tls", { happy: ["h2-alpn", "http1-alpn", "h2c"], failure: ["invalid-cert-rejected"] }],
  ["ws", { happy: ["upgrade-after-dial", "two-turn-correlation", "cancel"], failure: ["upstream-break-closes-1011", "no-post-upgrade-failover"] }],
  ["aistudio", { happy: ["worker-correlation", "connected-catalog"], failure: ["disconnect-honest-error"] }],
  ["realtime", { happy: ["secret-sdp-media", "sideband", "hangup-cleanup"], failure: ["cross-issuer-denied", "expired-secret-denied"] }],
  ["audio-image", { happy: ["multipart-bytes-preserved", "audio-bytes-preserved"], failure: ["malformed-media-rejected", "json-error-not-audio"] }],
  ["video", { happy: ["job-owner-bound", "download-bytes-preserved"], failure: ["cross-caller-denied", "redirect-origin-rejected"] }],
  ["interactions", { happy: ["tool-continuation", "usage-terminal"], failure: ["wrong-caller-denied", "ambiguous-id-rejected"] }],
  ["compact-search", { happy: ["capsule-reuse", "search-citations-mapped"], failure: ["tampered-capsule-rejected", "unsupported-backend-rejected"] }],
  ["management-auth", { happy: ["dedicated-key-auth", "remote-connection-preserved"], failure: ["empty-secret-404", "inference-key-denied"] }],
  ["v8-config", { happy: ["v8-value-wins", "yaml-comment-preserved"], failure: ["invalid-config-422", "failed-persist-rollback"] }],
  ["management-ops", { happy: ["manifest-routes-covered", "operation-observed"], failure: ["unauthorized-denied", "missing-download-404"] }],
  ["resp", { happy: ["auth-ping", "queue-pop", "pubsub-event-once", "http-coexists"], failure: ["unauthorized-no-pop", "malformed-command-rejected"] }],
  ["plugin", { happy: ["abi-hook-called", "host-callback-observed", "quiescent-unload"], failure: ["abi-mismatch-rejected", "no-double-free"] }],
  ["plugin-store", { happy: ["artifact-installed", "quota-updated", "delete-effective"], failure: ["bad-hash-rejected", "loaded-artifact-locked"] }],
  ["home", { happy: ["mtls-sync", "fenced-release", "reconnect"], failure: ["ambiguous-dispatch-aborted", "stale-revision-rejected"] }],
  ["stores", { happy: ["selected-store-mutation", "restart-persists"], failure: ["backend-unavailable-reported", "spool-conflict-rejected"] }],
  ["tui-discovery", { happy: ["pty-navigation", "discovery-json", "shutdown-removes-advertisement"], failure: ["unauthorized-denied", "no-secret-advertisement"] }],
  ["bench-core", { happy: ["paired-rounds-complete", "terminal-usage-correct"], failure: ["missing-round-fails", "wrong-usage-fails"] }],
  ["bench-locality", { happy: ["b3-b5-recorded", "b8-b9-recorded"], failure: ["cross-tenant-collision-detected", "wrong-egress-detected"] }],
  ["bench-resilience", { happy: ["b6-b7-recorded", "b10-b13-recorded"], failure: ["leaked-guard-detected", "incomplete-log-fails"] }],
  ["desktop-parity", { happy: ["real-app-bootstrap", "settings-and-history", "child-exit"], failure: ["unreachable-gateway-actionable", "unknown-quota-preserved"] }],
]);

function requireValue(value, label) {
  if (value === undefined || value === null || value === "") throw new Error(`missing or invalid receipt: ${label}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const SOURCE_CLOSURE_PATTERNS = [
  "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain", "build.rs",
  ".cargo/*.toml", ".cargo/**/*.toml", ".cargo/config",
  "crates/**/*.rs", "crates/**/*.toml", "crates/**/*.yaml", "crates/**/*.json",
  "crates/**/*.sql", "crates/**/*.proto", "ui/index.html", ".omo/upstream/route-groups.json",
];

const REQUIRED_SOURCE_INPUTS = [
  "Cargo.toml", "Cargo.lock", "ui/index.html", ".omo/upstream/route-groups.json",
  "crates/gateway/Cargo.toml", "crates/types/Cargo.toml", "crates/registry/Cargo.toml",
  "crates/router/Cargo.toml", "crates/providers/Cargo.toml",
  "crates/registry/catalog/models-v1.json", "crates/gateway/src/compat/zcode-system-blocks.json",
  "crates/gateway/src/compat/devin.proto",
];

function compareSourcePaths(a, b) {
  return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}

function validateSourcePath(path) {
  assert(typeof path === "string" && path.length > 0 && !isAbsolute(path) &&
    !/^[A-Za-z]:/.test(path) && !/[\\\0]/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  `manifest path must be canonical relative: ${path}`);
}

export async function getSourceClosure(gatewayRoot = join(ROOT, "mahoquot-proxy")) {
  const proc = Bun.spawn([
    "git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
    ...SOURCE_CLOSURE_PATTERNS,
  ], { cwd: gatewayRoot, stdout: "pipe", stderr: "pipe" });
  const stdoutTask = new Response(proc.stdout).arrayBuffer();
  const stderrTask = new Response(proc.stderr).text();
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  let code;
  try {
    code = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const [stdout, stderr] = await Promise.all([stdoutTask, stderrTask]);
  assert(code === 0, `git ls-files failed (${code}): ${stderr}`);
  const bytes = Buffer.from(stdout);
  const text = bytes.toString("utf8");
  assert(Buffer.from(text).equals(bytes), "source paths must be valid UTF-8");
  const paths = new Set([...text.split("\0").filter(Boolean), ...REQUIRED_SOURCE_INPUTS]);
  const files = [];
  for (const path of paths) {
    validateSourcePath(path);
    // Tracked deletions and required embedded inputs are fatal, never omitted.
    files.push({ path, sha256: sha256(await readFile(join(gatewayRoot, path))) });
  }
  files.sort(compareSourcePaths);
  return { files, sourceHash: sha256(files.map((file) => `${file.path}\0${file.sha256}`).join("\n")) };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`missing or invalid receipt: ${path}: ${error.message}`);
  }
}

function taskCasesFromPlan(text) {
  const normalized = text.replace(/- \[[ xX]\] /g, "- [ ] ");
  const todo = normalized.split("## Todos")[1]?.split("## Final verification wave")[0];
  assert(todo, "approved plan is missing numbered task inventory");
  const cases = [];
  const taskPattern = /- \[ \] (\d+)\. ([^\n]+)([\s\S]*?)(?=\n- \[ \] \d+\.|$)/g;
  const happyRegex = /Happy:\s*`bun scripts\/qa\/cliproxy-parity\.mjs\s+--case\s+([^\s]+)\s+--variant\s+happy\s+--evidence\s+E\/([^\s`]+)`/;
  const failureRegex = /Failure:\s*`bun scripts\/qa\/cliproxy-parity\.mjs\s+--case\s+([^\s]+)\s+--variant\s+failure\s+--evidence\s+E\/([^\s`]+)`/;

  for (const match of todo.matchAll(taskPattern)) {
    const taskId = Number(match[1]);
    const block = match[3];
    const happyMatch = block.match(happyRegex);
    const failureMatch = block.match(failureRegex);
    assert(happyMatch, `task ${taskId} is missing Happy QA scenario`);
    assert(failureMatch, `task ${taskId} is missing Failure QA scenario`);
    const happyCase = happyMatch[1];
    const happyPath = happyMatch[2];
    const failureCase = failureMatch[1];
    const failurePath = failureMatch[2];
    assert(happyCase === failureCase, `task ${taskId} variants disagree on case name: happy=${happyCase} failure=${failureCase}`);
    assert(happyPath === `task-${taskId}-happy.json`, `task ${taskId} happy evidence path mismatch: expected task-${taskId}-happy.json, got ${happyPath}`);
    assert(failurePath === `task-${taskId}-failure.json`, `task ${taskId} failure evidence path mismatch: expected task-${taskId}-failure.json, got ${failurePath}`);
    cases.push({
      taskId,
      case: happyCase,
      happyPath,
      failurePath,
    });
  }
  assert(cases.length === 38 && new Set(cases.map(({ taskId }) => taskId)).size === 38, `approved plan case inventory is incomplete: ${cases.length}/38 unique=${new Set(cases.map(({ taskId }) => taskId)).size}`);
  assert(cases.every(({ taskId }, index) => taskId === index + 1), "approved task IDs are not the exact sequence 1..38");
  const names = new Set(cases.map(({ case: name }) => name));
  assert(names.size === 38, "approved task case names are not unique");
  return cases;
}

export function normalizeCheckboxes(text) {
  assert(typeof text === "string", "text must be a string");
  return text.replace(/- \[[ xX]\] /g, "- [ ] ");
}

function validateOperationalRecords(text, label) {
  const introduction = "These discovered repairs preserve the 38 numbered deliverables and F1-F4 acceptance requirements.";
  const disclaimer = " A repair checkbox does not substitute for its numbered task's DoneClaim, independent verification, or runtime evidence.";
  let hasItem = false;
  let hasIntroduction = false;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (!hasItem && !hasIntroduction && (line === introduction || line === introduction + disclaimer)) {
      hasIntroduction = true;
      continue;
    }
    const item = line.match(/^- \[[ xX]\] (\S.*)$/);
    const description = line.match(/^  (\S.*)$/);
    assert(item || (hasItem && description), `substantive plan contract mutation: invalid operational record in ${label}`);
    const content = (item ?? description)[1];
    assert(
      !/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\[[ xX]\]\s+)?(?:[1-9]|[12]\d|3[0-8]|F[1-4])[.):\s]/i.test(content) &&
      !/\b(?:Acceptance criteria|QA scenarios|Recommended executor category)\s*(?:\([^\n]*\))?\s*:/i.test(content),
      `substantive plan contract mutation: contract declaration inside ${label}`
    );
    assert(
      !/^#/.test(content) && !/^[=-]+\s*$/.test(content) && !/<\/?h[1-6]\b/i.test(content),
      `substantive plan contract mutation: heading inside ${label}`
    );
    // The current publication-barrier record describes readers during a commit;
    // it does not change permission to commit, push, or deploy.
    const publicationDescription = "Existing Task12 owner corrects the newly introduced publication test: readers during commit must observe the old coherent pair, after publication the new coherent pair.";
    const policyText = content.startsWith(publicationDescription)
      ? content.slice(publicationDescription.length)
      : content;
    assert(
      !/\b(?:commits?|committing|push(?:es|ed|ing)?|deploy(?:s|ed|ing|ment|ments)?)\b/i.test(policyText),
      `substantive plan contract mutation: commit/push/deploy policy inside ${label}`
    );
    if (item) hasItem = true;
  }
  assert(hasItem, `substantive plan contract mutation: missing operational checkbox items in ${label}`);
}

export function stripOperationalAppendices(text) {
  assert(typeof text === "string", "text must be a string");

  for (const match of text.matchAll(/^#{1,6}\s+([^\n]+)$/gm)) {
    const headingText = match[1].trim();
    if (/recovery/i.test(headingText)) {
      const fullLine = match[0].trim();
      if (
        fullLine !== "## Execution recovery checklist" &&
        fullLine !== "### Verification preparation recovery"
      ) {
        throw new Error(`substantive plan contract mutation: invalid or renamed recovery heading '${fullLine}'`);
      }
    }
  }

  const executionRecoveryMatches = [...text.matchAll(/^## Execution recovery checklist$/gm)];
  if (executionRecoveryMatches.length > 1) {
    throw new Error("substantive plan contract mutation: duplicate '## Execution recovery checklist' heading");
  }

  const verificationPrepMatches = [...text.matchAll(/^### Verification preparation recovery$/gm)];
  if (verificationPrepMatches.length > 1) {
    throw new Error("substantive plan contract mutation: duplicate '### Verification preparation recovery' heading");
  }

  if (verificationPrepMatches.length === 1 && executionRecoveryMatches.length === 0) {
    throw new Error(
      "substantive plan contract mutation: '### Verification preparation recovery' present without '## Execution recovery checklist'"
    );
  }

  if (executionRecoveryMatches.length === 0 && verificationPrepMatches.length === 0) {
    return text;
  }

  const finalVerificationIndex = text.indexOf("\n## Final verification wave\n");
  const commitStrategyIndex = text.indexOf("\n## Commit strategy\n");
  const noGitSentence = "No git commits/push in planning or execution without explicit user request.";
  const noGitIndex = text.indexOf(noGitSentence);
  const successCriteriaIndex = text.indexOf("\n## Success criteria\n");

  assert(finalVerificationIndex !== -1, "substantive plan contract mutation: missing '## Final verification wave'");
  assert(commitStrategyIndex !== -1, "substantive plan contract mutation: missing '## Commit strategy'");
  assert(noGitIndex !== -1, "substantive plan contract mutation: missing no-git commit policy sentence");
  assert(successCriteriaIndex !== -1, "substantive plan contract mutation: missing '## Success criteria'");

  if (
    !(
      finalVerificationIndex < commitStrategyIndex &&
      commitStrategyIndex < noGitIndex &&
      noGitIndex < successCriteriaIndex
    )
  ) {
    throw new Error("substantive plan contract mutation: canonical plan sections out of order");
  }

  const execRecoveryIndex = executionRecoveryMatches[0].index;
  if (!(finalVerificationIndex < execRecoveryIndex && execRecoveryIndex < commitStrategyIndex)) {
    throw new Error(
      "substantive plan contract mutation: '## Execution recovery checklist' is misplaced; must appear between '## Final verification wave' and '## Commit strategy'"
    );
  }

  const f4Match = text.search(/- \[[ xX]\] F4\. Ideal-state fidelity/);
  if (f4Match === -1 || f4Match > execRecoveryIndex) {
    throw new Error("substantive plan contract mutation: F1-F4 verification wave must precede '## Execution recovery checklist'");
  }

  const recoverySection = text.slice(execRecoveryIndex + "## Execution recovery checklist".length, commitStrategyIndex);
  validateOperationalRecords(recoverySection, "execution recovery checklist");

  let prepIndex = -1;
  if (verificationPrepMatches.length === 1) {
    prepIndex = verificationPrepMatches[0].index;
    if (!(commitStrategyIndex < prepIndex && prepIndex < noGitIndex)) {
      throw new Error(
        "substantive plan contract mutation: '### Verification preparation recovery' is misplaced; must appear inside '## Commit strategy' before the no-git sentence"
      );
    }
    if (prepIndex < execRecoveryIndex) {
      throw new Error("substantive plan contract mutation: recovery markers are reordered");
    }

    const betweenCommitAndPrep = text.slice(commitStrategyIndex + "\n## Commit strategy\n".length, prepIndex).trim();
    if (betweenCommitAndPrep.length > 0) {
      throw new Error("substantive plan contract mutation: unexpected content between '## Commit strategy' and '### Verification preparation recovery'");
    }

    const prepSection = text.slice(prepIndex + "### Verification preparation recovery".length, noGitIndex);
    validateOperationalRecords(prepSection, "verification preparation recovery");
  }

  let stripped = text;
  if (verificationPrepMatches.length === 1) {
    const beforePrep = stripped.slice(0, prepIndex);
    const afterPrep = stripped.slice(noGitIndex);
    stripped = beforePrep + afterPrep;
  }

  const execHeading = "\n## Execution recovery checklist\n";
  let execIdx = stripped.indexOf(execHeading);
  assert(execIdx !== -1, "substantive plan contract mutation: failed locating execution recovery heading for stripping");
  if (execIdx > 0 && stripped[execIdx - 1] === "\n") {
    execIdx--;
  }

  const commitHeading = "\n## Commit strategy\n";
  let commitIdx = stripped.indexOf(commitHeading, execIdx);
  assert(commitIdx !== -1, "substantive plan contract mutation: failed locating commit strategy heading for stripping");
  if (commitIdx > 0 && stripped[commitIdx - 1] === "\n") {
    commitIdx--;
  }

  stripped = stripped.slice(0, execIdx) + stripped.slice(commitIdx);
  return stripped;
}

export function validatePlanContract(liveText, approvedText) {
  assert(typeof liveText === "string", "liveText must be a string");
  assert(typeof approvedText === "string", "approvedText must be a string");

  const liveStripped = stripOperationalAppendices(liveText);
  const approvedStripped = stripOperationalAppendices(approvedText);

  const liveNormalized = normalizeCheckboxes(liveStripped);
  const approvedNormalized = normalizeCheckboxes(approvedStripped);

  if (liveNormalized !== approvedNormalized) {
    let mismatchPos = 0;
    while (
      mismatchPos < liveNormalized.length &&
      mismatchPos < approvedNormalized.length &&
      liveNormalized[mismatchPos] === approvedNormalized[mismatchPos]
    ) {
      mismatchPos++;
    }
    const liveSample = liveNormalized.slice(mismatchPos, mismatchPos + 60).replace(/\n/g, "\\n");
    const approvedSample = approvedNormalized.slice(mismatchPos, mismatchPos + 60).replace(/\n/g, "\\n");
    throw new Error(
      `substantive plan contract mutation at character ${mismatchPos}: live='${liveSample}' vs approved='${approvedSample}'`
    );
  }

  return true;
}

function validateAssertionSet(receipt, label) {
  assert(plainObject(receipt), `missing or invalid receipt: ${label}`);
  assert(Array.isArray(receipt.assertions) && receipt.assertions.length > 0, `missing assertion records: ${label}`);
  const required = RECEIPT_ASSERTIONS[receipt.case]?.[receipt.variant];
  assert(Array.isArray(required) && required.length > 0, `no derived assertion contract for ${receipt.case}/${receipt.variant}: ${label}`);

  if (receipt.required_assertion_ids !== undefined) {
    assert(Array.isArray(receipt.required_assertion_ids), `required_assertion_ids must be an array: ${label}`);
    assert(
      JSON.stringify([...receipt.required_assertion_ids].sort()) === JSON.stringify([...required].sort()),
      `declared required assertion IDs differ from audit contract: ${label}`
    );
  }

  const ids = new Set();
  for (const assertion of receipt.assertions) {
    assert(plainObject(assertion) && typeof assertion.id === "string" && assertion.id.length > 0, `invalid assertion record: ${label}`);
    assert(!ids.has(assertion.id), `duplicate assertion id ${assertion.id}: ${label}`);
    ids.add(assertion.id);
    requireValue(assertion.expected, `${label} assertion ${assertion.id} expected`);
    requireValue(assertion.actual, `${label} assertion ${assertion.id} actual`);
    assert(assertion.pass === true, `failed assertion ${assertion.id}: ${label}`);

    if (assertion.id === "healthz-200" || assertion.id === "chat-status") {
      assert(assertion.expected === 200, `${assertion.id} expected must be 200: ${label}`);
      assert(assertion.actual === 200, `HTTP status assertion mismatch ${assertion.id}: expected 200, got ${assertion.actual} (${label})`);
    } else if (assertion.id === "sentinel") {
      assert(typeof assertion.expected === "string" && assertion.expected.length > 0, `invalid sentinel expected: ${label}`);
      assert(
        assertion.actual === true || assertion.actual === assertion.expected,
        `sentinel assertion failed: expected ${assertion.expected}, got ${assertion.actual} (${label})`
      );
    } else if (assertion.id === "wire-body-sha256") {
      assert(assertion.expected === "64 lowercase hex characters", `wire-body-sha256 expected shape mismatch: ${label}`);
      assert(typeof assertion.actual === "string" && HASH.test(assertion.actual), `wire-body-sha256 actual is not 64 hex: ${label}`);
    } else if (assertion.id === "wire-payload-model") {
      assert(typeof assertion.expected === "string", `wire-payload-model expected must be string: ${label}`);
      assert(assertion.actual === assertion.expected, `wire model assertion mismatch: expected ${assertion.expected}, got ${assertion.actual} (${label})`);
    } else if (assertion.id === "teardown") {
      if (typeof assertion.expected === "object" && assertion.expected !== null) {
        assert(assertion.actual?.listeners === 0 && assertion.actual?.ownedProcesses === 0, `teardown assertion failed: resources remain (${label})`);
      } else {
        assert(assertion.expected === assertion.actual, `teardown assertion mismatch: ${label}`);
      }
    } else {
      assert(
        JSON.stringify(assertion.expected) === JSON.stringify(assertion.actual),
        `expected/actual mismatch for ${assertion.id}: expected ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(assertion.actual)} (${label})`
      );
    }

    if (assertion.expected_status !== undefined || assertion.observed_status !== undefined) {
      assert(Number.isInteger(assertion.expected_status) && Number.isInteger(assertion.observed_status), `invalid status assertion ${assertion.id}: ${label}`);
      assert(assertion.expected_status === assertion.observed_status, `status mismatch ${assertion.id}: ${label}`);
    }
  }

  assert(JSON.stringify([...ids].sort()) === JSON.stringify([...required].sort()), `wrong exact required assertion IDs: ${label}`);
  return ids;
}

async function validateProvenance(provenance, label) {
  assert(plainObject(provenance), `missing provenance: ${label}`);
  requireValue(provenance.gateway_binary, `${label} gateway_binary`);
  assert(typeof provenance.gateway_binary === "string" && isAbsolute(provenance.gateway_binary), `gateway binary path must be absolute: ${label}`);
  assert(typeof provenance.gateway_sha256 === "string" && HASH.test(provenance.gateway_sha256), `invalid binary SHA-256: ${label}`);
  requireValue(provenance.gateway_revision, `${label} gateway_revision`);
  requireValue(provenance.desktop_revision, `${label} desktop_revision`);
  assert(typeof provenance.dirty === "boolean", `missing source dirty state: ${label}`);
  requireValue(provenance.gateway_source_sha256, `${label} gateway_source_sha256`);
  assert(HASH.test(provenance.gateway_source_sha256), `invalid source SHA-256: ${label}`);
  requireValue(provenance.build_command, `${label} build_command`);
  assert(provenance.binary_source_revision === provenance.gateway_revision, `binary/source revision mismatch: ${label}`);

  assert(provenance.source_manifest && Array.isArray(provenance.source_manifest.files) && provenance.source_manifest.files.length > 0, `source file manifest missing: ${label}`);
  const seenPaths = new Set();
  for (const file of provenance.source_manifest.files) {
    assert(plainObject(file), `invalid source file manifest: ${label}`);
    validateSourcePath(file.path);
    assert(!seenPaths.has(file.path), `duplicate manifest path: ${file.path} (${label})`);
    seenPaths.add(file.path);
    assert(HASH.test(file.sha256 ?? ""), `invalid source file manifest: ${label}`);
  }
  const sortedFiles = [...provenance.source_manifest.files].sort(compareSourcePaths);

  const computedTreeHash = sha256(sortedFiles.map((file) => `${file.path}\0${file.sha256}`).join("\n"));
  assert(computedTreeHash === provenance.gateway_source_sha256, `source tree hash mismatch: computed ${computedTreeHash}, declared ${provenance.gateway_source_sha256}: ${label}`);

  const sourceRoot = provenance.source_root ?? join(ROOT, "mahoquot-proxy");
  const diskClosure = await getSourceClosure(sourceRoot);
  assert(sortedFiles.length === diskClosure.files.length, `source manifest file count mismatch: ${label}`);
  for (let index = 0; index < sortedFiles.length; index += 1) {
    const file = sortedFiles[index];
    const diskFile = diskClosure.files[index];
    assert(file.path === diskFile.path, `source manifest path set mismatch: ${file.path} vs ${diskFile.path}: ${label}`);
    assert(file.sha256 === diskFile.sha256, `source file ${file.path} on disk hash ${diskFile.sha256} does not match manifest ${file.sha256}: ${label}`);
  }
  assert(diskClosure.sourceHash === provenance.gateway_source_sha256, `gateway source SHA-256 mismatch: ${label}`);

  const binBytes = await readFile(provenance.gateway_binary);
  const binSha = sha256(binBytes);
  assert(binSha === provenance.gateway_sha256, `binary on disk hash ${binSha} does not match receipt ${provenance.gateway_sha256}: ${label}`);

  assert(plainObject(provenance.build_receipt), `missing mandatory build_receipt: ${label}`);
  requireValue(provenance.build_receipt.path, `${label} build_receipt path`);
  assert(typeof provenance.build_receipt.path === "string" && isAbsolute(provenance.build_receipt.path), `build_receipt path must be absolute: ${label}`);
  assert(typeof provenance.build_receipt.sha256 === "string" && HASH.test(provenance.build_receipt.sha256), `invalid build_receipt sha256: ${label}`);

  const buildReceiptBytes = await readFile(provenance.build_receipt.path);
  const computedBuildReceiptSha = sha256(buildReceiptBytes);
  assert(computedBuildReceiptSha === provenance.build_receipt.sha256, `build receipt hash mismatch: computed ${computedBuildReceiptSha}, declared ${provenance.build_receipt.sha256}: ${label}`);

  const buildReceiptText = buildReceiptBytes.toString("utf8");
  const lines = buildReceiptText.replace(/\n$/, "").split("\n");
  assert(lines.length === 4, `build receipt must contain exactly 4 lines: ${label}`);
  const [receiptRevision, receiptBinHash, receiptSourceHash, receiptBuildCommand] = lines;
  assert(receiptRevision === provenance.gateway_revision, `build receipt source revision mismatch: expected ${provenance.gateway_revision}, got ${receiptRevision}: ${label}`);
  assert(receiptBinHash === provenance.gateway_sha256, `build receipt binary hash mismatch: expected ${provenance.gateway_sha256}, got ${receiptBinHash}: ${label}`);
  assert(receiptSourceHash === provenance.gateway_source_sha256, `build receipt source hash mismatch: ${label}`);
  assert(receiptBuildCommand === provenance.build_command, `build receipt command mismatch: ${label}`);
  assert(typeof provenance.build_command === "string" && provenance.build_command.includes("cargo build"), `build command does not match cargo build: ${label}`);
}

async function validateWire(receipt, label) {
  const wire = requireValue(receipt.wire_capture, `${label} wire_capture`);
  assert(plainObject(wire) && Array.isArray(wire.gateway_requests), `invalid gateway wire capture: ${label}`);
  if (receipt.variant === "happy") {
    const request = wire.gateway_requests.find((entry) => entry.method === "POST" && typeof entry.path === "string");
    assert(request, `missing captured inference request: ${label}`);
    const bytesValue = requireValue(request.body_bytes_base64, `${label} captured request bytes`);
    assert(typeof bytesValue === "string", `request bytes must be base64: ${label}`);
    const bytes = Buffer.from(bytesValue, "base64");
    assert(bytes.toString("base64") === bytesValue, `invalid request body base64: ${label}`);
    const digest = sha256(bytes);
    assert(request.body_sha256 === digest, `captured body SHA-256 mismatch: ${label}`);
    const digestAssertion = receipt.assertions.find((assertion) => assertion.id === "wire-body-sha256");
    if (digestAssertion) assert(digestAssertion.actual === digest, `wire digest assertion is not byte-backed: ${label}`);

    if (receipt.case === "fixture") {
      const model = receipt.assertions.find((entry) => entry.id === "wire-payload-model");
      if (model) {
        assert(JSON.parse(bytes.toString("utf8")).model === model.actual && model.expected === model.actual, `wire model assertion is not byte-backed: ${label}`);
      }
      const sentinel = receipt.assertions.find((entry) => entry.id === "sentinel");
      if (sentinel) {
        const sentinelEvent = receipt.events?.find(
          (event) => event.type === "response-data" && typeof event.data === "string" && event.data.includes(sentinel.expected)
        );
        assert(sentinelEvent, `sentinel assertion is not backed by captured response-data bytes: ${label}`);
      }
    }
  } else if (receipt.variant === "failure") {
    if (wire.external_dials !== undefined) {
      assert(wire.external_dials === 0, `mock external dials occurred during failure test: ${wire.external_dials} (${label})`);
    }
  }
}

function validateEvents(receipt, label) {
  assert(Array.isArray(receipt.event_order) && receipt.event_order.length > 0, `missing event order: ${label}`);
  assert(receipt.event_order.every((event) => typeof event === "string" && event.length > 0), `invalid event order: ${label}`);
  const events = requireValue(receipt.events, `${label} events`);
  assert(Array.isArray(events) && events.length > 0, `missing timestamped/identified events: ${label}`);
  const ids = new Set(events.map((event) => event.id));
  assert(events.every((event) => typeof event.id === "string" && typeof event.type === "string"), `invalid event records: ${label}`);
  assert(receipt.event_order.join("\0") === events.map((event) => event.type).join("\0"), `event order differs from captured events: ${label}`);
  for (const assertion of receipt.assertions) {
    if (assertion.event_ids) {
      assert(Array.isArray(assertion.event_ids) && assertion.event_ids.every((id) => ids.has(id)), `assertion references unknown events: ${label}/${assertion.id}`);
    }
  }
}

function validateTeardown(receipt, label) {
  const teardown = requireValue(receipt.teardown, `${label} teardown`);
  assert(plainObject(teardown) && plainObject(teardown.exit), `missing process exit in teardown: ${label}`);

  if (teardown.exit.signal === null) {
    assert(teardown.exit.code === 0, `process did not exit cleanly (exit code ${teardown.exit.code}): ${label}`);
  } else if (teardown.exit.signal === "SIGINT" || teardown.exit.signal === "SIGTERM") {
    assert(
      teardown.termination === "controlled-signal" || teardown.termination === "controlled",
      `process terminated by signal ${teardown.exit.signal} without recorded intentional termination: ${label}`
    );
  } else {
    throw new Error(`process terminated by unexpected signal ${teardown.exit.signal} (crash): ${label}`);
  }

  assert(teardown.listeners === 0 && teardown.ownedProcesses === 0, `resources remain after teardown: listeners=${teardown.listeners}, processes=${teardown.ownedProcesses}: ${label}`);
  assert(Array.isArray(teardown.listener_inventory) && teardown.listener_inventory.length === 0, `listener inventory is absent or nonempty: ${label}`);
  assert(Array.isArray(teardown.process_inventory) && teardown.process_inventory.length === 0, `owned process inventory is absent or nonempty: ${label}`);
}

async function validateReceipt(receipt, caseName, variant, label) {
  assert(plainObject(receipt) && receipt.schema === SCHEMA, `wrong receipt schema: ${label}`);
  assert(receipt.case === caseName && receipt.variant === variant, `wrong case or variant: expected ${caseName}/${variant}, got ${receipt.case}/${receipt.variant} (${label})`);
  assert(typeof receipt.created_at === "string" && Number.isFinite(Date.parse(receipt.created_at)), `invalid receipt timestamp: ${label}`);
  validateAssertionSet(receipt, label);
  await validateProvenance(receipt.provenance, label);
  validateEvents(receipt, label);
  validateTeardown(receipt, label);
  await validateWire(receipt, label);
}

async function validateInventory(root, kind) {
  const path = join(root, `${kind}-inventory.json`);
  const inventory = await readJson(path);
  assert(plainObject(inventory) && inventory.kind === kind && Array.isArray(inventory.entries) && inventory.entries.length > 0, `missing or empty ${kind} inventory`);
  requireValue(inventory.source_revision, `${kind} inventory source_revision`);
  assert(HASH.test(inventory.source_sha256 ?? ""), `invalid ${kind} inventory source hash`);

  const ids = new Set();
  for (const entry of inventory.entries) {
    assert(plainObject(entry), `invalid ${kind} inventory entry`);
    requireValue(entry.id, `${kind} entry id`);
    requireValue(entry.source_path, `${kind} entry source_path`);
    requireValue(entry.observed, `${kind} entry observed`);
    assert(entry.pass === true, `inventory entry failed: ${kind}/${entry.id}`);
    ids.add(entry.id);
  }

  const mandatory = REQUIRED_INVENTORIES[kind] ?? [];
  for (const reqId of mandatory) {
    assert(ids.has(reqId) || [...ids].some((id) => id.includes(reqId)), `missing mandatory ${kind} inventory entry: ${reqId}`);
  }

  if (Array.isArray(inventory.required_ids)) {
    for (const reqId of inventory.required_ids) {
      assert(ids.has(reqId) || [...ids].some((id) => id.includes(reqId)), `missing declared ${kind} inventory entry: ${reqId}`);
    }
  }

  return inventory;
}

async function validateTaskReceipts(root, cases) {
  const receipts = [];
  for (const item of cases) {
    for (const variant of VARIANTS) {
      const file = join(root, variant === "happy" ? item.happyPath : item.failurePath);
      const receipt = await readJson(file);
      await validateReceipt(receipt, item.case, variant, file);
      receipts.push(receipt);
    }
  }
  assert(receipts.length === 76, `expected 76 exact task receipts, got ${receipts.length}`);
  return receipts;
}

async function validateF3(root) {
  const instruction = {
    schema: "cliproxy-audit/f3-instructions-v1",
    required_channels: REQUIRED_F3_CHANNELS,
    required_fields: ["id", "kind", "trigger", "observed_event", "artifact", "artifact_sha256"],
    forbidden_as_standalone_evidence: ["screenshot-only", "pass-flag-only"],
  };
  const receipt = await readJson(join(root, "F3-behavior.json"));
  assert(Array.isArray(receipt.behaviors) && receipt.behaviors.length > 0, "F3 requires actual behavioral receipts");

  const observedChannels = new Set();
  for (const behavior of receipt.behaviors) {
    requireValue(behavior.kind, "F3 behavior kind");
    assert(REQUIRED_F3_CHANNELS.includes(behavior.kind), `nonbehavioral F3 capture: ${behavior.kind}`);
    observedChannels.add(behavior.kind);
    requireValue(behavior.id, "F3 behavior id");
    requireValue(behavior.trigger, "F3 trigger");
    requireValue(behavior.observed_event, "F3 observed event");
    requireValue(behavior.artifact, "F3 artifact");
    assert(typeof behavior.artifact === "string" && !behavior.artifact.includes(".."), `invalid F3 artifact path: ${behavior.id}`);

    assert(behavior.kind !== "screenshot-only" && behavior.kind !== "pass-flag-only", `F3 forbidden standalone evidence kind: ${behavior.kind}`);
    assert(!behavior.artifact.endsWith(".png") && !behavior.artifact.endsWith(".jpg"), `F3 screenshot cannot serve as behavioral capture: ${behavior.id}`);

    const artifactPath = resolve(root, behavior.artifact);
    assert(artifactPath.startsWith(`${root}${sep}`), `F3 artifact escapes evidence root: ${behavior.id}`);
    const artifactBytes = await readFile(artifactPath);
    assert(HASH.test(behavior.artifact_sha256 ?? "") && sha256(artifactBytes) === behavior.artifact_sha256, `F3 artifact digest mismatch: ${behavior.id}`);
    const capture = JSON.parse(artifactBytes.toString("utf8"));
    assert(capture.kind === behavior.kind && capture.trigger === behavior.trigger && capture.observed_event === behavior.observed_event && capture.outcome === "observed", `F3 artifact does not verify claimed behavior: ${behavior.id}`);
  }

  for (const channel of REQUIRED_F3_CHANNELS) {
    assert(observedChannels.has(channel), `F3 missing required behavior channel: ${channel}`);
  }

  return { instruction, receipt };
}

async function validateF4(root) {
  const receipt = await readJson(join(root, "F4-fidelity.json"));
  assert(plainObject(receipt), "F4 receipt is required");
  assert(plainObject(receipt.provenance), "F4 requires provenance object");
  assert(plainObject(receipt.is_rows), "F4 is_rows mapping is required");

  for (const id of IS_ROWS) {
    const row = requireValue(receipt.is_rows[id], `F4 ${id}`);
    assert(row.pass === true, `F4 row ${id} pass is not true`);
    assert(Array.isArray(row.evidence) && row.evidence.length > 0, `F4 ${id} lacks evidence`);
    for (const reference of row.evidence) {
      requireValue(reference.path, `F4 ${id} evidence path`);
      assert(reference.pass !== false, `F4 evidence ${reference.path} pass is false`);
      const evidencePath = resolve(root, reference.path);
      assert(evidencePath.startsWith(`${root}${sep}`), `F4 evidence escapes root: ${id}`);
      const bytes = await readFile(evidencePath);
      assert(HASH.test(reference.sha256 ?? "") && sha256(bytes) === reference.sha256, `F4 evidence digest mismatch: ${id}`);
    }
  }

  assert(plainObject(receipt.benchmarks), "F4 benchmark statistics are required");
  for (const id of BENCHMARKS) {
    const pair = requireValue(receipt.benchmarks[id], `F4 ${id}`);
    assert(plainObject(pair.baseline) && plainObject(pair.candidate), `F4 ${id} requires paired baseline/candidate statistics`);

    requireValue(pair.baseline.samples, `F4 ${id} baseline samples`);
    requireValue(pair.candidate.samples, `F4 ${id} candidate samples`);
    assert(Number.isInteger(pair.baseline.samples) && pair.baseline.samples > 0, `F4 ${id} baseline has no samples`);
    assert(Number.isInteger(pair.candidate.samples) && pair.candidate.samples > 0, `F4 ${id} candidate has no samples`);
    assert(pair.baseline.samples === pair.candidate.samples, `F4 ${id} sample count mismatch between baseline (${pair.baseline.samples}) and candidate (${pair.candidate.samples})`);

    for (const side of [pair.baseline, pair.candidate]) {
      for (const metric of ["ttfb_ms", "content_ttft_ms", "completion_ms", "errors", "rss_bytes", "fd_count"]) {
        requireValue(side[metric], `F4 ${id} ${metric}`);
        assert(typeof side[metric] === "number" && Number.isFinite(side[metric]) && side[metric] >= 0, `F4 ${id} invalid metric ${metric}`);
      }
    }
    requireValue(pair.seed, `F4 ${id} seed`);
    requireValue(pair.config_sha256, `F4 ${id} config hash`);
    assert(HASH.test(pair.config_sha256), `F4 ${id} invalid config hash`);
  }
  return receipt;
}

function runGate(command, cwd, timeoutMs = GATE_TIMEOUT_MS, options = {}) {
  return new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawn(command[0], command.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: true });
    } catch (error) {
      return reject(error);
    }
    const childPid = child.pid;
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let interruptedSignal = null;
    let timer = null;
    let forceKillTimer = null;
    let resolved = false;

    const killGroup = (sig = "SIGTERM") => {
      if (childPid) {
        try { process.kill(-childPid, sig); } catch {}
        try { process.kill(childPid, sig); } catch {}
      }
    };

    const onSigInt = () => onSignal("SIGINT");
    const onSigTerm = () => onSignal("SIGTERM");

    const cleanupListeners = () => {
      process.removeListener("SIGINT", onSigInt);
      process.removeListener("SIGTERM", onSigTerm);
      process.removeListener("exit", onParentExit);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const scheduleForceKill = () => {
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          forceKillTimer = null;
          killGroup("SIGKILL");
        }, 1_000);
      }
    };

    const onParentExit = () => {
      killGroup("SIGKILL");
    };

    const onSignal = (sig) => {
      if (!interruptedSignal) {
        interruptedSignal = sig;
      }
      killGroup("SIGTERM");
      scheduleForceKill();
      if (options.exitOnSignal !== false) {
        cleanupListeners();
        killGroup("SIGKILL");
        process.exit(128 + (sig === "SIGINT" ? 2 : 15));
      }
    };

    const onAbort = () => {
      if (!timedOut && !interruptedSignal) {
        if (options.signal?.reason === "TIMEOUT") {
          timedOut = true;
        } else {
          interruptedSignal = "SIGTERM";
        }
      }
      killGroup("SIGTERM");
      scheduleForceKill();
    };

    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    process.on("exit", onParentExit);

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      if (typeof options.onStdout === "function") {
        options.onStdout(chunk);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      if (typeof options.onStderr === "function") {
        options.onStderr(chunk);
      }
    });

    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      cleanupListeners();
      reject(error);
    });

    child.once("close", async (code, signal) => {
      if (timer) clearTimeout(timer);
      cleanupListeners();

      let groupAlive = false;
      try {
        process.kill(-childPid, 0);
        groupAlive = true;
      } catch {
        groupAlive = false;
      }

      if (timedOut || interruptedSignal || groupAlive) {
        killGroup("SIGKILL");
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
        try {
          await new Promise((resolveDescendants, rejectDescendants) => {
            const deadline = Date.now() + 2_000;
            const check = () => {
              let alive = false;
              try {
                process.kill(-childPid, 0);
                alive = true;
              } catch {
                alive = false;
              }
              if (!alive) {
                resolveDescendants();
              } else if (Date.now() >= deadline) {
                try { process.kill(-childPid, "SIGKILL"); } catch {}
                rejectDescendants(new Error(`process group -${childPid} failed to terminate within teardown deadline`));
              } else {
                setImmediate(check);
              }
            };
            check();
          });
        } catch (cleanupError) {
          if (!resolved) {
            resolved = true;
            return reject(cleanupError);
          }
        }

        if (!timedOut && !interruptedSignal && code === 0 && groupAlive) {
          if (!resolved) {
            resolved = true;
            return reject(new Error(`command exited with code 0 but leaked live detached process group -${childPid}`));
          }
        }
      }

      if (resolved) return;
      resolved = true;

      const finalSignal = interruptedSignal ?? (timedOut ? "TIMEOUT" : signal);
      const finalCode = (timedOut || interruptedSignal) ? null : code;
      resolveResult({
        command,
        cwd,
        code: finalCode,
        signal: finalSignal,
        ...(timedOut ? { timeout_ms: timeoutMs } : {}),
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        scheduleForceKill();
      }, timeoutMs);
    }
  });
}

async function executeF2(root) {
  const specs = [
    ["gateway-cargo", ["cargo", "fmt", "--all", "--", "--check"], join(ROOT, "mahoquot-proxy")],
    ["gateway-clippy", ["cargo", "clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"], join(ROOT, "mahoquot-proxy")],
    ["gateway-tests", ["cargo", "test", "--workspace", "--all-features"], join(ROOT, "mahoquot-proxy")],
    ["root-verify", ["bash", "scripts/verify.sh"], ROOT],
  ];
  const results = [];
  for (const [name, command, cwd] of specs) {
    const result = await runGate(command, cwd);
    const record = { name, ...result, pass: result.code === 0 && result.signal === null };
    await writeFile(join(root, `F2-${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
    results.push(record);
    if (!record.pass) break;
  }
  assert(results.length === specs.length && results.every((result) => result.pass), "F2 real gate execution failed or incomplete");
  return results;
}

async function negativeReceiptTest(root, cases) {
  const fixtureRoot = mkdtempSync(join(root, ".negative-receipts-"));
  try {
    const sourcePath = join(root, `task-${cases[0].taskId}-happy.json`);
    const source = await readJson(sourcePath);
    const mutations = [
      {
        name: "omitted-assertion",
        mutate: (val) => {
          val.assertions = val.assertions.filter((a) => a.id !== val.required_assertion_ids[0]);
          val.required_assertion_ids = val.required_assertion_ids.slice(1);
        },
      },
      {
        name: "pass-true-wrong-actual",
        mutate: (val) => {
          const a = val.assertions.find((x) => x.id === "healthz-200") ?? val.assertions[0];
          a.expected = 200;
          a.actual = 500;
          a.pass = true;
        },
      },
      {
        name: "unknown-variant",
        mutate: (val) => {
          val.variant = "unknown-variant";
        },
      },
      {
        name: "stale-source-binary",
        mutate: (val) => {
          val.provenance.gateway_sha256 = "a".repeat(64);
          val.provenance.gateway_revision = "stale-revision";
        },
      },
      {
        name: "missing-teardown",
        mutate: (val) => {
          val.teardown.listeners = 1;
        },
      },
    ];

    const rejected = [];
    for (const [index, { name, mutate }] of mutations.entries()) {
      const clone = structuredClone(source);
      mutate(clone);
      const testPath = join(fixtureRoot, `negative-${index}.json`);
      await writeFile(testPath, JSON.stringify(clone));
      let threw = false;
      try {
        await validateReceipt(clone, cases[0].case, clone.variant, testPath);
      } catch {
        threw = true;
      }
      assert(threw, `negative receipt mutation '${name}' unexpectedly accepted`);
      rejected.push(name);
    }
    const result = {
      schema: "cliproxy-audit/negative-v1",
      source: relative(root, sourcePath),
      copies: mutations.length,
      rejected,
    };
    await writeFile(join(root, "negative-receipt-test.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

export async function runAudit({ audit, evidenceRoot, negativeReceiptTest: negative = false }) {
  assert(["F1", "F2", "F3", "F4"].includes(audit), `unsupported audit: ${audit}`);
  assert(typeof evidenceRoot === "string" && isAbsolute(evidenceRoot), "evidence root must be absolute");
  const root = resolve(evidenceRoot);
  assert(root.startsWith(`${join(ROOT, ".omo/evidence/cliproxy-remediation")}${sep}`), "evidence root must be inside workspace evidence directory");

  const approvedPlanPath = process.env.MAHOQUOT_APPROVED_PLAN || resolve(ROOT, ".omo/plans/cliproxy-remediation-plan.approved.md");
  assert(typeof approvedPlanPath === "string" && isAbsolute(approvedPlanPath), "MAHOQUOT_APPROVED_PLAN must name an absolute path");
  const approvedBytes = await readFile(approvedPlanPath);
  const approvedDigest = sha256(approvedBytes);
  assert(
    approvedDigest === APPROVED_PLAN_SHA256 && approvedBytes.length === 93816,
    `canonical approved plan digest mismatch: expected ${APPROVED_PLAN_SHA256} (93816 bytes), got ${approvedDigest} (${approvedBytes.length} bytes)`
  );
  const approvedText = approvedBytes.toString("utf8");

  const planPath = process.env.MAHOQUOT_CLIPROXY_PLAN || resolve(ROOT, ".omo/plans/cliproxy-remediation-plan.md");
  assert(typeof planPath === "string" && isAbsolute(planPath), "MAHOQUOT_CLIPROXY_PLAN must name an absolute path");
  const liveBytes = await readFile(planPath);
  const liveText = liveBytes.toString("utf8");

  validatePlanContract(liveText, approvedText);
  const cases = taskCasesFromPlan(liveText);

  if (negative) {
    const negResult = await negativeReceiptTest(root, cases);
    const result = {
      audit,
      schema: "cliproxy-audit/v1",
      task_receipts: 1,
      cases: cases.length,
      negative_receipt_test: negResult,
      completed_at: new Date().toISOString()
    };
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${audit}-negative.json`), `${JSON.stringify(result, null, 2)}\n`);
    return true;
  }

  const receipts = await validateTaskReceipts(root, cases);
  await validateInventory(root, "route");
  await validateInventory(root, "setting");
  const result = {
    audit,
    schema: "cliproxy-audit/v1",
    task_receipts: receipts.length,
    cases: cases.length,
    completed_at: new Date().toISOString()
  };
  if (audit === "F1") {
    result.manifest_verified = true;
    result.inventory = ["route", "setting"];
  } else if (audit === "F2") {
    result.gates = await executeF2(root);
  } else if (audit === "F3") {
    result.behavior = await validateF3(root);
  } else {
    result.fidelity = await validateF4(root);
  }
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${audit}.json`), `${JSON.stringify(result, null, 2)}\n`);
  return true;
}

export const auditInternals = {
  getSourceClosure,
  runGate,
  taskCasesFromPlan,
  validatePlanContract,
  normalizeCheckboxes,
  stripOperationalAppendices,
  validateReceipt,
  validateAssertionSet,
  validateProvenance,
  validateTeardown,
  validateWire,
  validateEvents,
  validateInventory,
  validateF3,
  validateF4,
  negativeReceiptTest,
  approvedPlanSha256: APPROVED_PLAN_SHA256,
  RECEIPT_ASSERTIONS,
  FIXTURE_ASSERTIONS,
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  let audit = "F1";
  let evidenceRoot = "";
  let negative = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--audit") {
      audit = args[++i];
    } else if (arg === "--evidence-root") {
      evidenceRoot = args[++i];
    } else if (arg === "--negative" || arg === "--negative-receipt-test") {
      negative = true;
    }
  }
  if (!evidenceRoot) {
    evidenceRoot = resolve(ROOT, ".omo/evidence/cliproxy-remediation/6417c774-c554-4c53-880b-d8355082043e");
  }
  runAudit({ audit, evidenceRoot, negativeReceiptTest: negative })
    .then((res) => {
      console.log("Audit completed successfully:", res);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Audit failed:", err.message);
      process.exit(1);
    });
}

#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const EXPECTED_COMMIT = "21d75d08b38a23f97fbd534a1768a829cb147f2c";
const EXPECTED_SCOPE = [
  "reset-hardening",
  "scheduler",
  "usage-history",
  "cost-model",
  "agent-wiring",
  "os-integration",
  "account-mgmt",
  "logs-surface",
  "cross-platform-native-shell-parity",
  "totp-vault",
  "cloudflared-tunnel",
  "codex-multi-instance-launcher",
];
const ALLOWED = new Set(["covered", "partial", "missing-in-scope", "excluded-with-rationale"]);

function reject(code, detail) {
  console.error(JSON.stringify({ ok: false, error: code, detail }));
  process.exit(1);
}

const path = process.argv[2];
if (!path) reject("manifest_path_required", "pass one manifest path");
let manifest;
try {
  manifest = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  reject("manifest_json_invalid", error.message);
}
if (manifest.reference_commit !== EXPECTED_COMMIT) {
  reject("reference_commit_mismatch", `expected ${EXPECTED_COMMIT}`);
}
if (!Array.isArray(manifest.capabilities)) reject("capabilities_required", "capabilities must be an array");
const ids = new Set();
for (const row of manifest.capabilities) {
  for (const field of ["id", "reference", "current_state", "decision", "owner", "behavior_test", "notes"]) {
    if (typeof row[field] !== "string" || row[field].trim() === "") reject("row_field_required", `${row.id ?? "unknown"}.${field}`);
  }
  if (ids.has(row.id)) reject("duplicate_capability_id", row.id);
  ids.add(row.id);
  if (!ALLOWED.has(row.current_state)) reject("current_state_invalid", `${row.id}:${row.current_state}`);
  if (row.current_state !== "excluded-with-rationale" && (!row.owner.trim() || !row.behavior_test.trim())) {
    reject("in_scope_ownership_required", row.id);
  }
}
const declared = Array.isArray(manifest.scope_in) ? manifest.scope_in : [];
if (new Set(declared).size !== declared.length) reject("duplicate_scope_id", "scope_in");
const missingDeclared = EXPECTED_SCOPE.filter((id) => !declared.includes(id));
const extraDeclared = declared.filter((id) => !EXPECTED_SCOPE.includes(id));
if (missingDeclared.length || extraDeclared.length) reject("scope_coverage_mismatch", { missing: missingDeclared, extra: extraDeclared });
const missingRows = EXPECTED_SCOPE.filter((id) => !ids.has(id));
if (missingRows.length) reject("scope_capability_missing", missingRows);
for (const id of EXPECTED_SCOPE) {
  const row = manifest.capabilities.find((candidate) => candidate.id === id);
  if (row.current_state === "excluded-with-rationale") reject("scope_capability_excluded", id);
}
console.log("parity manifest valid");

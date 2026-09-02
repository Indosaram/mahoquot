#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) {
    console.error(JSON.stringify({ verdict: "reject", error: "invalid_arguments" }));
    process.exit(2);
  }
  args.set(key.slice(2), value);
}

const required = ["plan", "baseline", "desktop", "gateway", "output"];
const missingArgs = required.filter((key) => !args.has(key));
if (missingArgs.length > 0) {
  console.error(JSON.stringify({ verdict: "reject", error: "missing_arguments", missingArgs }));
  process.exit(2);
}

const planPath = resolve(args.get("plan"));
const baselinePath = resolve(args.get("baseline"));
const desktop = resolve(args.get("desktop"));
const gateway = resolve(args.get("gateway"));
const output = resolve(args.get("output"));

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const read = (path) => readFileSync(path, "utf8");
const fileHash = (path) => sha256(readFileSync(path));

const outOfScope = [];
const contradictions = [];
const overwrittenUserPaths = [];
const protectedTouchedUnverifiable = [];
const checks = {};

const baseline = JSON.parse(read(baselinePath));
for (const repository of baseline.repositories) {
  for (const row of repository.dirty_paths) {
    const path = join(repository.root, row.path);
    if (row.sha256_at_capture === "deleted") {
      if (existsSync(path)) overwrittenUserPaths.push(`${repository.name}:${row.path}:restored`);
      continue;
    }
    if (!existsSync(path)) {
      overwrittenUserPaths.push(`${repository.name}:${row.path}:missing`);
      continue;
    }
    if (fileHash(path) !== row.sha256_at_capture) {
      protectedTouchedUnverifiable.push(`${repository.name}:${row.path}`);
    }
  }
}
checks.dirtyWorktree = {
  protectedTouchedUnverifiable,
  overwrittenUserPaths,
};
if (protectedTouchedUnverifiable.length > 0) {
  contradictions.push("pre-existing content preservation is unprovable for protected touched paths");
}

const authoredFrontend = [
  join(desktop, "crates/monitor-ui/frontend/src/App.tsx"),
  join(desktop, "crates/monitor-ui/frontend/src/lib/onboarding.ts"),
  join(desktop, "crates/monitor-ui/frontend/src/lib/relay-plans.ts"),
].map(read).join("\n");
const translatedUi = /[가-힣]/u.test(authoredFrontend);
checks.i18n = { translatedUi };
if (translatedUi) outOfScope.push("translated UI copy or i18n content found");

const credentialBoundaryFiles = [
  join(gateway, "crates/gateway/src/management/creds.rs"),
  join(gateway, "crates/gateway/src/management/oauth.rs"),
  join(desktop, "crates/monitor-ui/frontend/src/lib/api.ts"),
  join(desktop, "crates/monitor-ui/frontend/src/lib/onboarding.ts"),
];
const forbiddenCredentialPatterns = [
  ".claude/.credentials.json",
  "Claude Code-credentials",
  ".zcode/v2/credentials.json",
  "ZCODE_DESKTOP_CREDENTIALS_FILE",
  ".cli-proxy-api",
];
const credentialHits = [];
for (const path of credentialBoundaryFiles) {
  const content = read(path);
  for (const pattern of forbiddenCredentialPatterns) {
    if (content.includes(pattern)) credentialHits.push(`${path}:${pattern}`);
  }
}
checks.credentialBoundary = { forbiddenReads: credentialHits };
if (credentialHits.length > 0) outOfScope.push("provider credential reads outside ~/.mahoquot/auth");

const appSource = read(join(desktop, "crates/monitor-ui/frontend/src/App.tsx"));
const primarySurfaceTuple = '["overview", "accounts", "logs", "settings"]';
const fourSurfaces = appSource.includes(primarySurfaceTuple) && !appSource.includes('["overview", "accounts", "agents", "logs", "settings"]');
checks.primarySurfaces = { fourSurfaces };
if (!fourSurfaces) outOfScope.push("top-level navigation differs from Overview/Accounts/Logs/Settings");

const nativeSource = `${read(join(desktop, "crates/monitor-ui/src/main.rs"))}\n${read(join(desktop, "crates/monitor-ui/src/notch.rs"))}`;
const physicalNotchHeuristic = nativeSource.includes("pick_notched_monitor_index") || nativeSource.includes("scale_factor >= 2.0");
checks.monitorSelection = { physicalNotchHeuristic };
if (physicalNotchHeuristic) outOfScope.push("physical-notch or high-DPI monitor heuristic remains active");

const desktopArtifact = join(desktop, "crates/monitor-ui/ui/index.html");
const gatewayArtifact = join(gateway, "ui/index.html");
const artifactHashes = { desktop: fileHash(desktopArtifact), gateway: fileHash(gatewayArtifact) };
checks.generatedArtifacts = { ...artifactHashes, match: artifactHashes.desktop === artifactHashes.gateway };
if (artifactHashes.desktop !== artifactHashes.gateway) outOfScope.push("embedded desktop and gateway artifacts differ");

const gnomeEvidencePath = join(desktop, ".omo/evidence/mass-ulw-mahoquot-parity/task-7-linux-gnome.json");
const gnomeEvidence = JSON.parse(read(gnomeEvidencePath));
const honestUnsupported = gnomeEvidence.status === "parity_unsupported" && gnomeEvidence.tray_only_fallback === false;
checks.platformDowngrade = { honestUnsupported };
if (!honestUnsupported) outOfScope.push("GNOME Wayland is silently downgraded or tray fallback is enabled");

const planDigest = fileHash(planPath);
const verdict = outOfScope.length === 0 && overwrittenUserPaths.length === 0 && contradictions.length === 0
  ? "approve"
  : "reject";
const result = {
  verdict,
  plan: planPath,
  planSha256: planDigest,
  out_of_scope: outOfScope,
  overwritten_user_paths: overwrittenUserPaths,
  protected_touched_unverifiable: protectedTouchedUnverifiable,
  contradictions,
  checks,
};

writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8" });
console.log(JSON.stringify(result));
process.exit(verdict === "approve" ? 0 : 1);

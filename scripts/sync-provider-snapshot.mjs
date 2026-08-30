#!/usr/bin/env bun
/**
 * Freeze the OpenCodex provider registry into a tracked snapshot.
 *
 * The parity gates compare Quotio's provider catalog against this snapshot
 * rather than against a sibling checkout, so `cargo test` and `vitest` stay
 * deterministic on a machine that has no OpenCodex clone. Refresh the snapshot
 * when the reference moves:
 *
 *   bun scripts/sync-provider-snapshot.mjs [path-to-opencodex]
 *
 * A drifted catalog then fails `provider-catalog.test.ts` with the exact field.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const referenceRoot = resolve(process.argv[2] ?? join(repoRoot, "..", "opencodex"));
const output = join(repoRoot, "docs/reference/opencodex-registry-snapshot.json");

const { PROVIDER_REGISTRY } = await import(join(referenceRoot, "src/providers/registry.ts"));

const providers = [...PROVIDER_REGISTRY]
  .map((entry) => ({
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    adapter: entry.adapter,
    authKind: entry.authKind,
    ...(entry.keyOptional === undefined ? {} : { keyOptional: entry.keyOptional }),
    ...(entry.staticHeaders === undefined ? {} : { staticHeaders: entry.staticHeaders }),
  }))
  .sort((left, right) => left.id.localeCompare(right.id));

const snapshot = {
  source: "opencodex/src/providers/registry.ts PROVIDER_REGISTRY",
  regenerate: "bun scripts/sync-provider-snapshot.mjs [path-to-opencodex]",
  providers,
};

writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`wrote ${providers.length} providers to ${output}`);

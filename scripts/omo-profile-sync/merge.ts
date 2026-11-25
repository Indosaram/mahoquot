// Pure merge of the shared omo profile (SOT) into one local models.json root.
// No I/O. Owned units: each `providers.mahoquot.models[]` entry keyed by `id`.
// compat is observed and hashed, never written. Nothing else is touched.
import { createHash } from "node:crypto";

export interface Profile {
  revision: number;
  compat: Record<string, unknown>;
  models: Array<Record<string, unknown> & { id: string }>;
  remove: string[];
}

/** Last-applied hash per unit key: "compat" or "model:<id>". */
export interface UnitState {
  units: Record<string, string>;
}

export type ConflictKind =
  | "locally-removed"
  | "unmanaged-differs"
  | "local-edit"
  | "duplicate-local-id";

export interface Change {
  key: string;
  action: "add" | "update" | "remove";
  before?: unknown;
  after?: unknown;
  reason?: "local-only" | "tombstone";
}

export interface Conflict {
  key: string;
  kind: ConflictKind;
  resolution?: "overwritten";
}

export interface MergeOptions {
  adoptSot?: boolean;
  /**
   * Ids the caller has proven unroutable. Only these local-only entries are
   * deleted; every other local-only entry is preserved and reported. Absence
   * from the SOT is not evidence of death, so the default is to delete nothing.
   */
  pruneable?: ReadonlySet<string>;
}

export interface MergeResult {
  root: unknown;
  changes: Change[];
  conflicts: Conflict[];
  /** Local-only ids kept because they were not proven unroutable. */
  retained?: Array<{ key: string; id: string }>;
  skipped?: string;
  /**
   * Every final-state unit is hashed, including read-only compat.
   * Removed or absent previously tracked units have null to drop their old hash.
   */
  hashes: Record<string, string | null>;
}

export function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** JSON with object keys sorted recursively; array order is preserved. */
export function canonicalJson(x: unknown): string {
  return JSON.stringify(sortKeys(x));
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (isPlainObject(x)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x).sort()) out[k] = sortKeys(x[k]);
    return out;
  }
  return x;
}

export function hashUnit(x: unknown): string {
  return createHash("sha256").update(canonicalJson(x)).digest("hex");
}

export function merge(
  localRoot: unknown,
  profile: Profile,
  state: UnitState,
  opts: MergeOptions = {},
): MergeResult {
  const adopt = opts.adoptSot === true;
  const pruneable = opts.pruneable ?? new Set<string>();
  const providers = isPlainObject(localRoot) ? localRoot.providers : undefined;
  const probe = isPlainObject(providers) ? providers.mahoquot : undefined;
  if (!isPlainObject(probe)) {
    return { root: localRoot, changes: [], conflicts: [], skipped: "no-mahoquot-provider", hashes: {} };
  }
  if (probe.models !== undefined && !Array.isArray(probe.models)) {
    return { root: localRoot, changes: [], conflicts: [], skipped: "invalid-models-array", hashes: {} };
  }

  const root = structuredClone(localRoot) as Record<string, unknown>;
  const mq = (root.providers as Record<string, unknown>).mahoquot as Record<string, unknown>;
  const changes: Change[] = [];
  const conflicts: Conflict[] = [];
  const hashes: Record<string, string | null> = {};
  const units = state.units ?? {};

  const modelIds = new Set(profile.models.map((m) => m.id));
  // An id listed in both `models` and `remove` is kept: never delete on ambiguity.
  const tombstones = profile.remove.filter((id) => !modelIds.has(id));

  // models[] is created lazily so an absent array stays absent when nothing is added.
  const localModels = (): unknown[] => {
    if (!Array.isArray(mq.models)) mq.models = [];
    return mq.models as unknown[];
  };

  // Report every extra occurrence, including local-only and tombstoned ids.
  if (Array.isArray(mq.models)) {
    const seen = new Set<string>();
    for (const m of mq.models) {
      if (!isPlainObject(m) || typeof m.id !== "string") continue;
      if (seen.has(m.id)) {
        conflicts.push({ key: `model:${m.id}`, kind: "duplicate-local-id" });
      }
      seen.add(m.id);
    }
  }

  // Shared decision table for one owned unit (SOT value present).
  const applyUnit = (
    key: string,
    present: boolean,
    localValue: unknown,
    sot: unknown,
    write: (action: "add" | "update") => void,
  ): void => {
    const h = units[key];
    const sh = hashUnit(sot);
    if (!present) {
      if (h !== undefined) conflicts.push({ key, kind: "locally-removed" });
      write("add");
      changes.push({ key, action: "add", after: sot });
      hashes[key] = sh;
      return;
    }
    const lh = hashUnit(localValue);
    const overwrite = () => {
      if (lh !== sh) {
        write("update");
        changes.push({ key, action: "update", before: localValue, after: sot });
      }
      hashes[key] = sh;
    };
    if (lh !== sh) {
      if (h === undefined) conflicts.push({ key, kind: "unmanaged-differs", resolution: "overwritten" });
      else if (lh !== h) conflicts.push({ key, kind: "local-edit", resolution: "overwritten" });
    }
    overwrite();
  };

  // Observe compat using its existing conflict policy, but never write it.
  if ("compat" in mq && mq.compat !== undefined) {
    const lh = hashUnit(mq.compat);
    const h = units.compat;
    hashes.compat = lh;
    if (!adopt) {
      if (h === undefined && lh !== hashUnit(profile.compat)) conflicts.push({ key: "compat", kind: "unmanaged-differs" });
      else if (h !== undefined && lh !== h) conflicts.push({ key: "compat", kind: "local-edit" });
    }
  } else {
    hashes.compat = null;
    if (units.compat !== undefined) conflicts.push({ key: "compat", kind: "locally-removed" });
  }

  // models in SOT order
  for (const sot of profile.models) {
    const indices = Array.isArray(mq.models)
      ? mq.models.flatMap((m, idx) => isPlainObject(m) && m.id === sot.id ? [idx] : [])
      : [];
    if (indices.length === 0) indices.push(-1);
    for (const idx of indices) {
      applyUnit(
        `model:${sot.id}`,
        idx >= 0,
        idx >= 0 ? (mq.models as unknown[])[idx] : undefined,
        sot,
        (action) => {
          if (action === "add") localModels().push(structuredClone(sot));
          else (mq.models as unknown[])[idx] = structuredClone(sot);
        },
      );
    }
  }

  // Classify each deletion in memory; the caller owns backups and file writes.
  // A tombstone is an explicit operator decision and is always honored. A
  // local-only entry is deleted only when the caller proved it unroutable.
  const removedIds = new Set(tombstones);
  const retained: Array<{ key: string; id: string }> = [];
  if (Array.isArray(mq.models)) {
    mq.models = mq.models.filter((local) => {
      if (!isPlainObject(local) || typeof local.id !== "string" || modelIds.has(local.id)) return true;
      const key = `model:${local.id}`;
      if (removedIds.has(local.id)) {
        changes.push({ key, action: "remove", before: local, reason: "tombstone" });
        hashes[key] = null;
        return false;
      }
      if (!pruneable.has(local.id)) {
        retained.push({ key, id: local.id });
        return true;
      }
      changes.push({ key, action: "remove", before: local, reason: "local-only" });
      hashes[key] = null;
      return false;
    });
  }
  for (const id of tombstones) hashes[`model:${id}`] = null;
  for (const key of Object.keys(units)) {
    if (key.startsWith("model:") && !modelIds.has(key.slice("model:".length))) hashes[key] = null;
  }

  return { root, changes, conflicts, retained, hashes };
}

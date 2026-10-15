// Pure merge of the shared omo profile (SOT) into one local models.json root.
// No I/O. Owned units: `providers.mahoquot.compat` and each
// `providers.mahoquot.models[]` entry keyed by `id`. Nothing else is touched.
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
}

export interface Conflict {
  key: string;
  kind: ConflictKind;
}

export interface MergeOptions {
  adoptSot?: boolean;
}

export interface MergeResult {
  root: unknown;
  changes: Change[];
  conflicts: Conflict[];
  skipped?: string;
  /**
   * Hash decisions for units that were applied, matched, or dropped in this
   * target: string = record as H, null = drop H. A unit that conflicted has no
   * entry, so its old H is kept.
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

function findFirst(models: unknown[], id: string): number {
  return models.findIndex((m) => isPlainObject(m) && m.id === id);
}

export function merge(
  localRoot: unknown,
  profile: Profile,
  state: UnitState,
  opts: MergeOptions = {},
): MergeResult {
  const adopt = opts.adoptSot === true;
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

  // Duplicate local ids: the first occurrence is the unit; report each managed id once.
  const managed = new Set<string>([...modelIds, ...tombstones]);
  if (Array.isArray(mq.models)) {
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const m of mq.models) {
      if (!isPlainObject(m) || typeof m.id !== "string") continue;
      if (seen.has(m.id) && managed.has(m.id) && !reported.has(m.id)) {
        reported.add(m.id);
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
      if (h === undefined) {
        write("add");
        changes.push({ key, action: "add", after: sot });
        hashes[key] = sh;
      } else {
        conflicts.push({ key, kind: "locally-removed" });
      }
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
    if (h === undefined) {
      if (lh === sh || adopt) overwrite();
      else conflicts.push({ key, kind: "unmanaged-differs" });
      return;
    }
    if (lh === h || adopt) overwrite();
    else conflicts.push({ key, kind: "local-edit" });
  };

  // compat
  applyUnit("compat", "compat" in mq && mq.compat !== undefined, mq.compat, profile.compat, () => {
    mq.compat = structuredClone(profile.compat);
  });

  // models in SOT order
  for (const sot of profile.models) {
    const idx = Array.isArray(mq.models) ? findFirst(mq.models, sot.id) : -1;
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

  // tombstones
  for (const id of tombstones) {
    const key = `model:${id}`;
    const idx = Array.isArray(mq.models) ? findFirst(mq.models, id) : -1;
    if (idx < 0) {
      hashes[key] = null;
      continue;
    }
    const models = mq.models as unknown[];
    const local = models[idx];
    const h = units[key];
    if (h !== undefined && hashUnit(local) === h) {
      // fall through to removal
    } else if (!adopt) {
      conflicts.push({ key, kind: h === undefined ? "unmanaged-differs" : "local-edit" });
      continue;
    }
    models.splice(idx, 1);
    changes.push({ key, action: "remove", before: local });
    hashes[key] = null;
  }

  return { root, changes, conflicts, hashes };
}

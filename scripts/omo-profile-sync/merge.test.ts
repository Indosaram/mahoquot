import { describe, expect, test } from "bun:test";
import { canonicalJson, hashUnit, merge, type Profile, type UnitState } from "./merge.ts";

const compatA = { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" };
const compatB = { sendSessionAffinityHeaders: false, sessionAffinityFormat: "openrouter" };
const modelA = { id: "probe-model-a", name: "Probe A", contextWindow: 8192, maxTokens: 1024 };
const modelA2 = { ...modelA, name: "Probe A v2", contextWindow: 16384 };
const modelB = { id: "probe-model-b", name: "Probe B" };
const modelC = { id: "probe-model-c", name: "Probe C" };

function root(models: unknown[], compat: unknown = compatA) {
  return {
    disabledProviders: ["gone-provider"],
    unknown: { keep: true },
    providers: {
      other: { models: [{ id: "other-model" }] },
      mahoquot: { api: "openai-completions", apiKey: "secret", baseUrl: "http://gw.invalid/v1", name: "mahoquot", compat, models },
    },
  };
}
function profile(over: Partial<Profile> = {}): Profile {
  return { revision: 1, compat: compatA, models: [modelA], remove: [], ...over };
}
function state(units: Record<string, unknown> = {}): UnitState {
  return { units: Object.fromEntries(Object.entries(units).map(([k, v]) => [k, hashUnit(v)])) };
}
function models(r: { root: unknown }): unknown[] {
  return (r.root as ReturnType<typeof root>).providers.mahoquot.models;
}

describe("hashing", () => {
  test("canonical json sorts keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 0 } })).toBe('{"a":{"c":0,"d":[2,1]},"b":1}');
    expect(hashUnit({ a: 1, b: 2 })).toBe(hashUnit({ b: 2, a: 1 }));
    expect(hashUnit([1, 2])).not.toBe(hashUnit([2, 1]));
  });
});

describe("SOT-authoritative decision table", () => {
  test("adds absent models in SOT order without adding absent compat", () => {
    const local: any = root([]);
    delete local.providers.mahoquot.compat;
    const r = merge(local, profile({ models: [modelB, modelA] }), state());
    expect(models(r)).toEqual([modelB, modelA]);
    expect(r.changes.map((c) => c.action)).toEqual(["add", "add"]);
    expect((r.root as any).providers.mahoquot).not.toHaveProperty("compat");
    expect(r.hashes.compat).toBeNull();
  });

  test("does not mutate the input root, SOT, or hash state", () => {
    const local = root([modelA2, modelB]);
    const sot = profile({ remove: [modelB.id] });
    const previous = state({ [`model:${modelA.id}`]: modelA });
    const before = JSON.stringify([local, sot, previous]);
    merge(local, sot, previous);
    expect(JSON.stringify([local, sot, previous])).toBe(before);
  });

  test("updates an unedited managed model without changing compat", () => {
    const r = merge(root([modelA]), profile({ models: [modelA2], compat: compatB }), state({ compat: compatA, [`model:${modelA.id}`]: modelA }));
    expect(models(r)).toEqual([modelA2]);
    expect((r.root as any).providers.mahoquot.compat).toEqual(compatA);
    expect(r.changes.map((c) => c.action)).toEqual(["update"]);
    expect(r.conflicts).toEqual([]);
  });

  test("unchanged profile is a no-op", () => {
    const local = root([modelA]);
    const r = merge(local, profile(), state({ compat: compatA, [`model:${modelA.id}`]: modelA }));
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(canonicalJson(r.root)).toBe(canonicalJson(local));
  });

  test("seed machine records matching units without changes", () => {
    const r = merge(root([modelA]), profile(), state());
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.hashes).toEqual({ compat: hashUnit(compatA), [`model:${modelA.id}`]: hashUnit(modelA) });
  });

  test("locally-removed is re-added with no revision gate", () => {
    for (const revision of [0, 1, 19]) {
      const r = merge(root([]), profile({ revision }), state({ [`model:${modelA.id}`]: modelA }));
      expect(models(r)).toEqual([modelA]);
      expect(r.conflicts).toContainEqual({ key: `model:${modelA.id}`, kind: "locally-removed" });
      expect(r.hashes[`model:${modelA.id}`]).toBe(hashUnit(modelA));
    }
  });

  test("same-revision deletion after a successful merge is restored", () => {
    const first = merge(root([]), profile(), state());
    const second = merge(root([]), profile(), { units: first.hashes as Record<string, string> });
    expect(models(second)).toEqual([modelA]);
    expect(second.changes[0]?.action).toBe("add");
  });

  test("unmanaged-differs is overwritten rather than pruned", () => {
    const r = merge(root([modelA2]), profile(), state());
    expect(models(r)).toEqual([modelA]);
    expect(r.conflicts).toEqual([{ key: `model:${modelA.id}`, kind: "unmanaged-differs", resolution: "overwritten" }]);
    expect(r.changes[0]?.action).toBe("update");
  });

  test("local-only entries are retained unless proven unroutable", () => {
    const r = merge(root([modelB, modelC]), profile(), state());
    expect(models(r)).toEqual([modelB, modelC, modelA]);
    expect(r.changes.filter((c) => c.action === "remove")).toEqual([]);
    expect(r.retained).toEqual([
      { key: `model:${modelB.id}`, id: modelB.id },
      { key: `model:${modelC.id}`, id: modelC.id },
    ]);
  });

  test("a proven-unroutable local-only entry is the only thing deleted", () => {
    const r = merge(root([modelB, modelC]), profile(), state(), { pruneable: new Set([modelC.id]) });
    expect(models(r)).toEqual([modelB, modelA]);
    expect(r.changes.filter((c) => c.action === "remove")).toEqual([
      { key: `model:${modelC.id}`, action: "remove", before: modelC, reason: "local-only" },
    ]);
    expect(r.retained).toEqual([{ key: `model:${modelB.id}`, id: modelB.id }]);
    expect(r.hashes[`model:${modelC.id}`]).toBeNull();
  });

  test("local-edit is overwritten and reported as overwritten", () => {
    const edited = { ...modelA, name: "hand" };
    const r = merge(root([edited]), profile({ models: [modelA2] }), state({ [`model:${modelA.id}`]: modelA }));
    expect(models(r)).toEqual([modelA2]);
    expect(r.conflicts).toEqual([{ key: `model:${modelA.id}`, kind: "local-edit", resolution: "overwritten" }]);
    expect(r.hashes[`model:${modelA.id}`]).toBe(hashUnit(modelA2));
  });

  test("hashes cover all final units and drop every stale tracked model", () => {
    const r = merge(root([modelA2, modelC], compatB), profile({ models: [modelA, modelB] }), state({ "model:already-gone": {}, [`model:${modelA.id}`]: modelA }), { pruneable: new Set([modelC.id]) });
    expect(r.hashes).toEqual({ compat: hashUnit(compatB), [`model:${modelA.id}`]: hashUnit(modelA), [`model:${modelB.id}`]: hashUnit(modelB), [`model:${modelC.id}`]: null, "model:already-gone": null });
  });

  test("a second merge using final hashes is a no-op", () => {
    const first = merge(root([modelA2, modelB]), profile(), state());
    const units = Object.fromEntries(Object.entries(first.hashes).filter((entry): entry is [string, string] => entry[1] !== null));
    const second = merge(first.root, profile(), { units });
    expect(second.changes).toEqual([]);
    expect(second.conflicts).toEqual([]);
  });

  test("existing models keep their order and new models append", () => {
    const r = merge(root([modelB, modelA, { id: "local-only" }]), profile({ models: [modelA2, modelB, modelC] }), state());
    expect(models(r)).toEqual([modelB, modelA2, { id: "local-only" }, modelC]);
  });
});

describe("duplicates", () => {
  test("every SOT duplicate is updated, with a report for each extra occurrence", () => {
    const r = merge(root([modelA, { ...modelA, name: "second" }, { ...modelA, name: "third" }]), profile({ models: [modelA2] }), state({ [`model:${modelA.id}`]: modelA }));
    expect(models(r)).toEqual([modelA2, modelA2, modelA2]);
    expect(r.changes).toHaveLength(3);
    expect(r.conflicts.filter((c) => c.kind === "duplicate-local-id")).toHaveLength(2);
    expect(r.hashes[`model:${modelA.id}`]).toBe(hashUnit(modelA2));
  });

  test("local-only duplicates are retained unless proven unroutable", () => {
    const r = merge(root([modelB, { ...modelB, name: "second" }, modelB]), profile({ models: [] }), state());
    expect(models(r)).toHaveLength(3);
    expect(r.changes.filter((c) => c.reason === "local-only")).toHaveLength(0);
    expect(r.conflicts.filter((c) => c.kind === "duplicate-local-id")).toHaveLength(2);
    expect(r.retained).toHaveLength(3);
  });

  test("all proven-unroutable local-only duplicates are deleted", () => {
    const r = merge(root([modelB, { ...modelB, name: "second" }, modelB]), profile({ models: [] }), state(), { pruneable: new Set([modelB.id]) });
    expect(models(r)).toEqual([]);
    expect(r.changes.filter((c) => c.reason === "local-only")).toHaveLength(3);
    expect(r.conflicts.filter((c) => c.kind === "duplicate-local-id")).toHaveLength(2);
  });

  test("all tombstoned duplicates are deleted regardless of hashes", () => {
    const r = merge(root([modelB, { ...modelB, name: "edited" }, modelB]), profile({ models: [], remove: [modelB.id] }), state({ [`model:${modelB.id}`]: modelB }));
    expect(models(r)).toEqual([]);
    expect(r.changes.filter((c) => c.reason === "tombstone")).toHaveLength(3);
    expect(r.hashes[`model:${modelB.id}`]).toBeNull();
  });
});

describe("tombstones", () => {
  test("deletes unedited, edited, and never-managed models unconditionally", () => {
    for (const previous of [state(), state({ [`model:${modelC.id}`]: modelC }), state({ [`model:${modelC.id}`]: { ...modelC, name: "previous" } })]) {
      const r = merge(root([modelC]), profile({ models: [], remove: [modelC.id] }), previous);
      expect(models(r)).toEqual([]);
      expect(r.conflicts).toEqual([]);
      expect(r.changes).toEqual([{ key: `model:${modelC.id}`, action: "remove", before: modelC, reason: "tombstone" }]);
      expect(r.hashes[`model:${modelC.id}`]).toBeNull();
    }
  });

  test("an absent tombstone drops its hash without changes", () => {
    const r = merge(root([]), profile({ models: [], remove: [modelC.id] }), state({ [`model:${modelC.id}`]: modelC }));
    expect(r.changes).toEqual([]);
    expect(r.hashes[`model:${modelC.id}`]).toBeNull();
  });

  test("models takes precedence when an id also occurs in remove", () => {
    const r = merge(root([modelA]), profile({ remove: [modelA.id] }), state());
    expect(models(r)).toEqual([modelA]);
    expect(r.changes).toEqual([]);
  });
});

describe("read-only compat and unowned content", () => {
  test("compat is returned byte-identical even when SOT differs and adoptSot is enabled", () => {
    const compat = { z: { custom: [3, 1] }, supportsReasoningEffort: false, ...compatB };
    for (const adoptSot of [false, true]) {
      const r = merge(root([modelA2], compat), profile(), state({ compat: compatA }), { adoptSot });
      expect(JSON.stringify((r.root as any).providers.mahoquot.compat)).toBe(JSON.stringify(compat));
      expect(r.hashes.compat).toBe(hashUnit(compat));
      expect(r.changes.some((c) => c.key === "compat")).toBe(false);
    }
  });

  test("compat retains local-edit conflict detection", () => {
    const r = merge(root([modelA], compatB), profile(), state({ compat: compatA }));
    expect(r.conflicts).toEqual([{ key: "compat", kind: "local-edit" }]);
  });

  test("adoptSot still restores missing models and reports overwritten local edits", () => {
    const r = merge(root([modelA2]), profile({ models: [modelA, modelB] }), state({ [`model:${modelA.id}`]: modelA, [`model:${modelB.id}`]: modelB }), { adoptSot: true });
    expect(models(r)).toEqual([modelA, modelB]);
    expect(r.conflicts).toContainEqual({ key: `model:${modelA.id}`, kind: "local-edit", resolution: "overwritten" });
  });

  test("other providers and non-model fields remain unchanged", () => {
    const local = root([modelB]);
    const r = merge(local, profile(), state());
    const withoutModels = (value: unknown) => {
      const copy = structuredClone(value) as ReturnType<typeof root>;
      copy.providers.mahoquot.models = [];
      return copy;
    };
    expect(withoutModels(r.root)).toEqual(withoutModels(local));
  });

  test("missing or invalid provider is skipped and never created", () => {
    for (const provider of [undefined, "str", [], null]) {
      const local = { providers: { mahoquot: provider } };
      const r = merge(local, profile(), state());
      expect(r.skipped).toBe("no-mahoquot-provider");
      expect(r.root).toBe(local);
      expect(r.hashes).toEqual({});
    }
    expect(merge({}, profile(), state()).skipped).toBe("no-mahoquot-provider");
    expect(merge(null, profile(), state()).skipped).toBe("no-mahoquot-provider");
  });

  test("invalid models array is skipped", () => {
    const local = { providers: { mahoquot: { models: {} } } };
    const r = merge(local, profile(), state());
    expect(r.skipped).toBe("invalid-models-array");
    expect(r.root).toBe(local);
  });
});

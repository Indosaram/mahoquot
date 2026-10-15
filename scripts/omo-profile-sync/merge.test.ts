import { describe, expect, test } from "bun:test";
import { canonicalJson, hashUnit, merge, type Profile, type UnitState } from "./merge.ts";

const compatA = { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" };
const compatB = { sendSessionAffinityHeaders: false, sessionAffinityFormat: "openrouter" };
const modelA = { id: "probe-model-a", name: "Probe A", contextWindow: 8192, maxTokens: 1024 };
const modelA2 = { id: "probe-model-a", name: "Probe A v2", contextWindow: 16384, maxTokens: 2048 };
const modelB = { id: "probe-model-b", name: "Probe B", contextWindow: 4096, maxTokens: 512 };
const modelC = { id: "probe-model-c", name: "Probe C" };

function root(mahoquot: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  const providers: Record<string, unknown> = {
    other: { api: "openai-completions", apiKey: "k-other", baseUrl: "https://other.invalid", models: [{ id: "other-model" }] },
  };
  if (mahoquot) providers.mahoquot = mahoquot;
  return { disabledProviders: ["gone-provider"], providers, ...extra };
}

function mq(models: unknown[], compat: unknown = compatA) {
  return { api: "openai-completions", apiKey: "mq-secret", baseUrl: "http://gw.invalid:1/v1", name: "mahoquot", compat, models };
}

function profile(over: Partial<Profile> = {}): Profile {
  return { revision: 1, compat: compatA, models: [modelA], remove: [], ...over };
}

function state(units: Record<string, unknown> = {}): UnitState {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(units)) out[k] = hashUnit(v);
  return { units: out };
}

function ids(r: { root: unknown }): string[] {
  return ((r.root as any).providers.mahoquot.models as Array<{ id: string }>).map((m) => m.id);
}

describe("hashing", () => {
  test("canonical json sorts keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 0 } })).toBe('{"a":{"c":0,"d":[2,1]},"b":1}');
    expect(hashUnit({ a: 1, b: 2 })).toBe(hashUnit({ b: 2, a: 1 }));
    expect(hashUnit([1, 2])).not.toBe(hashUnit([2, 1]));
  });
});

describe("add / update / no-op", () => {
  test("adds an absent model and compat at the end in SOT order and records hashes", () => {
    const local = root({ ...mq([{ id: "local-only" }]), compat: undefined });
    delete (local.providers.mahoquot as any).compat;
    const r = merge(local, profile({ models: [modelB, modelA] }), state());
    expect(ids(r)).toEqual(["local-only", "probe-model-b", "probe-model-a"]);
    expect((r.root as any).providers.mahoquot.compat).toEqual(compatA);
    expect(r.changes.map((c) => `${c.action}:${c.key}`)).toEqual([
      "add:compat",
      "add:model:probe-model-b",
      "add:model:probe-model-a",
    ]);
    expect(r.conflicts).toEqual([]);
    expect(r.hashes["model:probe-model-a"]).toBe(hashUnit(modelA));
    expect(r.hashes.compat).toBe(hashUnit(compatA));
  });

  test("does not mutate the input root", () => {
    const local = root(mq([]));
    const before = canonicalJson(local);
    merge(local, profile(), state());
    expect(canonicalJson(local)).toBe(before);
  });

  test("updates a managed unit whose local copy still equals the last applied hash", () => {
    const local = root(mq([modelA]));
    const r = merge(local, profile({ models: [modelA2], compat: compatB }), state({ compat: compatA, "model:probe-model-a": modelA }));
    expect((r.root as any).providers.mahoquot.models[0]).toEqual(modelA2);
    expect((r.root as any).providers.mahoquot.compat).toEqual(compatB);
    expect(r.changes.map((c) => c.action)).toEqual(["update", "update"]);
    expect(r.conflicts).toEqual([]);
    expect(r.hashes["model:probe-model-a"]).toBe(hashUnit(modelA2));
  });

  test("unchanged profile is a no-op with equal canonical output", () => {
    const local = root(mq([modelA]));
    const r = merge(local, profile(), state({ compat: compatA, "model:probe-model-a": modelA }));
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(canonicalJson(r.root)).toBe(canonicalJson(local));
  });

  test("seed machine: local equals SOT and no hash yet records hashes without changes", () => {
    const local = root(mq([modelA]));
    const r = merge(local, profile(), state());
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.hashes).toEqual({ compat: hashUnit(compatA), "model:probe-model-a": hashUnit(modelA) });
  });
});

describe("conflicts", () => {
  test("locally-removed: managed unit absent locally is not re-added", () => {
    const r = merge(root(mq([])), profile(), state({ compat: compatA, "model:probe-model-a": modelA }));
    expect(r.conflicts).toEqual([{ key: "model:probe-model-a", kind: "locally-removed" }]);
    expect(ids(r)).toEqual([]);
    expect("model:probe-model-a" in r.hashes).toBe(false);
  });

  test("unmanaged-differs: local copy differs and was never managed", () => {
    const r = merge(root(mq([{ ...modelA, name: "hand" }])), profile(), state({ compat: compatA }));
    expect(r.conflicts).toEqual([{ key: "model:probe-model-a", kind: "unmanaged-differs" }]);
    expect((r.root as any).providers.mahoquot.models[0].name).toBe("hand");
    expect(r.changes).toEqual([]);
  });

  test("local-edit: hand edit after the last sync is kept for a model and for compat", () => {
    const edited = { ...modelA, name: "hand" };
    const local = root(mq([edited], { ...compatA, extra: 1 }));
    const r = merge(local, profile({ models: [modelA2], compat: compatB }), state({ compat: compatA, "model:probe-model-a": modelA }));
    expect(r.conflicts.map((c) => `${c.kind}:${c.key}`).sort()).toEqual(["local-edit:compat", "local-edit:model:probe-model-a"]);
    expect(canonicalJson(r.root)).toBe(canonicalJson(local));
    expect(r.changes).toEqual([]);
  });

  test("duplicate-local-id: first occurrence is the unit, later copies untouched, reported once", () => {
    const dup1 = { ...modelA };
    const dup2 = { ...modelA, name: "dup-second" };
    const dup3 = { ...modelA, name: "dup-third" };
    const local = root(mq([dup1, dup2, dup3]));
    const r = merge(local, profile({ models: [modelA2] }), state({ compat: compatA, "model:probe-model-a": modelA }));
    const models = (r.root as any).providers.mahoquot.models;
    expect(models[0]).toEqual(modelA2);
    expect(models[1]).toEqual(dup2);
    expect(models[2]).toEqual(dup3);
    expect(r.conflicts).toEqual([{ key: "model:probe-model-a", kind: "duplicate-local-id" }]);
  });
});

describe("adoptSot", () => {
  test("overrides unmanaged-differs and local-edit but keeps a locally-removed conflict", () => {
    const local = root(mq([{ ...modelA, name: "hand" }], { sendSessionAffinityHeaders: "x" }));
    const r = merge(local, profile({ models: [modelA, modelB] }), state({ "model:probe-model-b": modelB }), { adoptSot: true });
    expect((r.root as any).providers.mahoquot.models[0]).toEqual(modelA);
    expect((r.root as any).providers.mahoquot.compat).toEqual(compatA);
    expect(ids(r)).toEqual(["probe-model-a"]);
    expect(r.conflicts).toEqual([{ key: "model:probe-model-b", kind: "locally-removed" }]);
    expect(r.hashes.compat).toBe(hashUnit(compatA));
  });

  test("local-edit on a managed model is overwritten and rehashed", () => {
    const r = merge(root(mq([{ ...modelA, name: "hand" }])), profile(), state({ compat: compatA, "model:probe-model-a": modelA }), { adoptSot: true });
    expect((r.root as any).providers.mahoquot.models[0]).toEqual(modelA);
    expect(r.conflicts).toEqual([]);
  });

  test("tombstone removes an edited or unmanaged model", () => {
    const local = root(mq([{ ...modelC, name: "hand" }, modelB]));
    const r = merge(local, profile({ models: [], remove: ["probe-model-c"] }), state({ "model:probe-model-c": modelC }), { adoptSot: true });
    expect(ids(r)).toEqual(["probe-model-b"]);
    expect(r.hashes["model:probe-model-c"]).toBeNull();
  });
});

describe("tombstones", () => {
  test("removes an unedited managed model and drops its hash", () => {
    const r = merge(root(mq([modelB, modelC])), profile({ models: [], remove: ["probe-model-c"] }), state({ "model:probe-model-c": modelC }));
    expect(ids(r)).toEqual(["probe-model-b"]);
    expect(r.changes).toEqual([{ key: "model:probe-model-c", action: "remove", before: modelC }]);
    expect(r.hashes["model:probe-model-c"]).toBeNull();
  });

  test("a locally edited managed model is kept with a local-edit conflict", () => {
    const edited = { ...modelC, name: "hand" };
    const r = merge(root(mq([edited])), profile({ models: [], remove: ["probe-model-c"] }), state({ "model:probe-model-c": modelC }));
    expect(ids(r)).toEqual(["probe-model-c"]);
    expect(r.conflicts).toEqual([{ key: "model:probe-model-c", kind: "local-edit" }]);
    expect("model:probe-model-c" in r.hashes).toBe(false);
  });

  test("a never-managed local model is kept with an unmanaged-differs conflict", () => {
    const r = merge(root(mq([modelC])), profile({ models: [], remove: ["probe-model-c"] }), state());
    expect(ids(r)).toEqual(["probe-model-c"]);
    expect(r.conflicts).toEqual([{ key: "model:probe-model-c", kind: "unmanaged-differs" }]);
  });

  test("an id already absent locally just drops its hash", () => {
    const r = merge(root(mq([modelB])), profile({ models: [], remove: ["probe-model-c"] }), state({ "model:probe-model-c": modelC }));
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.hashes["model:probe-model-c"]).toBeNull();
  });

  test("local ids absent from both models and remove are never touched", () => {
    const local = root(mq([modelB, { id: "local-only" }]));
    const r = merge(local, profile({ models: [modelA], remove: [] }), state());
    expect(ids(r)).toEqual(["probe-model-b", "local-only", "probe-model-a"]);
  });

  test("an id listed in both models and remove is never deleted", () => {
    const r = merge(root(mq([modelA])), profile({ models: [modelA], remove: ["probe-model-a"] }), state({ compat: compatA, "model:probe-model-a": modelA }));
    expect(ids(r)).toEqual(["probe-model-a"]);
  });
});

describe("unowned content stays equal", () => {
  test("other providers, apiKey, baseUrl, name, api, disabledProviders, unknown keys and local-only models", () => {
    const local = root(
      { ...mq([{ id: "local-only", custom: { z: 1, a: 2 } }]), unknownKey: { keep: true } },
      { someTopLevel: [1, 2, 3] },
    );
    const r = merge(local, profile({ models: [modelA, modelB], compat: compatB }), state());
    const strip = (x: any) => {
      const c = structuredClone(x);
      delete c.providers.mahoquot.models;
      delete c.providers.mahoquot.compat;
      return c;
    };
    expect(canonicalJson(strip(r.root))).toBe(canonicalJson(strip(local)));
    expect((r.root as any).providers.mahoquot.models[0]).toEqual({ id: "local-only", custom: { z: 1, a: 2 } });
    expect(Object.keys((r.root as any).providers.mahoquot)).toEqual(Object.keys(local.providers.mahoquot));
  });
});

describe("missing provider", () => {
  test("skips with no-mahoquot-provider and never creates it", () => {
    for (const bad of [undefined, "str", [], null]) {
      const local = root(undefined);
      if (bad !== undefined) (local.providers as any).mahoquot = bad;
      const r = merge(local, profile(), state());
      expect(r.skipped).toBe("no-mahoquot-provider");
      expect(r.changes).toEqual([]);
      expect(r.hashes).toEqual({});
      expect(canonicalJson(r.root)).toBe(canonicalJson(local));
    }
    expect(merge({}, profile(), state()).skipped).toBe("no-mahoquot-provider");
    expect(merge(null, profile(), state()).skipped).toBe("no-mahoquot-provider");
  });
});

describe("order preservation", () => {
  test("existing models keep their order when updated and new ones are appended", () => {
    const local = root(mq([modelB, modelA, { id: "local-only" }]));
    const r = merge(
      local,
      profile({ models: [modelA2, modelB, modelC] }),
      state({ compat: compatA, "model:probe-model-a": modelA, "model:probe-model-b": modelB }),
    );
    expect(ids(r)).toEqual(["probe-model-b", "probe-model-a", "local-only", "probe-model-c"]);
    expect((r.root as any).providers.mahoquot.models[1]).toEqual(modelA2);
  });
});

import { describe, expect, it } from "vitest";
import { isModelDisabled, withModelDisabled } from "../components/ProviderModelsPanel";
import type { ExcludedModels } from "../lib/schemas";

describe("model exclusion helpers", () => {
  it("reads a disabled model from the provider's own list", () => {
    const excluded: ExcludedModels = { inferx: ["minimax-m2"], claude: ["claude-opus-5"] };
    expect(isModelDisabled(excluded, "inferx", "minimax-m2")).toBe(true);
    expect(isModelDisabled(excluded, "inferx", "minimax-m3")).toBe(false);
    expect(isModelDisabled(excluded, "claude", "minimax-m2")).toBe(false);
    expect(isModelDisabled(excluded, "codex", "anything")).toBe(false);
  });

  it("adds a model to the provider's list without disturbing others", () => {
    const before: ExcludedModels = { claude: ["claude-opus-5"] };
    const after = withModelDisabled(before, "inferx", "minimax-m2", true);
    expect(after).toEqual({ claude: ["claude-opus-5"], inferx: ["minimax-m2"] });
    expect(before).toEqual({ claude: ["claude-opus-5"] });
  });

  it("removes a model and drops the provider key when its list empties", () => {
    const before: ExcludedModels = { inferx: ["minimax-m2", "minimax-m3"] };
    const after = withModelDisabled(before, "inferx", "minimax-m2", false);
    expect(after).toEqual({ inferx: ["minimax-m3"] });
    expect(withModelDisabled(after, "inferx", "minimax-m3", false)).toEqual({});
  });

  it("keeps an already-disabled model in place rather than duplicating it", () => {
    const before: ExcludedModels = { inferx: ["minimax-m2"] };
    expect(withModelDisabled(before, "inferx", "minimax-m2", true)).toEqual({
      inferx: ["minimax-m2"],
    });
  });

  it("treats an absent provider key as an empty list", () => {
    expect(withModelDisabled({}, "inferx", "minimax-m2", false)).toEqual({});
  });
});

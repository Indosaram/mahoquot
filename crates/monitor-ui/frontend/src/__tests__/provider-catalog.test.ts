import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { providerLogos } from "../components/ProviderGlyph";
import {
  OPENCODEX_TO_QUOTIO_ALIASES,
  PROVIDER_CATALOG,
  PROVIDER_CATALOG_BY_ID,
  PROVIDER_IDS,
  QUOTIO_TO_OPENCODEX_ALIASES,
  TOTAL_PROVIDER_COUNT,
  getProviderCatalogEntry,
  getProviderPreset,
  isKnownProviderId,
  normalizeProviderAlias,
  normalizeToOpenCodexProviderId,
  normalizeToQuotioProviderId,
} from "../lib/provider-catalog";

interface ReferenceProvider {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly adapter: string;
  readonly authKind: string;
  readonly keyOptional?: boolean;
  readonly staticHeaders?: Record<string, string>;
}

describe("provider-catalog", () => {
  it("provides a brand icon for every catalog and dedicated onboarding provider", () => {
    const dedicatedProviderIds = [
      "codex",
      "claude",
      "antigravity",
      "gemini-cli",
      "qwen",
      "github-copilot",
      "command-code",
      "vertex",
      "iflow",
      "trae",
      "zcode",
    ];
    const providerIds = [...PROVIDER_IDS, ...dedicatedProviderIds];
    const missing = [...new Set(providerIds)].filter((provider) => !providerLogos[provider]);

    expect(missing).toEqual([]);
  });

  it("exports exactly 81 unique production provider IDs", () => {
    expect(PROVIDER_CATALOG).toHaveLength(81);
    expect(TOTAL_PROVIDER_COUNT).toBe(81);
    expect(PROVIDER_IDS).toHaveLength(81);
    expect(Object.keys(PROVIDER_CATALOG_BY_ID)).toHaveLength(81);

    const uniqueIds = new Set(PROVIDER_IDS);
    expect(uniqueIds.size).toBe(81);
  });

  it("ensures every catalog row has strict required fields and valid authKind", () => {
    const validAuthKinds = new Set(["forward", "oauth", "key", "local"]);

    for (const entry of PROVIDER_CATALOG) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.trim()).toBe(entry.id);
      expect(entry.id.length).toBeGreaterThan(0);

      expect(typeof entry.label).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);

      expect(validAuthKinds.has(entry.authKind)).toBe(true);

      expect(typeof entry.adapter).toBe("string");
      expect(entry.adapter.length).toBeGreaterThan(0);

      expect(typeof entry.baseUrl).toBe("string");
      expect(entry.baseUrl.length).toBeGreaterThan(0);

      expect(Array.isArray(entry.models)).toBe(true);
      for (const m of entry.models) {
        expect(typeof m).toBe("string");
      }

      if (entry.defaultModel !== undefined) {
        expect(typeof entry.defaultModel).toBe("string");
        expect(entry.defaultModel.length).toBeGreaterThan(0);
      }
    }
  });

  it("contains major production providers with exact metadata", () => {
    const openai = PROVIDER_CATALOG_BY_ID.openai;
    expect(openai).toBeDefined();
    expect(openai?.label).toBe("OpenAI (Codex login)");
    expect(openai?.authKind).toBe("forward");
    expect(openai?.adapter).toBe("openai-responses");
    expect(openai?.baseUrl).toBe("https://chatgpt.com/backend-api/codex");

    const anthropic = PROVIDER_CATALOG_BY_ID.anthropic;
    expect(anthropic).toBeDefined();
    expect(anthropic?.label).toBe("Anthropic Claude");
    expect(anthropic?.authKind).toBe("oauth");
    expect(anthropic?.adapter).toBe("anthropic");
    expect(anthropic?.defaultModel).toBe("claude-sonnet-5");
    expect(anthropic?.models).toContain("claude-opus-5");

    const antigravity = PROVIDER_CATALOG_BY_ID["google-antigravity"];
    expect(antigravity).toBeDefined();
    expect(antigravity?.label).toBe("Google Antigravity");
    expect(antigravity?.authKind).toBe("oauth");
    expect(antigravity?.adapter).toBe("google");
    expect(antigravity?.defaultModel).toBe("gemini-3.7-flash");

    const zai = PROVIDER_CATALOG_BY_ID.zai;
    expect(zai).toBeDefined();
    expect(zai?.label).toBe("Z.AI — GLM Coding Plan");
    expect(zai?.authKind).toBe("key");
    expect(zai?.adapter).toBe("openai-chat");
    expect(zai?.defaultModel).toBe("glm-5.3");
    expect(zai?.models).toContain("glm-5.3");

    const cursor = PROVIDER_CATALOG_BY_ID.cursor;
    expect(cursor).toBeDefined();
    expect(cursor?.authKind).toBe("oauth");
    expect(cursor?.adapter).toBe("cursor");
    expect(cursor?.defaultModel).toBe("auto");
    expect(cursor?.models.length).toBeGreaterThan(50);
  });

  describe("normalized alias helpers", () => {
    it("normalizes OpenCodex IDs to Quotio IDs via normalizeToQuotioProviderId / normalizeProviderAlias", () => {
      expect(normalizeToQuotioProviderId("openai")).toBe("codex");
      expect(normalizeToQuotioProviderId("anthropic")).toBe("claude");
      expect(normalizeToQuotioProviderId("google-antigravity")).toBe("antigravity");
      expect(normalizeToQuotioProviderId("zai")).toBe("zcode");
      expect(normalizeToQuotioProviderId("glm")).toBe("zcode");
      expect(normalizeToQuotioProviderId("zhipu-bigmodel")).toBe("zcode");
      expect(normalizeToQuotioProviderId("zhipu-bigmodel-coding")).toBe("zcode");

      // Check alias export
      expect(normalizeProviderAlias("openai")).toBe("codex");
      expect(normalizeProviderAlias("anthropic")).toBe("claude");
      expect(normalizeProviderAlias("google-antigravity")).toBe("antigravity");
      expect(normalizeProviderAlias("zai")).toBe("zcode");
      expect(normalizeProviderAlias("glm")).toBe("zcode");

      // Non-aliased pass-through
      expect(normalizeToQuotioProviderId("cursor")).toBe("cursor");
      expect(normalizeToQuotioProviderId("xai")).toBe("xai");
      expect(normalizeToQuotioProviderId("deepseek")).toBe("deepseek");

      // Whitespace and case insensitivity
      expect(normalizeToQuotioProviderId("  OPENAI  ")).toBe("codex");
      expect(normalizeToQuotioProviderId("Anthropic")).toBe("claude");
      expect(normalizeToQuotioProviderId("Google-Antigravity")).toBe("antigravity");
      expect(normalizeToQuotioProviderId("ZAI")).toBe("zcode");
      expect(normalizeToQuotioProviderId("GLM")).toBe("zcode");
    });

    it("normalizes Quotio IDs back to OpenCodex IDs via normalizeToOpenCodexProviderId", () => {
      expect(normalizeToOpenCodexProviderId("codex")).toBe("openai");
      expect(normalizeToOpenCodexProviderId("claude")).toBe("anthropic");
      expect(normalizeToOpenCodexProviderId("antigravity")).toBe("google-antigravity");
      expect(normalizeToOpenCodexProviderId("zcode")).toBe("zai");
      expect(normalizeToOpenCodexProviderId("glm")).toBe("zai");

      // Pass-through
      expect(normalizeToOpenCodexProviderId("cursor")).toBe("cursor");
      expect(normalizeToOpenCodexProviderId("openai")).toBe("openai");

      // Whitespace and case insensitivity
      expect(normalizeToOpenCodexProviderId("  CODEX  ")).toBe("openai");
      expect(normalizeToOpenCodexProviderId("Claude")).toBe("anthropic");
      expect(normalizeToOpenCodexProviderId("Antigravity")).toBe("google-antigravity");
      expect(normalizeToOpenCodexProviderId("ZCode")).toBe("zai");
    });

    it("resolves catalog entries via getProviderCatalogEntry / getProviderPreset", () => {
      // By direct OpenCodex ID
      const directOpenAi = getProviderCatalogEntry("openai");
      expect(directOpenAi?.id).toBe("openai");

      // By Quotio alias
      const aliasCodex = getProviderCatalogEntry("codex");
      expect(aliasCodex?.id).toBe("openai");

      const aliasClaude = getProviderCatalogEntry("claude");
      expect(aliasClaude?.id).toBe("anthropic");

      const aliasAntigravity = getProviderCatalogEntry("antigravity");
      expect(aliasAntigravity?.id).toBe("google-antigravity");

      const aliasZcode = getProviderPreset("zcode");
      expect(aliasZcode?.id).toBe("zai");

      const aliasGlm = getProviderPreset("glm");
      expect(aliasGlm?.id).toBe("zai");

      // Case insensitive
      expect(getProviderCatalogEntry("CODEX")?.id).toBe("openai");
      expect(getProviderCatalogEntry("  Claude  ")?.id).toBe("anthropic");

      // Unknown provider returns undefined
      expect(getProviderCatalogEntry("non-existent-provider")).toBeUndefined();
      expect(getProviderPreset("")).toBeUndefined();
    });

    it("checks provider existence via isKnownProviderId", () => {
      expect(isKnownProviderId("openai")).toBe(true);
      expect(isKnownProviderId("codex")).toBe(true);
      expect(isKnownProviderId("anthropic")).toBe(true);
      expect(isKnownProviderId("claude")).toBe(true);
      expect(isKnownProviderId("google-antigravity")).toBe(true);
      expect(isKnownProviderId("antigravity")).toBe(true);
      expect(isKnownProviderId("zai")).toBe(true);
      expect(isKnownProviderId("zcode")).toBe(true);
      expect(isKnownProviderId("glm")).toBe(true);
      expect(isKnownProviderId("cursor")).toBe(true);
      expect(isKnownProviderId("unknown-xyz")).toBe(false);
    });

    it("exports alias maps with frozen records", () => {
      expect(OPENCODEX_TO_QUOTIO_ALIASES.openai).toBe("codex");
      expect(OPENCODEX_TO_QUOTIO_ALIASES.anthropic).toBe("claude");
      expect(OPENCODEX_TO_QUOTIO_ALIASES["google-antigravity"]).toBe("antigravity");
      expect(OPENCODEX_TO_QUOTIO_ALIASES.zai).toBe("zcode");

      expect(QUOTIO_TO_OPENCODEX_ALIASES.codex).toBe("openai");
      expect(QUOTIO_TO_OPENCODEX_ALIASES.claude).toBe("anthropic");
      expect(QUOTIO_TO_OPENCODEX_ALIASES.antigravity).toBe("google-antigravity");
      expect(QUOTIO_TO_OPENCODEX_ALIASES.zcode).toBe("zai");
    });
  });

  describe("OAuth catalog and onboarding alignment", () => {
    it("does not advertise Kiro browser OAuth when onboarding is credential import", () => {
      expect(PROVIDER_CATALOG_BY_ID.kiro?.authKind).toBe("key");
    });

    it("classifies command-code as OAuth when browser callback onboarding is available", () => {
      // Given: the command-code provider catalog entry
      const entry = PROVIDER_CATALOG_BY_ID["command-code"];

      // When: inspecting the provider authentication kind
      const authKind = entry?.authKind;

      // Then: it must route through the dedicated browser callback flow
      expect(entry).toBeDefined();
      expect(authKind).toBe("oauth");
    });

    it("ensures every catalog entry marked as oauth corresponds to a dedicated working onboarding route", () => {
      // Given: the known dedicated onboarding providers supporting OAuth / credential flows
      const dedicatedOAuthCapableProviders = new Set([
        "cursor",
        "xai",
        "anthropic",
        "claude",
        "kimi",
        "kiro",
        "nous",
        "google-antigravity",
        "antigravity",
        "github-copilot",
        "openai",
        "codex",
        "gemini-cli",
        "qwen",
        "command-code",
      ]);

      // When: filtering catalog entries claiming oauth authKind
      const oauthEntries = PROVIDER_CATALOG.filter((entry) => entry.authKind === "oauth");

      // Then: all oauth catalog entries have a dedicated onboarding route
      expect(oauthEntries.some((entry) => entry.id === "command-code")).toBe(true);
      for (const entry of oauthEntries) {
        const canonicalId = entry.id;
        const quotioId = normalizeToQuotioProviderId(entry.id);
        const hasDedicatedRoute =
          dedicatedOAuthCapableProviders.has(canonicalId) ||
          dedicatedOAuthCapableProviders.has(quotioId);
        expect(hasDedicatedRoute).toBe(true);
      }
    });
  });
});
describe("reference registry parity", () => {
  // Vite rewrites `new URL(<literal>, import.meta.url)` into /@fs/ http URLs
  // once the target exists, which breaks readFileSync — resolve through a
  // standalone import.meta.url (never rewritten) into a filesystem path.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const snapshotUrl = path.resolve(
    here,
    "../../../../../docs/reference/opencodex-registry-snapshot.json",
  );
  const deviationsUrl = path.resolve(
    here,
    "../../../../../docs/reference/provider-parity-deviations.json",
  );
  const snapshot = JSON.parse(readFileSync(snapshotUrl, "utf8")) as {
    providers: readonly ReferenceProvider[];
  };
  const deviations = JSON.parse(readFileSync(deviationsUrl, "utf8")) as {
    deviations: readonly { id: string; field: string }[];
    omissions: readonly { id: string; reason: string }[];
  };
  const comparedFields = ["label", "baseUrl", "adapter", "authKind", "keyOptional"] as const;
  const declared = new Set(deviations.deviations.map((entry) => `${entry.id}.${entry.field}`));
  const omitted = new Set(deviations.omissions.map((entry) => entry.id));

  const differences = () => {
    const found = new Set<string>();
    for (const reference of snapshot.providers) {
      if (omitted.has(reference.id)) {
        continue;
      }
      const entry = PROVIDER_CATALOG_BY_ID[reference.id];
      if (!entry) {
        found.add(`${reference.id}.*`);
        continue;
      }
      for (const field of comparedFields) {
        if (JSON.stringify(entry[field] ?? null) !== JSON.stringify(reference[field] ?? null)) {
          found.add(`${reference.id}.${field}`);
        }
      }
      if (
        JSON.stringify(entry.staticHeaders ?? null) !==
        JSON.stringify(reference.staticHeaders ?? null)
      ) {
        found.add(`${reference.id}.staticHeaders`);
      }
    }
    return found;
  };

  it("exposes exactly the reference providers that are not declared omissions", () => {
    const referenceIds = snapshot.providers
      .map((provider) => provider.id)
      .filter((id) => !omitted.has(id))
      .sort();
    expect([...PROVIDER_IDS].sort()).toEqual(referenceIds);
  });

  it("keeps every omitted provider out of the catalog with a stated reason", () => {
    for (const entry of deviations.omissions) {
      expect(entry.reason.trim()).not.toEqual("");
      expect(PROVIDER_CATALOG_BY_ID[entry.id]).toBeUndefined();
    }
  });

  it("matches reference provider metadata except where a deviation is declared", () => {
    const undeclared = [...differences()].filter((key) => !declared.has(key)).sort();
    expect(undeclared).toEqual([]);
  });

  it("keeps no stale deviation that the catalog no longer needs", () => {
    const drifted = differences();
    const stale = [...declared].filter((key) => !drifted.has(key)).sort();
    expect(stale).toEqual([]);
  });

  it("marks the providers whose keyless mode is ported as key-optional", () => {
    expect(PROVIDER_CATALOG_BY_ID.litellm?.keyOptional).toBe(true);
    expect(PROVIDER_CATALOG_BY_ID["opencode-free"]?.keyOptional).toBe(true);
  });
});

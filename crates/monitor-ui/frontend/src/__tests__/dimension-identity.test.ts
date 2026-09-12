import { describe, expect, it } from "vitest";
import type { NormalizedAccount } from "../lib/accounts";
import { dimensionColor, dimensionDitherColor } from "../lib/dimension-colors";
import {
  resolveAccountIdentity,
  resolveProviderIdentity,
  truncateOpaqueIdentifier,
} from "../lib/dimension-identity";
import { OTHER_KEY } from "../lib/overview-analytics";

const makeAccount = (overrides: Partial<NormalizedAccount>): NormalizedAccount =>
  ({
    id: "acc-id",
    runtimeId: null,
    credentialName: null,
    disabled: false,
    authIndex: null,
    provider: "unknown",
    plan: null,
    email: "test@example.com",
    label: "Test Account",
    health: "healthy",
    healthRaw: "healthy",
    cooldownUntilUnixMs: null,
    cooldownRemainingSecs: null,
    ok: 0,
    fails: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    failureRate: 0,
    p50Ms: null,
    lastError: null,
    usage: null,
    quotaCapability: "unsupported",
    isCredentialOnly: false,
    canReset: false,
    resetCreditsAvailable: 0,
    supportsReset: false,
    resetCredits: [],
    ...overrides,
  }) as NormalizedAccount;

describe("truncateOpaqueIdentifier", () => {
  it("leaves standard identifiers unchanged", () => {
    expect(truncateOpaqueIdentifier("indoyoon93@gmail.com")).toBe("indoyoon93@gmail.com");
    expect(truncateOpaqueIdentifier("freedomzero91_gmail.com")).toBe("freedomzero91_gmail.com");
    expect(truncateOpaqueIdentifier("588314d6-ZqvM9mzp@doloffer.shop")).toBe(
      "588314d6-ZqvM9mzp@doloffer.shop",
    );
    expect(truncateOpaqueIdentifier("zcode-desktop")).toBe("zcode-desktop");
    expect(truncateOpaqueIdentifier("cline-user-7q767m9u@superwiki.net")).toBe(
      "cline-user-7q767m9u@superwiki.net",
    );
  });

  it("truncates runs of 32 or more hex characters to 8 chars plus ellipsis", () => {
    const raw =
      "generic-cline-oauth-783d9565976dad6168e98144a9a982265a2389b5dd40102ba85d3313466848ce";
    const truncated = truncateOpaqueIdentifier(raw);
    expect(truncated).toBe("generic-cline-oauth-783d9565…");
    expect(truncated).not.toContain("976dad6168e98144");
  });

  it("does not truncate hex runs of 31 characters", () => {
    const hex31 = "a".repeat(31);
    expect(truncateOpaqueIdentifier(hex31)).toBe(hex31);
  });

  it("truncates an exact 32-character hex run", () => {
    const hex32 = "0123456789abcdef0123456789abcdef";
    expect(truncateOpaqueIdentifier(hex32)).toBe("01234567…");
  });
});

describe("resolveAccountIdentity", () => {
  const accounts: readonly NormalizedAccount[] = [
    makeAccount({
      id: "indoyoon93@gmail.com",
      email: "indoyoon93@gmail.com",
      label: "Indo Yoon",
      provider: "codex",
    }),
    makeAccount({
      id: "acc-freedom",
      email: "freedomzero91@gmail.com",
      label: "Freedom Zero",
      provider: "codex",
    }),
    makeAccount({
      id: "588314d6-ZqvM9mzp@doloffer.shop",
      email: "588314d6-ZqvM9mzp@doloffer.shop",
      label: "Doloffer",
      provider: "claude",
    }),
    makeAccount({
      id: "desktop",
      email: "desktop@example.com",
      label: "Zcode Desktop",
      provider: "zcode",
    }),
    makeAccount({
      id: "acc-cline",
      email: "user-7q767m9u@superwiki.net",
      label: "Cline Superwiki",
      provider: "cline",
    }),
    makeAccount({
      id: "acc-cred",
      email: "cred@example.com",
      label: "Cred Account",
      provider: "antigravity",
      credentialName: "special-credential-name",
    }),
  ];

  it("resolves exact id match", () => {
    const res = resolveAccountIdentity("588314d6-ZqvM9mzp@doloffer.shop", accounts);
    expect(res).toEqual({
      label: "Doloffer",
      provider: "claude",
      isUnlinked: false,
    });
  });

  it("resolves exact email match", () => {
    const res = resolveAccountIdentity("indoyoon93@gmail.com", accounts);
    expect(res).toEqual({
      label: "Indo Yoon",
      provider: "codex",
      isUnlinked: false,
    });
  });

  it("resolves email after replacing the last underscore with @", () => {
    const res = resolveAccountIdentity("freedomzero91_gmail.com", accounts);
    expect(res).toEqual({
      label: "Freedom Zero",
      provider: "codex",
      isUnlinked: false,
    });
  });

  it("resolves after stripping a leading <word>- prefix", () => {
    const resZcode = resolveAccountIdentity("zcode-desktop", accounts);
    expect(resZcode).toEqual({
      label: "Zcode Desktop",
      provider: "zcode",
      isUnlinked: false,
    });

    const resCline = resolveAccountIdentity("cline-user-7q767m9u@superwiki.net", accounts);
    expect(resCline).toEqual({
      label: "Cline Superwiki",
      provider: "cline",
      isUnlinked: false,
    });
  });

  it("resolves by matching against credentialName", () => {
    const res = resolveAccountIdentity("special-credential-name", accounts);
    expect(res).toEqual({
      label: "Cred Account",
      provider: "antigravity",
      isUnlinked: false,
    });
  });

  it("does not substring match short credentialName such as 'codex' against unrelated identifiers", () => {
    const accountsWithShortCred: readonly NormalizedAccount[] = [
      makeAccount({
        id: "acc-codex",
        email: "codex-admin@internal.net",
        label: "Codex Admin",
        provider: "codex",
        credentialName: "codex",
      }),
    ];
    const res = resolveAccountIdentity("codex-user@example.com", accountsWithShortCred);
    expect(res.isUnlinked).toBe(true);
    expect(res.provider).toBe("unknown");
  });

  it("verifies the 6 real identifiers from the specification", () => {
    // 1. indoyoon93@gmail.com
    const r1 = resolveAccountIdentity("indoyoon93@gmail.com", accounts);
    expect(r1.isUnlinked).toBe(false);
    expect(r1.provider).toBe("codex");

    // 2. freedomzero91_gmail.com
    const r2 = resolveAccountIdentity("freedomzero91_gmail.com", accounts);
    expect(r2.isUnlinked).toBe(false);
    expect(r2.provider).toBe("codex");

    // 3. 588314d6-ZqvM9mzp@doloffer.shop
    const r3 = resolveAccountIdentity("588314d6-ZqvM9mzp@doloffer.shop", accounts);
    expect(r3.isUnlinked).toBe(false);
    expect(r3.provider).toBe("claude");

    // 4. zcode-desktop
    const r4 = resolveAccountIdentity("zcode-desktop", accounts);
    expect(r4.isUnlinked).toBe(false);
    expect(r4.provider).toBe("zcode");

    // 5. cline-user-7q767m9u@superwiki.net
    const r5 = resolveAccountIdentity("cline-user-7q767m9u@superwiki.net", accounts);
    expect(r5.isUnlinked).toBe(false);
    expect(r5.provider).toBe("cline");

    // 6. generic-cline-oauth-783d9565976dad6168e98144a9a982265a2389b5dd40102ba85d3313466848ce
    const r6 = resolveAccountIdentity(
      "generic-cline-oauth-783d9565976dad6168e98144a9a982265a2389b5dd40102ba85d3313466848ce",
      accounts,
    );
    expect(r6.isUnlinked).toBe(true);
    expect(r6.provider).toBe("unknown");
    expect(r6.label).toBe("generic-cline-oauth-783d9565…");
    expect(r6.label).not.toContain("976dad6168e98144");
  });

  it("falls back to account.email or identifier if label is empty", () => {
    const acc = makeAccount({
      id: "no-label@example.com",
      email: "no-label@example.com",
      label: "",
      provider: "codex",
    });
    const res = resolveAccountIdentity("no-label@example.com", [acc]);
    expect(res.label).toBe("no-label@example.com");
  });
});

describe("resolveProviderIdentity", () => {
  it("normalizes known provider aliases through normalizeToQuotioProviderId", () => {
    expect(resolveProviderIdentity("openai")).toBe("codex");
    expect(resolveProviderIdentity("anthropic")).toBe("claude");
    expect(resolveProviderIdentity("google-antigravity")).toBe("antigravity");
    expect(resolveProviderIdentity("zai")).toBe("zcode");
    expect(resolveProviderIdentity("glm")).toBe("zcode");
  });

  it("resolves generic provider using linked account provider", () => {
    const resolvedCline = {
      label: "Cline Superwiki",
      provider: "cline",
      isUnlinked: false,
    };
    expect(resolveProviderIdentity("generic", resolvedCline)).toBe("cline");
    expect(resolveProviderIdentity("unknown", resolvedCline)).toBe("cline");
  });

  it("does not override with unlinked account", () => {
    const unlinked = {
      label: "some-label",
      provider: "cline",
      isUnlinked: true,
    };
    expect(resolveProviderIdentity("generic", unlinked)).toBe("generic");
  });

  it("does not override already specific provider", () => {
    const resolvedCline = {
      label: "Cline Superwiki",
      provider: "cline",
      isUnlinked: false,
    };
    expect(resolveProviderIdentity("codex", resolvedCline)).toBe("codex");
    expect(resolveProviderIdentity("antigravity", resolvedCline)).toBe("antigravity");
  });
});

describe("dimension-colors", () => {
  it("delegates provider dimension to providerColor", () => {
    expect(dimensionColor("provider", "codex", "codex")).toBe("#10A37F");
    expect(dimensionColor("provider", "antigravity", "antigravity")).toBe("#3186FF");
    expect(dimensionColor("provider", "claude", "claude")).toBe("#D97757");
  });

  it("picks deterministically for model and account dimensions", () => {
    const c1 = dimensionColor("model", "gpt-4o", "codex");
    const c2 = dimensionColor("model", "gpt-4o", "codex");
    expect(c1).toBe(c2);

    const a1 = dimensionColor("account", "user@example.com", "unknown");
    const a2 = dimensionColor("account", "user@example.com", "unknown");
    expect(a1).toBe(a2);
  });

  it("does not cause all common models to collide on the same color", () => {
    const models = [
      "gpt-4o",
      "gpt-4o-mini",
      "claude-3-5-sonnet",
      "claude-3-haiku",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "deepseek-coder",
    ];
    const colors = new Set(models.map((m) => dimensionColor("model", m, "unknown")));
    expect(colors.size).toBeGreaterThan(2);
  });

  it("returns valid DitherColor literals for dimensionDitherColor", () => {
    const allowed = new Set(["green", "blue", "purple", "pink", "orange", "red", "grey"]);
    const d1 = dimensionDitherColor("model", "gpt-4o", "codex");
    expect(allowed.has(d1)).toBe(true);
    const d2 = dimensionDitherColor("provider", "codex", "codex");
    expect(allowed.has(d2)).toBe(true);
    const dOther = dimensionDitherColor("model", OTHER_KEY, "other");
    expect(dOther).toBe("grey");
  });
});

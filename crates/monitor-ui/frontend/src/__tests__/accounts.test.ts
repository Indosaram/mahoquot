import { describe, expect, it } from "vitest";
import {
  type NormalizedAccount,
  deriveAccountHealth,
  formatResetTime,
  getQuotaCapability,
  mergeAccountsAndCredentials,
} from "../lib/accounts";
import type { AdminStats, AuthFileItem } from "../lib/schemas";

describe("Account Normalization and Quota Capability", () => {
  it("normalizes runtime accounts with matching credentials, preserving distinct IDs", () => {
    const stats: AdminStats = {
      uptime_secs: 100,
      in_flight: 0,
      served: 50,
      failed_over: 2,
      refreshed: 1,
      ttft: null,
      accounts: [
        {
          id: "565c2911-mona@example.com",
          provider: "codex",
          health: { status: "available" },
          ok: 48,
          fails: 2,
          reset_at_unix_ms: null,
          last_error: null,
          ttft: { p50_ms: 120, p90_ms: 200, p99_ms: 300, samples: 48 },
          usage: {
            plan_type: "plus",
            primary: { used_percent: 10, window_minutes: 300, reset_at_unix: 2000 },
            secondary: { used_percent: 25, window_minutes: 10080, reset_at_unix: 8000 },
            reset_credits_available: 3,
            observed_at_unix: 1500,
          },
        },
      ],
    };

    const creds: AuthFileItem[] = [
      {
        name: "mona-account.json",
        size: 256,
        auth_index: "0a1b2c3d4e5f",
        path: "/auth/mona-account.json",
        label: "mona-account",
        disabled: false,
        unavailable: false,
        runtime_only: false,
        type: "codex",
        email: "mona@example.com",
      },
    ];

    const normalized = mergeAccountsAndCredentials(stats.accounts, creds);
    expect(normalized.length).toBe(1);
    const acc = normalized[0] as NormalizedAccount;
    expect(acc.runtimeId).toBe("565c2911-mona@example.com");
    expect(acc.credentialName).toBe("mona-account.json");
    expect(acc.authIndex).toBe("0a1b2c3d4e5f");
    expect(acc.provider).toBe("codex");
    expect(acc.email).toBe("mona@example.com");
    expect(acc.health).toBe("healthy");
    expect(acc.isCredentialOnly).toBe(false);
  });

  it("surfaces credential-only files as Failed to load into pool", () => {
    const statsAccounts: AdminStats["accounts"] = [];
    const creds: AuthFileItem[] = [
      {
        name: "broken-cred.json",
        size: 128,
        auth_index: "deadbeef",
        path: "/auth/broken-cred.json",
        label: "broken-cred",
        disabled: false,
        unavailable: false,
        runtime_only: false,
        type: "antigravity",
        email: "orphan@company.com",
      },
    ];

    const normalized = mergeAccountsAndCredentials(statsAccounts, creds);
    expect(normalized.length).toBe(1);
    const acc = normalized[0] as NormalizedAccount;
    expect(acc.runtimeId).toBeNull();
    expect(acc.credentialName).toBe("broken-cred.json");
    expect(acc.authIndex).toBe("deadbeef");
    expect(acc.isCredentialOnly).toBe(true);
    expect(acc.health).toBe("not_loaded");
  });

  it("binds a subscription import whose runtime id shares nothing with its credential file", () => {
    const accounts: AdminStats["accounts"] = [
      {
        id: "claude-code",
        provider: "claude",
        health: { status: "available" },
        ok: 5,
        fails: 0,
        reset_at_unix_ms: null,
        last_error: null,
        ttft: null,
        usage: null,
      },
    ];
    const creds: AuthFileItem[] = [
      {
        name: "claude-local.json",
        size: 180,
        auth_index: "claude-local",
        path: "/auth/claude-local.json",
        label: "claude-local",
        disabled: false,
        unavailable: false,
        runtime_only: false,
        type: "claude",
        email: "owner@example.com",
      },
    ];

    const normalized = mergeAccountsAndCredentials(accounts, creds);
    expect(normalized.length).toBe(1);
    const acc = normalized[0] as NormalizedAccount;
    expect(acc.runtimeId).toBe("claude-code");
    expect(acc.credentialName).toBe("claude-local.json");
    expect(acc.isCredentialOnly).toBe(false);
  });

  it("binds a single generic runtime account to its provider credential", () => {
    const accounts: AdminStats["accounts"] = [
      {
        id: "deepseek-main",
        provider: "deepseek",
        health: { status: "available" },
        ok: 3,
        fails: 0,
        reset_at_unix_ms: null,
        last_error: null,
        ttft: null,
        usage: null,
      },
    ];
    const creds: AuthFileItem[] = [
      {
        name: "generic-deepseek-main.json",
        size: 180,
        auth_index: "generic-deepseek-main",
        path: "/auth/generic-deepseek-main.json",
        label: "deepseek-main",
        disabled: false,
        unavailable: false,
        runtime_only: false,
        type: "generic",
        provider: "deepseek",
      },
    ];

    const normalized = mergeAccountsAndCredentials(accounts, creds);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.credentialName).toBe("generic-deepseek-main.json");
    expect(normalized[0]?.isCredentialOnly).toBe(false);
  });

  it("leaves ambiguous provider pairings unbound instead of guessing", () => {
    const accounts: AdminStats["accounts"] = ["claude-code", "claude-code-2"].map((id) => ({
      id,
      provider: "claude",
      health: { status: "available" },
      ok: 1,
      fails: 0,
      reset_at_unix_ms: null,
      last_error: null,
      ttft: null,
      usage: null,
    }));
    const creds: AuthFileItem[] = ["claude-a.json", "claude-b.json"].map((name) => ({
      name,
      size: 100,
      auth_index: name,
      path: `/auth/${name}`,
      label: name,
      disabled: false,
      unavailable: false,
      runtime_only: false,
      type: "claude",
      email: `${name}@example.com`,
    }));

    const normalized = mergeAccountsAndCredentials(accounts, creds);
    expect(normalized.filter((acc) => acc.runtimeId && acc.credentialName)).toHaveLength(0);
    expect(normalized.filter((acc) => acc.isCredentialOnly)).toHaveLength(2);
  });

  it("classifies quota capability properly without fake 0% for unsupported providers", () => {
    expect(getQuotaCapability("codex", { plan_type: "plus" })).toBe("supported");
    expect(
      getQuotaCapability("antigravity", {
        groups: [{ display_name: "G", buckets: [] }],
      }),
    ).toBe("supported");
    expect(getQuotaCapability("claude", null)).toBe("supported");
    expect(getQuotaCapability("anthropic", null)).toBe("supported");
    expect(getQuotaCapability("kiro", null)).toBe("unsupported");
    // ClinePass reports grouped windows from usage-limits: buckets present
    // means supported, empty means unknown (never a fake 0%).
    expect(
      getQuotaCapability("cline-pass", {
        groups: [{ display_name: "ClinePass", buckets: [] }],
      }),
    ).toBe("supported");
  });

  it("matches canonical provider ids instead of substrings", () => {
    // given generic endpoints whose names merely contain a supported id,
    // capability must stay unsupported: an "openai-compatible" relay does not
    // report Codex quota headers, and claiming otherwise renders a fake window
    expect(getQuotaCapability("openai-compatible", null)).toBe("unsupported");
    expect(getQuotaCapability("claude-relay", null)).toBe("unsupported");
    expect(getQuotaCapability("my-antigravity-proxy", { groups: [] })).toBe("unsupported");

    // catalog aliases still resolve to the canonical id
    expect(getQuotaCapability("openai", null)).toBe("supported");
    expect(getQuotaCapability(" Anthropic ", null)).toBe("supported");
  });

  it("orders the displayed list by the credential inventory, not the pool order", () => {
    const runtime = [
      { id: "a@example.com", provider: "codex", health: "available", ok: 1, fails: 0 },
      { id: "b@example.com", provider: "codex", health: "available", ok: 1, fails: 0 },
    ];
    const credential = (name: string, email: string) => ({
      name,
      size: 1,
      auth_index: name,
      path: `/auth/${name}`,
      label: email,
      disabled: false,
      unavailable: false,
      runtime_only: false,
      type: "codex",
      email,
    });

    const merged = mergeAccountsAndCredentials(runtime, [
      credential("codex-b.json", "b@example.com"),
      credential("codex-a.json", "a@example.com"),
    ]);

    expect(merged.map((account) => account.id)).toEqual(["b@example.com", "a@example.com"]);
  });

  it("derives correct health state including cooldown countdown", () => {
    expect(deriveAccountHealth({ status: "available" }, null, 10, 0)).toBe("healthy");
    expect(deriveAccountHealth({ status: "cooldown" }, Date.now() + 60000, 1, 5)).toBe("cooldown");
    expect(deriveAccountHealth({ status: "available" }, null, 1, 9)).toBe("degraded");
    // The gateway never flips Health::Cooldown back to Available; an expired
    // deadline must read as healthy like Health::is_available does.
    expect(deriveAccountHealth({ status: "cooldown" }, Date.now() - 60000, 0, 1)).toBe(
      "healthy",
    );
    // Without a deadline there is nothing to expire, so keep showing cooldown.
    expect(deriveAccountHealth({ status: "cooldown" }, null, 0, 1)).toBe("cooldown");
  });

  it("formats reset countdown strings correctly", () => {
    expect(formatResetTime(0)).toBe("now");
    expect(formatResetTime(50)).toBe("50s");
    expect(formatResetTime(180)).toBe("3m");
    expect(formatResetTime(3700)).toBe("1h 1m");
    expect(formatResetTime(90000)).toBe("1d 1h");
  });

  it("cleans codex runtime prefix and plan suffix from raw account id", () => {
    const rawCodex = "codex-588314d6-ZqvM9mzp@doloffer.shop-plus";
    const merged = mergeAccountsAndCredentials(
      [
        {
          id: rawCodex,
          provider: "codex",
          health: { status: "available" },
          ok: 10,
          fails: 0,
          reset_at_unix_ms: null,
          last_error: null,
          ttft: null,
          usage: null,
        },
      ],
      [],
    );
    expect(merged[0]?.email).toBe("zqvm9mzp@doloffer.shop");
    expect(merged[0]?.label).toBe("ZqvM9mzp@doloffer.shop");
  });

  it("classifies disabled credential file as disabled rather than not_loaded", () => {
    const creds: AuthFileItem[] = [
      {
        name: "codex-buzzi8434_gmail.com-pro.json",
        size: 256,
        auth_index: "d1a3a2",
        path: "/auth/codex-buzzi8434_gmail.com-pro.json",
        label: "codex-buzzi8434_gmail.com-pro",
        disabled: true,
        unavailable: false,
        runtime_only: false,
        type: "codex",
        email: "buzzi8434@gmail.com",
      },
    ];

    const normalized = mergeAccountsAndCredentials([], creds);
    expect(normalized.length).toBe(1);
    const acc = normalized[0] as NormalizedAccount;
    expect(acc.disabled).toBe(true);
    expect(acc.health).toBe("disabled");
    expect(acc.healthRaw).toBe("Disabled");
  });

  it("pairs runtime account and credential when email domain uses underscore and preserves disabled status", () => {
    const stats: AdminStats["accounts"] = [
      {
        id: "buzzi8434_gmail.com",
        provider: "codex",
        health: { status: "disabled" },
        ok: 10,
        fails: 0,
        reset_at_unix_ms: null,
        last_error: null,
        ttft: null,
        usage: null,
      },
    ];
    const creds: AuthFileItem[] = [
      {
        name: "codex-buzzi8434_gmail.com-pro.json",
        size: 256,
        auth_index: "d1a3a2",
        path: "/auth/codex-buzzi8434_gmail.com-pro.json",
        label: "codex-buzzi8434_gmail.com-pro",
        disabled: true,
        unavailable: false,
        runtime_only: false,
        type: "codex",
        email: "buzzi8434@gmail.com",
      },
    ];

    const normalized = mergeAccountsAndCredentials(stats, creds);
    expect(normalized.length).toBe(1);
    const acc = normalized[0] as NormalizedAccount;
    expect(acc.runtimeId).toBe("buzzi8434_gmail.com");
    expect(acc.credentialName).toBe("codex-buzzi8434_gmail.com-pro.json");
    expect(acc.disabled).toBe(true);
    expect(acc.health).toBe("disabled");
  });

  it("normalizes claude account label with underscore or at-sign email and preserves non-email labels", () => {
    const creds: AuthFileItem[] = [
      {
        name: "claude-sookyoung91_gmail.com.json",
        size: 256,
        auth_index: "claude-1",
        path: "/auth/claude-sookyoung91_gmail.com.json",
        label: "claude-sookyoung91_gmail.com",
        disabled: false,
        unavailable: false,
        runtime_only: false,
        type: "claude",
        email: "sookyoung91@gmail.com",
      },
      {
        name: "claude-ccapi.json",
        size: 256,
        auth_index: "claude-2",
        path: "/auth/claude-ccapi.json",
        label: "claude-ccapi",
        disabled: false,
        unavailable: false,
        runtime_only: false,
        type: "claude",
        email: "claude-ccapi",
      },
    ];

    const normalized = mergeAccountsAndCredentials([], creds);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.label).toBe("sookyoung91@gmail.com");
    expect(normalized[1]?.label).toBe("claude-ccapi");
  });
});

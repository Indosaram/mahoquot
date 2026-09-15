import { describe, expect, it } from "vitest";
import {
  type NormalizedAccount,
  deriveAccountHealth,
  formatResetTime,
  getClineGlmQuotaDeadline,
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
    expect(deriveAccountHealth({ status: "cooldown" }, Date.now() - 60000, 0, 1)).toBe("healthy");
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

  it("regression: expires cooldown to healthy when deadline has passed and preserves future cooldown", () => {
    const now = Date.now();

    // 1. Expired deadline flips status: cooldown to healthy
    expect(deriveAccountHealth({ status: "cooldown" }, now - 5000, 5, 0)).toBe("healthy");
    expect(deriveAccountHealth("cooldown", now - 5000, 5, 0)).toBe("healthy");

    // 2. Future deadline stays cooldown
    expect(deriveAccountHealth({ status: "cooldown" }, now + 60000, 5, 0)).toBe("cooldown");
    expect(deriveAccountHealth("cooldown", now + 60000, 5, 0)).toBe("cooldown");

    // 3. Disabled status overrides any cooldown deadline
    expect(deriveAccountHealth({ status: "disabled" }, now + 60000, 5, 0)).toBe("disabled");
    expect(deriveAccountHealth("disabled", now - 5000, 5, 0)).toBe("disabled");

    // 4. mergeAccountsAndCredentials with expired cooldown deadline
    const expiredStats: AdminStats["accounts"] = [
      {
        id: "cline-expired@example.com",
        provider: "cline",
        health: { status: "cooldown" },
        ok: 10,
        fails: 1,
        reset_at_unix_ms: now - 30_000,
        last_error: null,
        ttft: null,
        usage: null,
      },
      {
        id: "cline-future@example.com",
        provider: "cline",
        health: { status: "cooldown" },
        ok: 10,
        fails: 1,
        reset_at_unix_ms: now + 300_000,
        last_error: null,
        ttft: null,
        usage: null,
      },
    ];

    const merged = mergeAccountsAndCredentials(expiredStats, []);
    const expiredAcc = merged.find((a) => a.id === "cline-expired@example.com");
    const futureAcc = merged.find((a) => a.id === "cline-future@example.com");

    expect(expiredAcc?.health).toBe("healthy");
    expect(expiredAcc?.cooldownRemainingSecs).toBe(0);
    expect(expiredAcc?.cooldownUntilUnixMs).toBe(now - 30_000);

    expect(futureAcc?.health).toBe("cooldown");
    expect(futureAcc?.cooldownRemainingSecs).toBeGreaterThan(0);
    expect(futureAcc?.cooldownUntilUnixMs).toBe(now + 300_000);
  });

  describe("Cline GLM free quota health derivation regression", () => {
    const now = Date.now();
    const nowSecs = Math.floor(now / 1000);

    it("derives cooldown with actual deadline from active exhausted GLM free quota even when API health is available", () => {
      // Live reported issue: API health available, usage.groups Cline Free Limits bucket z-ai/glm-5.3-flash used_percent 100 with future reset -> Cooldown
      const stats: AdminStats["accounts"] = [
        {
          id: "cline-live@example.com",
          provider: "cline",
          health: { status: "available" },
          ok: 10,
          fails: 0,
          reset_at_unix_ms: null,
          last_error: null,
          ttft: null,
          usage: {
            groups: [
              {
                display_name: "Cline Free Limits",
                buckets: [
                  {
                    display_name: "z-ai/glm-5.3-flash",
                    used_percent: 100,
                    reset_at_unix: nowSecs + 3600,
                  },
                ],
              },
            ],
          },
        },
      ];

      const merged = mergeAccountsAndCredentials(stats, []);
      const acc = merged[0] as NormalizedAccount;

      expect(acc.health).toBe("cooldown");
      expect(acc.cooldownUntilUnixMs).toBe((nowSecs + 3600) * 1000);
      expect(acc.cooldownRemainingSecs).toBeGreaterThanOrEqual(3590);
      expect(acc.cooldownRemainingSecs).toBeLessThanOrEqual(3600);
    });

    it("derives healthy when other registered models are exhausted but GLM is not exhausted", () => {
      // User explicitly directs: only GLM free quota determines Healthy vs cooldown; not other registered models
      const stats: AdminStats["accounts"] = [
        {
          id: "cline-other-exhausted@example.com",
          provider: "cline",
          health: { status: "cooldown" },
          ok: 10,
          fails: 0,
          reset_at_unix_ms: now + 1800_000,
          last_error: null,
          ttft: null,
          usage: {
            groups: [
              {
                display_name: "Cline Free Limits",
                buckets: [
                  {
                    display_name: "z-ai/glm-5.3-flash",
                    used_percent: 20,
                    reset_at_unix: nowSecs + 3600,
                  },
                  {
                    display_name: "moonshot/kimi-k3",
                    used_percent: 100,
                    reset_at_unix: nowSecs + 1800,
                  },
                ],
              },
            ],
          },
        },
      ];

      const merged = mergeAccountsAndCredentials(stats, []);
      const acc = merged[0] as NormalizedAccount;

      expect(acc.health).toBe("healthy");
      expect(acc.cooldownRemainingSecs).toBeNull();
    });

    it("normalizes expired inferred GLM quota to healthy and not exhausted", () => {
      // Expired inferred quota => unknown, not fabricated zero; unknown must not imply exhausted
      const stats: AdminStats["accounts"] = [
        {
          id: "cline-glm-expired@example.com",
          provider: "cline",
          health: { status: "cooldown" },
          ok: 10,
          fails: 0,
          reset_at_unix_ms: now - 30_000,
          last_error: null,
          ttft: null,
          usage: {
            groups: [
              {
                display_name: "Cline Free Limits",
                buckets: [
                  {
                    display_name: "z-ai/glm-5.3-flash (Daily limit)",
                    used_percent: 100,
                    reset_at_unix: nowSecs - 300,
                  },
                ],
              },
            ],
          },
        },
      ];

      const merged = mergeAccountsAndCredentials(stats, []);
      const acc = merged[0] as NormalizedAccount;

      expect(acc.health).toBe("healthy");
      expect(acc.cooldownRemainingSecs).toBe(0);
    });

    it("treats unknown GLM quota without deadline as healthy not exhausted", () => {
      // Unknown quota must not imply exhausted
      const stats: AdminStats["accounts"] = [
        {
          id: "cline-no-deadline@example.com",
          provider: "cline",
          health: { status: "available" },
          ok: 10,
          fails: 0,
          reset_at_unix_ms: null,
          last_error: null,
          ttft: null,
          usage: {
            groups: [
              {
                display_name: "Cline Free Limits",
                buckets: [
                  {
                    display_name: "z-ai/glm-5.3-flash (Daily limit)",
                    used_percent: 100,
                    reset_at_unix: null,
                    reset_after_seconds: null,
                  },
                ],
              },
            ],
          },
        },
      ];

      const merged = mergeAccountsAndCredentials(stats, []);
      const acc = merged[0] as NormalizedAccount;

      expect(acc.health).toBe("healthy");
      expect(acc.cooldownUntilUnixMs).toBeNull();
      expect(acc.cooldownRemainingSecs).toBeNull();
    });

    it("preserves disabled status and auth error even when GLM quota is exhausted", () => {
      const stats: AdminStats["accounts"] = [
        {
          id: "cline-disabled@example.com",
          provider: "cline",
          health: { status: "disabled" },
          ok: 0,
          fails: 0,
          reset_at_unix_ms: null,
          last_error: null,
          ttft: null,
          usage: {
            groups: [
              {
                display_name: "Cline Free Limits",
                buckets: [
                  {
                    display_name: "z-ai/glm-5.3-flash",
                    used_percent: 100,
                    reset_at_unix: nowSecs + 3600,
                  },
                ],
              },
            ],
          },
        },
        {
          id: "cline-auth-err@example.com",
          provider: "cline",
          health: { status: "available" },
          ok: 0,
          fails: 1,
          reset_at_unix_ms: null,
          last_error: { unix_ms: now, status: 401, message: "unauthenticated" },
          ttft: null,
          usage: {
            groups: [
              {
                display_name: "Cline Free Limits",
                buckets: [
                  {
                    display_name: "z-ai/glm-5.3-flash",
                    used_percent: 100,
                    reset_at_unix: nowSecs + 3600,
                  },
                ],
              },
            ],
          },
        },
      ];

      const merged = mergeAccountsAndCredentials(stats, []);
      expect(merged[0]?.health).toBe("disabled");
      expect(merged[1]?.health).toBe("auth_required");
    });

    it("anchors relative reset_after_seconds to observed_at_unix and expires when advancing now beyond fixed deadline", () => {
      // Fixed deadline = observed_at_unix (1000) + reset_after_seconds (300) = 1300s
      const stats: AdminStats["accounts"] = [
        {
          id: "cline-relative@example.com",
          provider: "cline",
          health: { status: "available" },
          ok: 10,
          fails: 0,
          reset_at_unix_ms: null,
          last_error: null,
          ttft: null,
          usage: {
            observed_at_unix: 1000,
            groups: [
              {
                display_name: "Cline Free Limits",
                buckets: [
                  {
                    display_name: "z-ai/glm-5.3-flash",
                    used_percent: 100,
                    reset_after_seconds: 300,
                  },
                ],
              },
            ],
          },
        },
      ];

      // 1. Before fixed deadline: at now = 1200s (< 1300s) -> active cooldown
      const beforeDeadline = getClineGlmQuotaDeadline(stats[0]?.usage, 1200 * 1000);
      expect(beforeDeadline).toEqual({
        untilUnixMs: 1300 * 1000,
        remainingSecs: 100,
        active: true,
      });

      // 2. Beyond fixed deadline: advancing now to 1400s (> 1300s) -> expired, not renewing cooldown
      const afterDeadline = getClineGlmQuotaDeadline(stats[0]?.usage, 1400 * 1000);
      expect(afterDeadline).toEqual({
        untilUnixMs: 1300 * 1000,
        remainingSecs: 0,
        active: false,
      });
    });

    it("recognizes GLM identity from stable bucket_id in id-only actual bucket fixture", () => {
      const stats: AdminStats["accounts"] = [
        {
          id: "cline-id-only@example.com",
          provider: "cline",
          health: { status: "available" },
          ok: 10,
          fails: 0,
          reset_at_unix_ms: null,
          last_error: null,
          ttft: null,
          usage: {
            groups: [
              {
                display_name: "Cline Free Limits",
                buckets: [
                  {
                    bucket_id: "z-ai/glm-5.3-flash",
                    used_percent: 100,
                    reset_at_unix: nowSecs + 1800,
                  },
                ],
              },
            ],
          },
        },
      ];

      const deadline = getClineGlmQuotaDeadline(stats[0]?.usage, now);
      expect(deadline).not.toBeNull();
      expect(deadline?.active).toBe(true);

      const merged = mergeAccountsAndCredentials(stats, []);
      expect(merged[0]?.health).toBe("cooldown");
    });

    it("ensures error health status takes precedence over active exhausted GLM", () => {
      const stats: AdminStats["accounts"] = [
        {
          id: "cline-error@example.com",
          provider: "cline",
          health: { status: "error" },
          ok: 5,
          fails: 5,
          reset_at_unix_ms: null,
          last_error: { unix_ms: now, status: 500, message: "Internal server error" },
          ttft: null,
          usage: {
            groups: [
              {
                display_name: "Cline Free Limits",
                buckets: [
                  {
                    bucket_id: "z-ai/glm-5.3-flash",
                    used_percent: 100,
                    reset_at_unix: nowSecs + 3600,
                  },
                ],
              },
            ],
          },
        },
      ];

      const merged = mergeAccountsAndCredentials(stats, []);
      expect(merged[0]?.health).toBe("error");
      expect(merged[0]?.cooldownRemainingSecs).toBeNull();
    });

    it("preserves prior cooldown for non-Cline accounts with raw error and future reset deadline", () => {
      const stats: AdminStats["accounts"] = [
        {
          id: "codex-error-cooldown@example.com",
          provider: "codex",
          health: { status: "error" },
          ok: 10,
          fails: 1,
          reset_at_unix_ms: now + 600_000,
          last_error: { unix_ms: now, status: 500, message: "upstream service error" },
          ttft: null,
          usage: null,
        },
      ];

      const derived = deriveAccountHealth(
        stats[0]?.health,
        stats[0]?.reset_at_unix_ms,
        stats[0]?.ok ?? 0,
        stats[0]?.fails ?? 0,
        stats[0]?.provider,
        stats[0]?.usage,
        now,
      );
      expect(derived).toBe("cooldown");

      const merged = mergeAccountsAndCredentials(stats, []);
      expect(merged[0]?.health).toBe("cooldown");
      expect(merged[0]?.cooldownRemainingSecs).toBeGreaterThan(0);
      expect(merged[0]?.cooldownUntilUnixMs).toBe(now + 600_000);
    });
  });
});

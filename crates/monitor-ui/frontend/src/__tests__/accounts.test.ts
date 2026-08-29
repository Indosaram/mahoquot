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

  it("classifies quota capability properly without fake 0% for unsupported providers", () => {
    expect(getQuotaCapability("codex", { plan_type: "plus" })).toBe("supported");
    expect(
      getQuotaCapability("antigravity", {
        groups: [{ display_name: "G", buckets: [] }],
      }),
    ).toBe("supported");
    expect(getQuotaCapability("claude", null)).toBe("unsupported");
    expect(getQuotaCapability("kiro", null)).toBe("unsupported");
  });

  it("derives correct health state including cooldown countdown", () => {
    expect(deriveAccountHealth({ status: "available" }, null, 10, 0)).toBe("healthy");
    expect(deriveAccountHealth({ status: "cooldown" }, Date.now() + 60000, 1, 5)).toBe("cooldown");
    expect(deriveAccountHealth({ status: "available" }, null, 1, 9)).toBe("degraded");
  });

  it("formats reset countdown strings correctly", () => {
    expect(formatResetTime(0)).toBe("now");
    expect(formatResetTime(50)).toBe("50s");
    expect(formatResetTime(180)).toBe("3m");
    expect(formatResetTime(3700)).toBe("1h 1m");
    expect(formatResetTime(90000)).toBe("1d 1h");
  });
});

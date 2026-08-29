import { describe, expect, it } from "vitest";
import { parseAdminStats, parseAuthFiles, parseLogs } from "../lib/schemas";

describe("Gateway API Zod Schemas", () => {
  it("parses live-shaped /admin/stats with TTFT snapshot and accounts", () => {
    const raw = {
      uptime_secs: 31,
      in_flight: 2,
      served: 100,
      failed_over: 4,
      refreshed: 1,
      ttft: { p50_ms: 120.5, p90_ms: 250.0, p99_ms: 450.0, samples: 10 },
      accounts: [
        {
          id: "acc-1@example.com",
          provider: "codex",
          health: { status: "available" },
          ok: 95,
          fails: 5,
          reset_at_unix_ms: null,
          last_error: {
            unix_ms: 1720000000000,
            status: 429,
            message: "rate limit exceeded",
          },
          ttft: { p50_ms: 110.0, p90_ms: 210.0, p99_ms: 310.0, samples: 95 },
          usage: {
            plan_type: "plus",
            active_limit: "5h",
            primary: {
              used_percent: 45.0,
              window_minutes: 300,
              reset_at_unix: 1720001000,
            },
            secondary: {
              used_percent: 80.0,
              window_minutes: 10080,
              reset_at_unix: 1720500000,
            },
            reset_credits_available: 2,
            observed_at_unix: 1720000000,
          },
        },
      ],
    };

    const parsed = parseAdminStats(raw);
    expect(parsed.uptime_secs).toBe(31);
    expect(parsed.in_flight).toBe(2);
    expect(parsed.served).toBe(100);
    expect(
      parsed.ttft !== null && typeof parsed.ttft === "object" ? parsed.ttft.p50_ms : null,
    ).toBe(120.5);
    expect(parsed.accounts[0]?.id).toBe("acc-1@example.com");
    expect(parsed.accounts[0]?.usage?.primary?.used_percent).toBe(45.0);
    expect(parsed.accounts[0]?.usage?.reset_credits_available).toBe(2);
  });

  it("handles null/missing TTFT and null usage gracefully", () => {
    const raw = {
      uptime_secs: 5,
      served: 0,
      failed_over: 0,
      accounts: [
        {
          id: "idle@provider.com",
          provider: "antigravity",
          health: "available",
          ok: 0,
          fails: 0,
          reset_at_unix_ms: null,
          last_error: null,
          ttft: null,
          usage: null,
        },
      ],
    };

    const parsed = parseAdminStats(raw);
    expect(parsed.accounts.length).toBe(1);
    expect(parsed.accounts[0]?.ttft).toBeNull();
    expect(parsed.accounts[0]?.usage).toBeNull();
    expect(parsed.accounts[0]?.health).toBe("available");
  });

  it("parses Antigravity usage groups", () => {
    const raw = {
      uptime_secs: 10,
      accounts: [
        {
          id: "ag@test.com",
          provider: "antigravity",
          health: { status: "available" },
          ok: 10,
          fails: 0,
          usage: {
            groups: [
              {
                display_name: "Claude 3.5 Sonnet",
                models: "claude-3-5-sonnet",
                buckets: [
                  {
                    display_name: "5h window",
                    used_percent: 20.0,
                    reset_at_unix: 1720005000,
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    const parsed = parseAdminStats(raw);
    expect(parsed.accounts[0]?.usage?.groups?.[0]?.display_name).toBe("Claude 3.5 Sonnet");
    expect(parsed.accounts[0]?.usage?.groups?.[0]?.buckets?.[0]?.used_percent).toBe(20.0);
  });

  it("parses /v0/management/auth-files response", () => {
    const raw = {
      files: [
        {
          name: "codex-1.json",
          size: 512,
          auth_index: "0a1b2c3d4e5f6789",
          path: "/tmp/auth/codex-1.json",
          label: "codex-1",
          type: "codex",
          email: "dev@company.com",
          modtime: 1720000000,
        },
      ],
    };

    const parsed = parseAuthFiles(raw);
    expect(parsed.files.length).toBe(1);
    expect(parsed.files[0]?.name).toBe("codex-1.json");
    expect(parsed.files[0]?.auth_index).toBe("0a1b2c3d4e5f6789");
    expect(parsed.files[0]?.email).toBe("dev@company.com");
  });

  it("parses /v0/management/logs response", () => {
    const raw = {
      lines: ["2026-08-29T10:00:00Z INFO starting gateway", "2026-08-29T10:00:01Z INFO ready"],
      "line-count": 2,
      "latest-timestamp": 1720000001,
    };

    const parsed = parseLogs(raw);
    expect(parsed.lines.length).toBe(2);
    expect(parsed["line-count"]).toBe(2);
  });
});

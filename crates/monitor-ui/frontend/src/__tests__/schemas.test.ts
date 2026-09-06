import { describe, expect, it } from "vitest";
import {
  HistoryEventSchema,
  HistoryTotalsSchema,
  parseAdminStats,
  parseAuthFiles,
  parseLogs,
} from "../lib/schemas";

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

  it("parses nullable quota labels from a restarted gateway snapshot", () => {
    // Given: a live-shaped account whose provider has no model or quota-window labels
    const raw = {
      uptime_secs: 10,
      accounts: [
        {
          id: "zcode",
          provider: "zcode",
          health: { status: "available" },
          ok: 0,
          fails: 0,
          usage: {
            groups: [
              {
                display_name: "GLM Coding Plan",
                models: null,
                buckets: [
                  {
                    display_name: "GLM-5.3",
                    window: null,
                    used_percent: 0,
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    // When: parsing the startup stats snapshot
    const parsed = parseAdminStats(raw);

    // Then: the account remains available to the GUI instead of rejecting all stats
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]?.usage?.groups?.[0]?.models).toBeNull();
    expect(parsed.accounts[0]?.usage?.groups?.[0]?.buckets[0]?.window).toBeNull();
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
      records: [
        {
          kind: "request",
          timestamp: 1756548000,
          provider: "codex",
          account: "codex-1",
          model: "gpt-5.6",
          status: 200,
          success: true,
          "latency-ms": 71,
          "bytes-in": 1169359,
        },
        { kind: "proxy", timestamp: 1756548001, message: "management: config updated" },
      ],
      "request-count": 1,
      "proxy-count": 1,
      "latest-timestamp": 1720000001,
    };

    const parsed = parseLogs(raw);
    expect(parsed.records.length).toBe(2);
    expect(parsed.records[0]?.kind).toBe("request");
    expect(parsed.records[0]?.status).toBe(200);
    expect(parsed.records[1]?.message).toContain("config updated");
    expect(parsed["request-count"]).toBe(1);
  });

  it("parses HistoryTotals and HistoryEvent with cache-write-tokens", () => {
    const rawTotals = {
      requests: 10,
      "successful-requests": 9,
      "failed-requests": 1,
      "input-tokens": 100,
      "output-tokens": 50,
      "cached-input-tokens": 20,
      "cache-write-tokens": 1234,
      "reasoning-tokens": 10,
      "total-tokens": 150,
      "estimated-cost-usd": 0.05,
    };
    const parsedTotals = HistoryTotalsSchema.parse(rawTotals);
    expect(parsedTotals["cache-write-tokens"]).toBe(1234);

    const { "cache-write-tokens": _omittedTotals, ...rawTotalsDefault } = rawTotals;
    const defaultTotals = HistoryTotalsSchema.parse(rawTotalsDefault);
    expect(defaultTotals["cache-write-tokens"]).toBe(0);

    const rawEvent = {
      "event-id": "event-1",
      "occurred-at-ms": 1720000000000,
      account: "acc-1",
      provider: "codex",
      model: "gpt-5.6",
      "key-label": null,
      status: 200,
      succeeded: true,
      "input-tokens": 100,
      "output-tokens": 50,
      "cached-input-tokens": 20,
      "cache-write-tokens": 1234,
      "reasoning-tokens": 10,
      "total-tokens": 150,
      "latency-ms": 80,
      "estimated-cost-usd": 0.01,
      "price-version": null,
    };
    const parsedEvent = HistoryEventSchema.parse(rawEvent);
    expect(parsedEvent["cache-write-tokens"]).toBe(1234);

    const { "cache-write-tokens": _omittedEvent, ...rawEventDefault } = rawEvent;
    const defaultEvent = HistoryEventSchema.parse(rawEventDefault);
    expect(defaultEvent["cache-write-tokens"]).toBe(0);
  });
});

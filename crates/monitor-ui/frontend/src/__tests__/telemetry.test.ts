import { describe, expect, it } from "vitest";
import type { AdminStats } from "../lib/schemas";
import {
  appendTelemetrySample,
  filterTelemetryRange,
  persistedTelemetrySamples,
  providerTotals,
  summarizeTelemetry,
} from "../lib/telemetry";

const snapshot = (served: number, ok: number, fails: number): AdminStats => ({
  uptime_secs: 10,
  in_flight: 1,
  served,
  failed_over: 0,
  refreshed: 0,
  ttft: { p50_ms: 100, p90_ms: 250, p99_ms: 500, samples: served },
  accounts: [
    {
      id: "hidden@example.com",
      provider: "codex",
      health: { status: "available" },
      ok,
      fails,
      reset_at_unix_ms: null,
      last_error: null,
      ttft: null,
      usage: null,
    },
  ],
  history: [],
});

describe("request telemetry sampling", () => {
  it("turns cumulative counters into bounded interval deltas", () => {
    const first = appendTelemetrySample([], snapshot(10, 9, 1), 1_000);
    const second = appendTelemetrySample(first, snapshot(14, 12, 2), 11_000);
    expect(second.at(-1)).toMatchObject({ requests: 4, successes: 3, failures: 1 });
    expect(second).toHaveLength(2);
  });

  it("treats process counter resets as a fresh interval", () => {
    const first = appendTelemetrySample([], snapshot(50, 48, 2), 1_000);
    const reset = appendTelemetrySample(first, snapshot(2, 2, 0), 11_000);
    expect(reset.at(-1)).toMatchObject({ requests: 2, successes: 2, failures: 0 });
  });

  it("aggregates providers without exposing account identities", () => {
    expect(providerTotals(snapshot(10, 9, 1))).toEqual([
      { provider: "codex", requests: 10, successes: 9, failures: 1 },
    ]);
  });

  it("hydrates chart samples from persisted minute buckets", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 4,
        successes: 3,
        failures: 1,
        providers: [{ provider: "codex", requests: 4, successes: 3, failures: 1 }],
      },
    ]);
    expect(samples[0]).toMatchObject({
      timestamp: 1_800_000,
      requests: 4,
      successes: 3,
      failures: 1,
    });
  });

  it("filters persisted samples to each selected time range", () => {
    const now = 2_000_000_000_000;
    const samples = [
      { timestamp: now - 31 * 60_000, requests: 5 },
      { timestamp: now - 29 * 60_000, requests: 3 },
      { timestamp: now - 10 * 60_000, requests: 2 },
    ] as const;
    expect(filterTelemetryRange(samples, "30m", now).map((sample) => sample.requests)).toEqual([
      3, 2,
    ]);
    expect(filterTelemetryRange(samples, "1h", now)).toHaveLength(3);
  });

  it("summarizes requests outcomes and providers inside the selected range", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 4,
        successes: 3,
        failures: 1,
        providers: [{ provider: "codex", requests: 4, successes: 3, failures: 1 }],
      },
      {
        minute_unix: 1_860,
        requests: 2,
        successes: 2,
        failures: 0,
        providers: [{ provider: "claude", requests: 2, successes: 2, failures: 0 }],
      },
    ]);
    expect(summarizeTelemetry(samples)).toEqual({
      requests: 6,
      successes: 5,
      failures: 1,
      providers: [
        { provider: "codex", requests: 4, successes: 3, failures: 1 },
        { provider: "claude", requests: 2, successes: 2, failures: 0 },
      ],
    });
  });
});

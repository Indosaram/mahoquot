import { describe, expect, it } from "vitest";
import type { AdminStats } from "../lib/schemas";
import {
  appendTelemetrySample,
  filterTelemetryRange,
  persistedTelemetrySamples,
  providerTotals,
  summarizeTelemetry,
  telemetrySeries,
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

  it("places a burst at its real position in the window instead of stretching it", () => {
    const now = 2_000_000_000_000;
    // Two buckets one minute apart, viewed through a 1d window: the burst is
    // recent, so it must land at the right edge rather than spanning the axis.
    const series = telemetrySeries(
      [
        { timestamp: now - 60_000, requests: 3_200, successes: 3_200, failures: 0 },
        { timestamp: now - 1_000, requests: 801, successes: 801, failures: 0 },
      ],
      "1d",
      now,
      24,
    );
    expect(series).toHaveLength(24);
    expect(series.at(-1)?.requests).toBe(4_001);
    // Everything before the final bucket is genuinely idle.
    expect(series.slice(0, -1).every((point) => point.requests === 0)).toBe(true);
  });

  it("zero-fills idle buckets instead of interpolating across the gap", () => {
    const now = 2_000_000_000_000;
    const series = telemetrySeries(
      [
        { timestamp: now - 55 * 60_000, requests: 10, successes: 10, failures: 0 },
        { timestamp: now - 5 * 60_000, requests: 20, successes: 20, failures: 0 },
      ],
      "1h",
      now,
      6,
    );
    expect(series.map((point) => point.requests)).toEqual([10, 0, 0, 0, 0, 20]);
  });

  it("spaces buckets by elapsed time, not by sample ordering", () => {
    const now = 2_000_000_000_000;
    const series = telemetrySeries(
      [
        { timestamp: now - 50 * 60_000, requests: 5, successes: 5, failures: 0 },
        { timestamp: now - 6 * 60_000, requests: 7, successes: 7, failures: 0 },
        { timestamp: now - 2 * 60_000, requests: 9, successes: 9, failures: 0 },
      ],
      "1h",
      now,
      6,
    );
    // Index-based bucketing would emit 5/7/9 across three evenly spaced slots.
    // With 10-minute buckets, -50m lands in bucket 1 and the two recent samples
    // collapse into the final bucket.
    expect(series.map((point) => point.requests)).toEqual([0, 5, 0, 0, 0, 16]);
  });

  it("reports a stable window even when no traffic was recorded", () => {
    const now = 2_000_000_000_000;
    const series = telemetrySeries([], "30m", now, 4);
    expect(series).toHaveLength(4);
    expect(series.every((point) => point.requests === 0)).toBe(true);
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

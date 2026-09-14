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
      id: "alpha",
      provider: "codex",
      health: { status: "available" },
      ok,
      fails,
      reset_at_unix_ms: null,
      last_error: null,
      ttft: null,
      usage: null,
    },
    {
      id: "bravo",
      provider: "codex",
      health: { status: "available" },
      ok: 0,
      fails: 0,
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
        accounts: [{ account: "alpha", requests: 4, successes: 3, failures: 1 }],
      },
    ]);
    expect(samples[0]).toMatchObject({
      timestamp: 1_800_000,
      requests: 4,
      successes: 3,
      failures: 1,
      accounts: [{ id: "alpha", requests: 4, successes: 3, failures: 1 }],
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

  it("carries per-account deltas alongside the pooled totals", () => {
    const first = appendTelemetrySample([], snapshot(10, 9, 1), 1_000);
    const second = appendTelemetrySample(first, snapshot(14, 12, 2), 11_000);
    expect(second.at(-1)?.accounts).toEqual([
      { id: "alpha", requests: 4, successes: 3, failures: 1 },
      { id: "bravo", requests: 0, successes: 0, failures: 0 },
    ]);
  });

  it("reports a stable window even when no traffic was recorded", () => {
    const now = 2_000_000_000_000;
    const series = telemetrySeries([], "30m", now, 4);
    expect(series).toHaveLength(4);
    expect(series.every((point) => point.requests === 0)).toBe(true);
  });

  it("carries per-account deltas alongside the pooled totals", () => {
    const first = appendTelemetrySample([], snapshot(10, 9, 1), 1_000);
    const second = appendTelemetrySample(first, snapshot(14, 12, 2), 11_000);
    expect(second.at(-1)?.accounts).toEqual([
      { id: "alpha", requests: 4, successes: 3, failures: 1 },
      { id: "bravo", requests: 0, successes: 0, failures: 0 },
    ]);
  });

  it("buckets each account's series separately with idle windows zero-filled", () => {
    const now = 2_000_000_000_000;
    const base = {
      served: 0,
      successes: 0,
      failures: 0,
      inFlight: 0,
      p50Ms: 0,
      p90Ms: 0,
      providers: [],
    };
    const samples = [
      {
        timestamp: now - 50 * 60_000,
        requests: 6,
        successes: 6,
        failures: 0,
        accounts: [{ id: "alpha", requests: 6, successes: 6, failures: 0 }],
      },
      {
        timestamp: now - 2 * 60_000,
        requests: 4,
        successes: 4,
        failures: 0,
        accounts: [{ id: "bravo", requests: 4, successes: 4, failures: 0 }],
      },
    ].map((s) => ({ ...base, ...s }));
    expect(telemetrySeries(samples, "1h", now, 6).map((point) => point.requests)).toEqual([
      0, 6, 0, 0, 0, 4,
    ]);
  });

  it("preserves bucket and per-account token fields from persisted telemetry", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 4,
        successes: 3,
        failures: 1,
        input_tokens: 1_200,
        output_tokens: 300,
        providers: [{ provider: "codex", requests: 4, successes: 3, failures: 1 }],
        accounts: [
          {
            account: "alpha",
            requests: 4,
            successes: 3,
            failures: 1,
            input_tokens: 1_200,
            output_tokens: 300,
          },
        ],
      },
    ]);
    expect(samples[0]).toMatchObject({
      inputTokens: 1_200,
      outputTokens: 300,
      totalTokens: 1_500,
      accounts: [
        {
          id: "alpha",
          inputTokens: 1_200,
          outputTokens: 300,
          totalTokens: 1_500,
        },
      ],
    });
  });

  it("summarizes overall and per-account token totals from filtered samples", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 4,
        successes: 3,
        failures: 1,
        input_tokens: 1_000,
        output_tokens: 200,
        providers: [{ provider: "codex", requests: 4, successes: 3, failures: 1 }],
        accounts: [
          {
            account: "alpha",
            requests: 4,
            successes: 3,
            failures: 1,
            input_tokens: 1_000,
            output_tokens: 200,
          },
        ],
      },
      {
        minute_unix: 1_860,
        requests: 2,
        successes: 2,
        failures: 0,
        input_tokens: 500,
        output_tokens: 100,
        providers: [{ provider: "claude", requests: 2, successes: 2, failures: 0 }],
        accounts: [
          {
            account: "bravo",
            requests: 2,
            successes: 2,
            failures: 0,
            input_tokens: 500,
            output_tokens: 100,
          },
        ],
      },
    ]);
    const summary = summarizeTelemetry(samples);
    expect(summary.tokenTotals).toMatchObject({
      inputTokens: 1_500,
      outputTokens: 300,
      totalTokens: 1_800,
    });
    expect(summary.accountTokens).toMatchObject([
      { id: "alpha", inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
      { id: "bravo", inputTokens: 500, outputTokens: 100, totalTokens: 600 },
    ]);
    expect(summary.hasTokenData).toBe(true);
  });

  it("R1 regression: derives interval deltas across three consecutive counter polls", () => {
    const makeSnapshot = (tokens: number): AdminStats => ({
      uptime_secs: 100,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "alpha",
          provider: "openai",
          health: "healthy",
          ok: 1,
          fails: 0,
          input_tokens: tokens,
          output_tokens: 0,
        },
      ],
    });

    const s1 = appendTelemetrySample([], makeSnapshot(100), 1_000);
    const s2 = appendTelemetrySample(s1, makeSnapshot(110), 2_000);
    const s3 = appendTelemetrySample(s2, makeSnapshot(120), 3_000);

    // Initial baseline establishes starting point (undefined for interval with requests to avoid fake zero measurement), then delta = 10, then delta = 10
    expect(s1[0].accounts[0].inputTokens).toBeUndefined();
    expect(s2[1].accounts[0].inputTokens).toBe(10);
    expect(s3[2].accounts[0].inputTokens).toBe(10);

    // If counter stays stationary, delta must be 0
    const s4 = appendTelemetrySample(s3, makeSnapshot(120), 4_000);
    expect(s4[3].accounts[0].inputTokens).toBe(0);
  });

  it("R1 regression: establishes baseline for new accounts and accounts that temporarily disappear", () => {
    const makeAccountsSnapshot = (accs: { id: string; tokens: number }[]): AdminStats => ({
      uptime_secs: 100,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: accs.map((a) => ({
        id: a.id,
        provider: "openai",
        health: "healthy",
        ok: 1,
        fails: 0,
        input_tokens: a.tokens,
        output_tokens: 0,
      })),
    });

    // Case 1: First poll has empty accounts, second poll introduces account 'b' with 1000
    const p1 = appendTelemetrySample([], makeAccountsSnapshot([]), 1_000);
    const p2 = appendTelemetrySample(p1, makeAccountsSnapshot([{ id: "b", tokens: 1000 }]), 2_000);
    expect(p2[1].accounts[0].inputTokens).toBeUndefined(); // Baseline established, no 1000 burst and no fake zero!

    const p3 = appendTelemetrySample(p2, makeAccountsSnapshot([{ id: "b", tokens: 1010 }]), 3_000);
    expect(p3[2].accounts[0].inputTokens).toBe(10); // Normal 10 delta

    // Case 2: Account 'a' is 100 -> 110 -> disappears -> reappears with 110
    const q1 = appendTelemetrySample([], makeAccountsSnapshot([{ id: "a", tokens: 100 }]), 1_000);
    const q2 = appendTelemetrySample(q1, makeAccountsSnapshot([{ id: "a", tokens: 110 }]), 2_000);
    expect(q2[1].accounts[0].inputTokens).toBe(10);

    const q3 = appendTelemetrySample(q2, makeAccountsSnapshot([]), 3_000); // Disappears
    expect(q3[2].accounts).toHaveLength(0);

    const q4 = appendTelemetrySample(q3, makeAccountsSnapshot([{ id: "a", tokens: 110 }]), 4_000); // Re-appears with 110
    expect(q4[3].accounts[0].inputTokens).toBe(0); // Did not add 110 again!
  });

  it("R2 regression: derives missing bucket output tokens from account tokens independently", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 4,
        successes: 4,
        failures: 0,
        input_tokens: 100,
        // output_tokens omitted
        providers: [],
        accounts: [
          {
            account: "alpha",
            requests: 4,
            successes: 4,
            failures: 0,
            input_tokens: 100,
            output_tokens: 20,
          },
        ],
      },
    ]);
    const summary = summarizeTelemetry(samples);
    expect(summary.tokenTotals).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    expect(summary.accountTokens).toMatchObject([
      { id: "alpha", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    ]);
  });

  it("R1 regression: establishes per-field baseline when field is new or omitted temporarily", () => {
    // 1. Account exists without tokens -> input_tokens appears as 1000
    const snap1 = {
      uptime_secs: 100,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: [{ id: "a", provider: "openai", health: "healthy", ok: 1, fails: 0 }],
    };
    const snap2 = {
      uptime_secs: 200,
      in_flight: 0,
      served: 2,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        { id: "a", provider: "openai", health: "healthy", ok: 2, fails: 0, input_tokens: 1000 },
      ],
    };
    const s1 = appendTelemetrySample([], snap1, 1_000);
    const s2 = appendTelemetrySample(s1, snap2, 2_000);
    expect(s2[1].accounts[0].inputTokens).toBeUndefined(); // Baseline established with requests, not fake 0!

    // 2. a: input 100 -> 110 -> input omitted -> input 110
    const mk = (inTok?: number, outTok?: number): AdminStats => ({
      uptime_secs: 100,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "a",
          provider: "openai",
          health: "healthy",
          ok: 1,
          fails: 0,
          input_tokens: inTok,
          output_tokens: outTok,
        },
      ],
    });
    const r1 = appendTelemetrySample([], mk(100, undefined), 1_000);
    const r2 = appendTelemetrySample(r1, mk(110, undefined), 2_000);
    expect(r2[1].accounts[0].inputTokens).toBe(10);

    const r3 = appendTelemetrySample(r2, mk(undefined, undefined), 3_000);
    expect(r3[2].accounts[0].inputTokens).toBeUndefined();

    const r4 = appendTelemetrySample(r3, mk(110, undefined), 4_000);
    expect(r4[3].accounts[0].inputTokens).toBe(0); // Kept baseline 110, delta is 0!

    // 3. Existing account has input only, output 50 appears for first time
    const r5 = appendTelemetrySample(r4, mk(110, 50), 5_000);
    expect(r5[4].accounts[0].outputTokens).toBe(0); // Baseline established for output!
    const r6 = appendTelemetrySample(r5, mk(110, 60), 6_000);
    expect(r6[5].accounts[0].outputTokens).toBe(10); // Normal delta 10!
  });

  it("R2 regression: derives overall totals when buckets have account-only or mixed tokens", () => {
    // Case 1: Bucket without bucket-level tokens but with account tokens
    const samples1 = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 4,
        successes: 4,
        failures: 0,
        providers: [],
        accounts: [
          {
            account: "alpha",
            requests: 4,
            successes: 4,
            failures: 0,
            input_tokens: 100,
            output_tokens: 20,
          },
        ],
      },
    ]);
    const summary1 = summarizeTelemetry(samples1);
    expect(summary1.tokenTotals).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    expect(summary1.hasTokenData).toBe(true);

    // Case 2: Mixed buckets (bucket 1 has bucket-level 60 tokens, bucket 2 has account-level 120 tokens)
    const samples2 = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 2,
        successes: 2,
        failures: 0,
        input_tokens: 50,
        output_tokens: 10,
        providers: [],
        accounts: [],
      },
      {
        minute_unix: 1_860,
        requests: 4,
        successes: 4,
        failures: 0,
        providers: [],
        accounts: [
          {
            account: "alpha",
            requests: 4,
            successes: 4,
            failures: 0,
            input_tokens: 100,
            output_tokens: 20,
          },
        ],
      },
    ]);
    const summary2 = summarizeTelemetry(samples2);
    expect(summary2.tokenTotals).toMatchObject({
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
    });
  });

  it("preserves undefined outputTokens on sample and marks partial when account has input only", () => {
    const mk = (inTok?: number, outTok?: number): AdminStats => ({
      uptime_secs: 100,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "a",
          provider: "openai",
          health: "healthy",
          ok: 1,
          fails: 0,
          input_tokens: inTok,
          output_tokens: outTok,
        },
      ],
    });
    const r1 = appendTelemetrySample([], mk(100, undefined), 1_000);
    const r2 = appendTelemetrySample(r1, mk(110, undefined), 2_000);
    expect(r2[1].accounts[0].inputTokens).toBe(10);
    expect(r2[1].accounts[0].outputTokens).toBeUndefined();
    expect(r2[1].inputTokens).toBe(10);
    expect(r2[1].outputTokens).toBeUndefined();

    const summary = summarizeTelemetry(r2);
    expect(summary.tokenTotals.isInputSupported).toBe(true);
    expect(summary.tokenTotals.isOutputSupported).toBe(false);
    expect(summary.tokenTotals.isPartial).toBe(true);
    expect(summary.tokenTotals.totalTokens).toBe(10);
  });

  it("marks isPartial=true when bucket has account with tokens and another account with requests but no tokens", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 2,
        successes: 2,
        failures: 0,
        providers: [],
        accounts: [
          {
            account: "acc-with-tokens",
            requests: 1,
            successes: 1,
            failures: 0,
            input_tokens: 100,
            output_tokens: 20,
          },
          {
            account: "acc-without-tokens",
            requests: 1,
            successes: 1,
            failures: 0,
            // no tokens
          },
        ],
      },
    ]);
    const summary = summarizeTelemetry(samples);
    expect(summary.tokenTotals.totalTokens).toBe(120);
    expect(summary.tokenTotals.isPartial).toBe(true);
  });

  it("marks isPartial=false when server explicitly provides bucket-level totals even if account details omit tokens", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 2,
        successes: 2,
        failures: 0,
        input_tokens: 1_000,
        output_tokens: 200,
        providers: [],
        accounts: [
          {
            account: "acc-without-tokens",
            requests: 2,
            successes: 2,
            failures: 0,
            // no account token breakdown
          },
        ],
      },
    ]);
    const summary = summarizeTelemetry(samples);
    expect(summary.tokenTotals.totalTokens).toBe(1_200);
    expect(summary.tokenTotals.isPartial).toBe(false);
  });

  it("marks isPartial=false when input is from server bucket and output is from complete account details", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 1,
        successes: 1,
        failures: 0,
        input_tokens: 100,
        // bucket output omitted
        providers: [],
        accounts: [
          {
            account: "acc-with-output",
            requests: 1,
            successes: 1,
            failures: 0,
            // input omitted on account
            output_tokens: 20,
          },
        ],
      },
    ]);
    const summary = summarizeTelemetry(samples);
    expect(summary.tokenTotals.inputTokens).toBe(100);
    expect(summary.tokenTotals.outputTokens).toBe(20);
    expect(summary.tokenTotals.totalTokens).toBe(120);
    expect(summary.tokenTotals.isPartial).toBe(false);
  });

  it("R1 regression: marks isPartial=true when polling-derived sample has missing account tokens", () => {
    const s1: AdminStats = {
      uptime_secs: 10,
      in_flight: 0,
      served: 0,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "a",
          provider: "openai",
          health: "healthy",
          ok: 0,
          fails: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
        { id: "b", provider: "anthropic", health: "healthy", ok: 0, fails: 0 },
      ],
    };
    const s2: AdminStats = {
      uptime_secs: 20,
      in_flight: 0,
      served: 2,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "a",
          provider: "openai",
          health: "healthy",
          ok: 1,
          fails: 0,
          input_tokens: 10,
          output_tokens: 5,
        },
        { id: "b", provider: "anthropic", health: "healthy", ok: 1, fails: 0 },
      ],
    };
    const r1 = appendTelemetrySample([], s1, 1_000);
    const r2 = appendTelemetrySample(r1, s2, 2_000);

    const summary = summarizeTelemetry([r2[1]]);
    expect(summary.requests).toBe(2);
    expect(summary.tokenTotals.totalTokens).toBe(15);
    expect(summary.tokenTotals.isPartial).toBe(true);
  });

  it("R4 regression: establishing baseline with requests is reported as partial unknown usage, not complete zero", () => {
    const s1: AdminStats = {
      uptime_secs: 10,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "a",
          provider: "openai",
          health: "healthy",
          ok: 1,
          fails: 0,
          input_tokens: 1_000,
          output_tokens: 200,
        },
      ],
    };
    const r1 = appendTelemetrySample([], s1, 1_000);
    expect(r1[0].accounts[0].inputTokens).toBeUndefined();
    expect(r1[0].accounts[0].outputTokens).toBeUndefined();

    const summary = summarizeTelemetry(r1);
    expect(summary.requests).toBe(1);
    expect(summary.hasTokenData).toBe(false);
  });

  it("R5 regression: marks isPartial=true when sample requests exceed account coverage", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 2,
        successes: 2,
        failures: 0,
        providers: [],
        accounts: [
          {
            account: "alpha",
            requests: 1,
            successes: 1,
            failures: 0,
            input_tokens: 100,
            output_tokens: 20,
          },
        ],
      },
    ]);
    const summary = summarizeTelemetry(samples);
    expect(summary.requests).toBe(2);
    expect(summary.tokenTotals.totalTokens).toBe(120);
    expect(summary.tokenTotals.isPartial).toBe(true);
  });

  it("R6 regression: account rows preserve per-account support and partial flags", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 1,
        successes: 1,
        failures: 0,
        providers: [],
        accounts: [
          {
            account: "input-only-acc",
            requests: 1,
            successes: 1,
            failures: 0,
            input_tokens: 100,
            // output missing
          },
        ],
      },
    ]);
    const summary = summarizeTelemetry(samples);
    expect(summary.accountTokens[0].inputTokens).toBe(100);
    expect(summary.accountTokens[0].outputTokens).toBeUndefined();
    expect(summary.accountTokens[0].isInputSupported).toBe(true);
    expect(summary.accountTokens[0].isOutputSupported).toBe(false);
    expect(summary.accountTokens[0].isPartial).toBe(true);
  });

  it("R6 regression: marks account row isPartial=true when an active interval has both token fields missing", () => {
    // 1. Measured interval followed by tokenless active interval
    const s1 = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 1,
        successes: 1,
        failures: 0,
        providers: [],
        accounts: [
          {
            account: "acc1",
            requests: 1,
            successes: 1,
            failures: 0,
            input_tokens: 100,
            output_tokens: 20,
          },
        ],
      },
      {
        minute_unix: 1_860,
        requests: 1,
        successes: 1,
        failures: 0,
        providers: [],
        accounts: [{ account: "acc1", requests: 1, successes: 1, failures: 0 }],
      },
    ]);
    const summary1 = summarizeTelemetry(s1);
    expect(summary1.tokenTotals.totalTokens).toBe(120);
    expect(summary1.tokenTotals.isPartial).toBe(true);
    expect(summary1.accountTokens[0].totalTokens).toBe(120);
    expect(summary1.accountTokens[0].isPartial).toBe(true);

    // 2. Tokenless active interval followed by measured interval
    const s2 = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 1,
        successes: 1,
        failures: 0,
        providers: [],
        accounts: [{ account: "acc1", requests: 1, successes: 1, failures: 0 }],
      },
      {
        minute_unix: 1_860,
        requests: 1,
        successes: 1,
        failures: 0,
        providers: [],
        accounts: [
          {
            account: "acc1",
            requests: 1,
            successes: 1,
            failures: 0,
            input_tokens: 100,
            output_tokens: 20,
          },
        ],
      },
    ]);
    const summary2 = summarizeTelemetry(s2);
    expect(summary2.tokenTotals.totalTokens).toBe(120);
    expect(summary2.tokenTotals.isPartial).toBe(true);
    expect(summary2.accountTokens[0].totalTokens).toBe(120);
    expect(summary2.accountTokens[0].isPartial).toBe(true);

    // 3. Control: measured interval + idle tokenless interval (requests = 0)
    const s3 = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 1,
        successes: 1,
        failures: 0,
        providers: [],
        accounts: [
          {
            account: "acc1",
            requests: 1,
            successes: 1,
            failures: 0,
            input_tokens: 100,
            output_tokens: 20,
          },
        ],
      },
      {
        minute_unix: 1_860,
        requests: 0,
        successes: 0,
        failures: 0,
        providers: [],
        accounts: [{ account: "acc1", requests: 0, successes: 0, failures: 0 }],
      },
    ]);
    const summary3 = summarizeTelemetry(s3);
    expect(summary3.tokenTotals.totalTokens).toBe(120);
    expect(summary3.tokenTotals.isPartial).toBe(false);
    expect(summary3.accountTokens[0].totalTokens).toBe(120);
    expect(summary3.accountTokens[0].isPartial).toBe(false);
  });

  it("R3 regression: does not attribute gap counters to current window upon omission recovery", () => {
    // Account active with 100/20, then omitted over a gap, then reappears with 1100/220 and 0 requests
    const snap1: AdminStats = {
      uptime_secs: 10,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "acc1",
          provider: "openai",
          health: "healthy",
          ok: 1,
          fails: 0,
          input_tokens: 100,
          output_tokens: 20,
        },
      ],
    };
    const snap2Omitted: AdminStats = {
      uptime_secs: 100,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: [], // acc1 omitted
    };
    const snap3Reappear: AdminStats = {
      uptime_secs: 200,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "acc1",
          provider: "openai",
          health: "healthy",
          ok: 1,
          fails: 0,
          input_tokens: 1_100,
          output_tokens: 220,
        },
      ],
    };

    const p1 = appendTelemetrySample([], snap1, 1_000);
    const p2 = appendTelemetrySample(p1, snap2Omitted, 2_000);
    const p3 = appendTelemetrySample(p2, snap3Reappear, 3_000);

    // Upon reappearing after gap with 0 new requests, interval delta must be 0, NOT 1000/200
    expect(p3[2].accounts[0].inputTokens).toBe(0);
    expect(p3[2].accounts[0].outputTokens).toBe(0);
    expect(p3[2].accounts[0].totalTokens).toBe(0);
  });

  it("P1 regression: asymmetric omission recovery rebaselines only the returning field without gap leakage", () => {
    // Sequence:
    // t-120m: ok=10, input=100, output=20
    // t-60m:  ok=20, input=omitted, output=40
    // t-1m:   ok=20, input=1100, output=40 (idle recovery of input)
    // t:      ok=21, input=1110, output=50 (normal next poll)
    const snap1: AdminStats = {
      uptime_secs: 10,
      in_flight: 0,
      served: 10,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "acc1",
          provider: "openai",
          health: "healthy",
          ok: 10,
          fails: 0,
          input_tokens: 100,
          output_tokens: 20,
        },
      ],
    };
    const snap2InputOmitted: AdminStats = {
      uptime_secs: 60,
      in_flight: 0,
      served: 20,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        { id: "acc1", provider: "openai", health: "healthy", ok: 20, fails: 0, output_tokens: 40 },
      ], // input omitted
    };
    const snap3InputReappear: AdminStats = {
      uptime_secs: 120,
      in_flight: 0,
      served: 20,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "acc1",
          provider: "openai",
          health: "healthy",
          ok: 20,
          fails: 0,
          input_tokens: 1_100,
          output_tokens: 40,
        },
      ],
    };
    const snap4Normal: AdminStats = {
      uptime_secs: 180,
      in_flight: 0,
      served: 21,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        {
          id: "acc1",
          provider: "openai",
          health: "healthy",
          ok: 21,
          fails: 0,
          input_tokens: 1_110,
          output_tokens: 50,
        },
      ],
    };

    const p1 = appendTelemetrySample([], snap1, 1_000);
    const p2 = appendTelemetrySample(p1, snap2InputOmitted, 2_000);
    expect(p2[1].accounts[0].inputTokens).toBeUndefined();
    expect(p2[1].accounts[0].outputTokens).toBe(20);

    const p3 = appendTelemetrySample(p2, snap3InputReappear, 3_000);
    // Returning input rebaselines to 0 (no 1000 burst!), continuing output is delta 0
    expect(p3[2].accounts[0].inputTokens).toBe(0);
    expect(p3[2].accounts[0].outputTokens).toBe(0);
    expect(p3[2].accounts[0].totalTokens).toBe(0);

    const p4 = appendTelemetrySample(p3, snap4Normal, 4_000);
    // Following poll computes normal deltas (1110-1100=10, 50-40=10)
    expect(p4[3].accounts[0].inputTokens).toBe(10);
    expect(p4[3].accounts[0].outputTokens).toBe(10);
    expect(p4[3].accounts[0].totalTokens).toBe(20);
  });

  it("summarizes requests outcomes and providers inside the selected range", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 4,
        successes: 3,
        failures: 1,
        providers: [{ provider: "codex", requests: 4, successes: 3, failures: 1 }],
        accounts: [{ account: "codex", requests: 4, successes: 3, failures: 1 }],
      },
      {
        minute_unix: 1_860,
        requests: 2,
        successes: 2,
        failures: 0,
        providers: [{ provider: "claude", requests: 2, successes: 2, failures: 0 }],
        accounts: [{ account: "claude", requests: 2, successes: 2, failures: 0 }],
      },
    ]);
    expect(summarizeTelemetry(samples)).toMatchObject({
      requests: 6,
      successes: 5,
      failures: 1,
      providers: [
        { provider: "codex", requests: 4, successes: 3, failures: 1 },
        { provider: "claude", requests: 2, successes: 2, failures: 0 },
      ],
    });
  });

  it("does not inflate per-provider rows by summing cumulative totals", () => {
    // appendTelemetrySample stores per-provider figures that summarizeTelemetry
    // sums across samples, so they must be per-sample deltas like the
    // top-level fields - not the cumulative counters carried in AdminStats.
    const first = appendTelemetrySample([], snapshot(10, 10, 0), 1_000);
    const second = appendTelemetrySample(first, snapshot(20, 20, 0), 2_000);
    const third = appendTelemetrySample(second, snapshot(30, 30, 0), 3_000);
    const summary = summarizeTelemetry(third);
    const codex = summary.providers.find((provider) => provider.provider === "codex");
    expect(codex?.successes).toBe(summary.successes);
    expect(summary.successes).toBe(30);
  });
});

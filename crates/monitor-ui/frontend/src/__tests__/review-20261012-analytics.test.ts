import { describe, expect, it } from "vitest";
import type { NormalizedAccount } from "../lib/accounts";
import { resolveAccountIdentity } from "../lib/dimension-identity";
import { groupNotchProviders } from "../lib/notch";
import {
  buildAnalytics,
  buildOverviewQueries,
  telemetryAnalytics,
} from "../lib/overview-analytics";
import type { AdminStats, HistoryStatsResponse, HistoryTotals } from "../lib/schemas";
import {
  type TelemetrySample,
  appendTelemetrySample,
  filterTelemetryRange,
  persistedTelemetrySamples,
  telemetrySeries,
} from "../lib/telemetry";

const stats = (
  accounts: readonly { id: string; provider: string; ok: number; fails?: number }[],
  served = 0,
): AdminStats =>
  ({
    uptime_secs: 10,
    in_flight: 0,
    served,
    failed_over: 0,
    refreshed: 0,
    accounts: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      health: "healthy",
      ok: a.ok,
      fails: a.fails ?? 0,
    })),
  }) as unknown as AdminStats;

const providerOf = (sample: TelemetrySample | undefined, provider: string) =>
  sample?.providerDeltas?.find((p) => p.provider === provider);

describe("telemetry baselines (review 20261012 items 1, 2)", () => {
  it("item 1: provider deltas do not spike when an account leaves the set", () => {
    const first = appendTelemetrySample(
      [],
      stats([
        { id: "a", provider: "codex", ok: 500 },
        { id: "b", provider: "codex", ok: 500 },
      ]),
      1_000,
    );
    const second = appendTelemetrySample(
      first,
      stats([{ id: "a", provider: "codex", ok: 500 }]),
      11_000,
    );
    expect(providerOf(second.at(-1), "codex")).toMatchObject({ requests: 0, successes: 0 });
    expect(second.at(-1)?.successes).toBe(0);
  });

  it("item 1: provider deltas do not spike when an account joins with lifetime counters", () => {
    const first = appendTelemetrySample([], stats([{ id: "a", provider: "codex", ok: 10 }]), 1_000);
    const second = appendTelemetrySample(
      first,
      stats([
        { id: "a", provider: "codex", ok: 13 },
        { id: "b", provider: "codex", ok: 300 },
      ]),
      11_000,
    );
    expect(providerOf(second.at(-1), "codex")).toMatchObject({ requests: 3, successes: 3 });
    expect(second.at(-1)?.successes).toBe(3);
  });

  it("item 2: the first sample baselines instead of emitting lifetime counters", () => {
    const [sample] = appendTelemetrySample(
      [],
      stats([{ id: "a", provider: "codex", ok: 40, fails: 10 }], 50),
      1_000,
    );
    expect(sample).toMatchObject({ requests: 0, successes: 0, failures: 0 });
    expect(sample?.accounts[0]).toMatchObject({ requests: 0, successes: 0, failures: 0 });
    expect(providerOf(sample, "codex")).toMatchObject({ requests: 0, successes: 0, failures: 0 });
    // Raw totals stay cumulative for the next poll's baseline.
    expect(sample?.served).toBe(50);
  });

  it("item 2: a persisted history sample is never used as a cumulative baseline", () => {
    const persisted = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 4,
        successes: 4,
        failures: 0,
        providers: [{ provider: "codex", requests: 4, successes: 4, failures: 0 }],
        accounts: [{ account: "a", requests: 4, successes: 4, failures: 0 }],
      },
    ]);
    const next = appendTelemetrySample(
      persisted,
      stats([{ id: "a", provider: "codex", ok: 9_000 }], 9_000),
      2_000_000,
    );
    expect(next.at(-1)).toMatchObject({ requests: 0, successes: 0, failures: 0 });
    expect(providerOf(next.at(-1), "codex")).toMatchObject({ requests: 0 });
    expect(next.at(-1)?.accounts[0]).toMatchObject({ requests: 0, successes: 0 });
  });

  it("item 2: an account returning after an omission contributes 0 outcome delta", () => {
    const s1 = appendTelemetrySample([], stats([{ id: "a", provider: "codex", ok: 10 }]), 1_000);
    const s2 = appendTelemetrySample(s1, stats([]), 2_000);
    const s3 = appendTelemetrySample(s2, stats([{ id: "a", provider: "codex", ok: 410 }]), 3_000);
    expect(s3.at(-1)).toMatchObject({ successes: 0, failures: 0 });
    expect(s3.at(-1)?.accounts[0]).toMatchObject({ requests: 0, successes: 0, failures: 0 });
    expect(providerOf(s3.at(-1), "codex")).toMatchObject({ requests: 0 });
    const s4 = appendTelemetrySample(s3, stats([{ id: "a", provider: "codex", ok: 412 }]), 4_000);
    expect(s4.at(-1)).toMatchObject({ successes: 2 });
  });
});

describe("telemetry range (review 20261012 item 8)", () => {
  const now = 2_000_000_030_000; // 30s past a minute boundary

  it("keeps the minute bucket straddling the window edge", () => {
    const edgeMinute = Math.floor((now - 30 * 60_000) / 60_000) * 60_000;
    const samples = [{ timestamp: edgeMinute, requests: 1 }];
    expect(edgeMinute).toBeLessThan(now - 30 * 60_000);
    expect(filterTelemetryRange(samples, "30m", now)).toHaveLength(1);
    expect(filterTelemetryRange([{ timestamp: edgeMinute - 60_000 }], "30m", now)).toHaveLength(0);
  });

  it("rejects future-dated samples instead of clamping them into the last bucket", () => {
    const future = { timestamp: now + 30_000, requests: 99, successes: 99, failures: 0 };
    expect(filterTelemetryRange([future], "30m", now)).toHaveLength(0);
    const series = telemetrySeries([future], "30m", now, 30);
    expect(series.every((point) => point.requests === 0)).toBe(true);
  });
});

const defaultTotals: HistoryTotals = {
  requests: 0,
  "successful-requests": 0,
  "failed-requests": 0,
  "input-tokens": 0,
  "output-tokens": 0,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 0,
  "estimated-cost-usd": 0,
};

const response = (groups: HistoryStatsResponse["groups"] = []): HistoryStatsResponse => ({
  totals: defaultTotals,
  groups,
});

const group = (
  overrides: Partial<HistoryStatsResponse["groups"][number]> & { requests?: number },
): HistoryStatsResponse["groups"][number] => {
  const { requests, ...rest } = overrides;
  return {
    "bucket-start-ms": null,
    model: null,
    provider: null,
    account: null,
    "key-label": null,
    status: null,
    totals: { ...defaultTotals, requests: requests ?? 0 },
    ...rest,
  } as HistoryStatsResponse["groups"][number];
};

const makeAccount = (id: string, email: string, provider: string): NormalizedAccount =>
  ({
    id,
    runtimeId: null,
    credentialName: null,
    disabled: false,
    authIndex: null,
    provider,
    plan: null,
    email,
    label: id,
  }) as unknown as NormalizedAccount;

describe("history grid (review 20261012 item 4)", () => {
  const hour = 3_600_000;
  const nowMs = 1_700_000_000_000; // 20 minutes past an hour boundary
  const currentHour = Math.floor(nowMs / hour) * hour;

  it("aligns the grid to bucket boundaries and drops out-of-window buckets", () => {
    expect(currentHour).not.toBe(nowMs);
    const analytics = buildAnalytics({
      ranking: response([group({ provider: "codex", requests: 107 })]),
      series: response([
        group({ provider: "codex", requests: 100, "bucket-start-ms": currentHour - 24 * hour }),
        group({ provider: "codex", requests: 5, "bucket-start-ms": currentHour - 23 * hour }),
        group({ provider: "codex", requests: 2, "bucket-start-ms": currentHour }),
      ]),
      totalSeries: response([
        group({ requests: 100, "bucket-start-ms": currentHour - 24 * hour }),
        group({ requests: 5, "bucket-start-ms": currentHour - 23 * hour }),
        group({ requests: 2, "bucket-start-ms": currentHour }),
      ]),
      dimension: "provider",
      metric: "requests",
      range: "1d",
      nowMs,
      accounts: [],
    });
    expect(analytics.series).toHaveLength(24);
    expect(analytics.series.every((p) => p.startMs % hour === 0)).toBe(true);
    expect(analytics.series[0]?.startMs).toBe(currentHour - 23 * hour);
    expect(analytics.series.at(-1)?.startMs).toBe(currentHour);
    // The pre-window bucket (100) is dropped, not merged into the first point.
    expect(analytics.series[0]?.total).toBe(5);
    expect(analytics.series.at(-1)?.total).toBe(2);
    expect(analytics.series.reduce((sum, p) => sum + p.total, 0)).toBe(7);
  });

  it("queries still cover exactly [now - range, now]", () => {
    const q = buildOverviewQueries({ range: "1d", dimension: "provider", nowMs });
    expect(q.series.endMs).toBe(nowMs);
  });
});

describe("model provider pick (review 20261012 item 5)", () => {
  const rank = (groups: HistoryStatsResponse["groups"]) =>
    buildAnalytics({
      ranking: response(groups),
      series: response(),
      totalSeries: response(),
      dimension: "model",
      metric: "requests",
      range: "1h",
      nowMs: 1_700_000_000_000,
      accounts: [],
    }).rows[0];

  it("keeps the provider of the single largest group when a smaller one follows", () => {
    const row = rank([
      group({ model: "m", provider: "claude", requests: 100 }),
      group({ model: "m", provider: "codex", requests: 60 }),
    ]);
    expect(row?.requests).toBe(160);
    expect(row?.provider).toBe("claude");
  });

  it("switches to a later group only when it is the largest single group", () => {
    const row = rank([
      group({ model: "m", provider: "claude", requests: 60 }),
      group({ model: "m", provider: "codex", requests: 100 }),
      group({ model: "m", provider: "gemini", requests: 70 }),
    ]);
    expect(row?.provider).toBe("codex");
  });
});

describe("telemetry fallback provider tokens (review 20261012 item 3)", () => {
  const nowMs = 1_700_000_000_000;
  const accounts = [makeAccount("acc-1", "acc1@example.com", "codex")];
  const sample: TelemetrySample = {
    timestamp: nowMs - 60_000,
    served: 4,
    requests: 4,
    successes: 4,
    failures: 0,
    inFlight: 0,
    p50Ms: 0,
    p90Ms: 0,
    // Sample-level totalTokens deliberately undefined: only accounts carry tokens.
    providers: [{ provider: "openai", requests: 4, successes: 4, failures: 0 }],
    accounts: [
      {
        // Persisted bucket keys are not always exact account ids.
        id: "acc1_example.com",
        requests: 4,
        successes: 4,
        failures: 0,
        inputTokens: 30,
        outputTokens: 70,
        totalTokens: 100,
      },
    ],
  };

  const run = (dimension: "provider" | "account") =>
    telemetryAnalytics({
      samples: [sample],
      dimension,
      metric: "tokens",
      range: "1h",
      nowMs,
      accounts,
    });

  it("attributes tokens to the provider row through normalized ids and fuzzy account match", () => {
    expect(resolveAccountIdentity("acc1_example.com", accounts).provider).toBe("codex");
    const analytics = run("provider");
    expect(analytics.rows[0]?.totalTokens).toBe(100);
    expect(analytics.rows[0]?.inputTokens).toBe(30);
  });

  it("paints provider token series instead of hardcoded zero, using the account-sum fallback", () => {
    const analytics = run("provider");
    const key = analytics.seriesKeys[0] as string;
    const painted = analytics.series.reduce((sum, p) => sum + (p.values[key] ?? 0), 0);
    expect(painted).toBe(100);
    expect(analytics.series.reduce((sum, p) => sum + p.total, 0)).toBe(100);
  });

  it("account dimension totals fall back to the account sum when sample totals are missing", () => {
    const analytics = run("account");
    expect(analytics.series.reduce((sum, p) => sum + p.total, 0)).toBe(100);
  });
});

describe("notch reset pairing (review 20261012 item 6)", () => {
  it("a strictly worse account with no reset does not inherit a stale countdown", () => {
    const groups = groupNotchProviders([
      {
        provider: "codex",
        rows: [{ name: "Primary window", usedPercent: 50, resetSeconds: 3600 }],
      },
      {
        provider: "codex",
        rows: [{ name: "Primary window", usedPercent: 95, resetSeconds: null }],
      },
    ]);
    expect(groups[0]?.rows[0]).toMatchObject({ usedPercent: 95, resetSeconds: null });
  });
});

describe("account identity prefix strip (review 20261012 item 7)", () => {
  const withProvider = (id: string, email: string, provider: string) =>
    ({ ...makeAccount(id, email, provider), credentialName: null }) as NormalizedAccount;

  it("prefers the candidate whose provider matches the identifier prefix", () => {
    const accounts = [
      withProvider("a-claude", "shared@example.com", "claude"),
      withProvider("a-codex", "shared@example.com", "codex"),
    ];
    expect(resolveAccountIdentity("codex-shared@example.com", accounts).provider).toBe("codex");
    expect(resolveAccountIdentity("claude-shared@example.com", accounts).provider).toBe("claude");
  });

  it("strips only the identifier side, so a hyphenated account email is not falsely linked", () => {
    const accounts = [withProvider("acc-x", "john-doe@x.com", "codex")];
    const res = resolveAccountIdentity("x-doe@x.com", accounts);
    expect(res.isUnlinked).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { NormalizedAccount } from "../lib/accounts";
import {
  EMPTY_ANALYTICS,
  OTHER_KEY,
  OVERVIEW_TOP_N,
  type OverviewDimension,
  bucketForRange,
  bucketMsFor,
  buildAnalytics,
  buildOverviewQueries,
  telemetryAnalytics,
} from "../lib/overview-analytics";
import type { HistoryStatsResponse, HistoryTotals } from "../lib/schemas";
import type { TelemetryRange, TelemetrySample } from "../lib/telemetry";

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

const makeResponse = (
  groups: HistoryStatsResponse["groups"] = [],
  totalsPartial: Partial<HistoryTotals> = {},
): HistoryStatsResponse => {
  const totals: HistoryTotals = {
    ...defaultTotals,
    ...totalsPartial,
  };
  return { totals, groups };
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
  }) as NormalizedAccount;

describe("overview-analytics queries and ranges", () => {
  const ranges: readonly TelemetryRange[] = ["30m", "1h", "1d", "7d", "30d"];
  const dimensions: readonly OverviewDimension[] = ["model", "provider", "account"];
  const expectedDurations: Record<TelemetryRange, number> = {
    "30m": 1800000,
    "1h": 3600000,
    "1d": 86400000,
    "7d": 604800000,
    "30d": 2592000000,
  };
  const expectedBuckets: Record<TelemetryRange, "minute" | "hour" | "day"> = {
    "30m": "minute",
    "1h": "minute",
    "1d": "hour",
    "7d": "hour",
    "30d": "day",
  };
  const expectedBucketMs: Record<"minute" | "hour" | "day", number> = {
    minute: 60000,
    hour: 3600000,
    day: 86400000,
  };

  it("exports correct bucketForRange and bucketMsFor", () => {
    for (const r of ranges) {
      expect(bucketForRange[r]).toBe(expectedBuckets[r]);
    }
    expect(bucketMsFor("minute")).toBe(expectedBucketMs.minute);
    expect(bucketMsFor("hour")).toBe(expectedBucketMs.hour);
    expect(bucketMsFor("day")).toBe(expectedBucketMs.day);
  });

  it("buildOverviewQueries shape for each of the five ranges and all three dimensions, including that model ranking asks for ['model','provider']", () => {
    const nowMs = 1700000000000;

    for (const range of ranges) {
      for (const dimension of dimensions) {
        const duration = expectedDurations[range];
        const queries = buildOverviewQueries({ range, dimension, nowMs });

        // Check ranking query
        expect(queries.ranking.startMs).toBe(nowMs - duration);
        expect(queries.ranking.endMs).toBe(nowMs);
        expect(queries.ranking.timeBucket).toBeUndefined();
        if (dimension === "model") {
          expect(queries.ranking.groupBy).toEqual(["model", "provider"]);
        } else {
          expect(queries.ranking.groupBy).toEqual([dimension]);
        }

        // Check series query
        expect(queries.series.startMs).toBe(nowMs - duration);
        expect(queries.series.endMs).toBe(nowMs);
        expect(queries.series.groupBy).toEqual([dimension]);
        expect(queries.series.timeBucket).toBe(expectedBuckets[range]);

        // Check totalSeries query
        expect(queries.totalSeries.startMs).toBe(nowMs - duration);
        expect(queries.totalSeries.endMs).toBe(nowMs);
        expect(queries.totalSeries.groupBy).toBeUndefined();
        expect(queries.totalSeries.timeBucket).toBe(expectedBuckets[range]);
      }
    }
  });

  it("applies topKeys filter to the matching series query property when given", () => {
    const nowMs = 1700000000000;

    const modelQueries = buildOverviewQueries({
      range: "1h",
      dimension: "model",
      nowMs,
      topKeys: ["m1", "m2"],
    });
    expect(modelQueries.series.models).toEqual(["m1", "m2"]);
    expect(modelQueries.series.providers).toBeUndefined();
    expect(modelQueries.series.accounts).toBeUndefined();

    const providerQueries = buildOverviewQueries({
      range: "1h",
      dimension: "provider",
      nowMs,
      topKeys: ["p1", "p2"],
    });
    expect(providerQueries.series.providers).toEqual(["p1", "p2"]);
    expect(providerQueries.series.models).toBeUndefined();
    expect(providerQueries.series.accounts).toBeUndefined();

    const accountQueries = buildOverviewQueries({
      range: "1h",
      dimension: "account",
      nowMs,
      topKeys: ["a1", "a2"],
    });
    expect(accountQueries.series.accounts).toEqual(["a1", "a2"]);
    expect(accountQueries.series.models).toBeUndefined();
    expect(accountQueries.series.providers).toBeUndefined();
  });
});

describe("buildAnalytics ranking, folding, and series", () => {
  const nowMs = 1700000000000;
  const accounts: readonly NormalizedAccount[] = [
    makeAccount("acc-1", "acc1@example.com", "codex"),
    makeAccount("acc-2", "acc2@example.com", "claude"),
  ];

  it("Top-N folding: 9 input groups produce 6 rows plus one Other row whose requests equal the sum of the 3 folded groups", () => {
    const inputGroups = Array.from({ length: 9 }, (_, i) => ({
      "bucket-start-ms": null,
      account: `acc-${i + 1}`,
      provider: "codex",
      model: null,
      "key-label": null,
      status: null,
      totals: {
        ...defaultTotals,
        requests: (i + 1) * 10, // 10, 20, 30, 40, 50, 60, 70, 80, 90
        "successful-requests": (i + 1) * 10,
        "total-tokens": (i + 1) * 1000,
      },
    }));

    const totalRequests = inputGroups.reduce((sum, g) => sum + g.totals.requests, 0);
    const ranking = makeResponse(inputGroups, { requests: totalRequests });
    const series = makeResponse();
    const totalSeries = makeResponse();

    const analytics = buildAnalytics({
      ranking,
      series,
      totalSeries,
      dimension: "account",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts,
    });

    // 9 groups ranked by requests: top 6 are 90, 80, 70, 60, 50, 40 (acc-9 .. acc-4).
    // The bottom 3 (30, 20, 10 -> acc-3, acc-2, acc-1) sum to 60 requests.
    expect(analytics.rows).toHaveLength(OVERVIEW_TOP_N + 1); // 6 + 1 = 7

    const topRows = analytics.rows.slice(0, OVERVIEW_TOP_N);
    const otherRow = analytics.rows[OVERVIEW_TOP_N];

    expect(topRows.map((r) => r.requests)).toEqual([90, 80, 70, 60, 50, 40]);
    expect(topRows.every((r) => !r.isOther)).toBe(true);

    expect(otherRow).toBeDefined();
    expect(otherRow.key).toBe(OTHER_KEY);
    expect(otherRow.label).toBe("Other");
    expect(otherRow.isOther).toBe(true);
    expect(otherRow.requests).toBe(30 + 20 + 10); // 60

    // share is row metric / sum of all row metrics
    const sumMetrics = analytics.rows.reduce((sum, r) => sum + r.requests, 0);
    expect(sumMetrics).toBe(totalRequests);
    expect(otherRow.share).toBeCloseTo(60 / totalRequests);
  });

  it("ranks rows by selected metric (tokens vs requests)", () => {
    const inputGroups = [
      {
        "bucket-start-ms": null,
        account: "acc-high-req",
        provider: "codex",
        model: null,
        "key-label": null,
        status: null,
        totals: {
          ...defaultTotals,
          requests: 100,
          "total-tokens": 10,
        },
      },
      {
        "bucket-start-ms": null,
        account: "acc-high-tok",
        provider: "codex",
        model: null,
        "key-label": null,
        status: null,
        totals: {
          ...defaultTotals,
          requests: 10,
          "total-tokens": 10000,
        },
      },
    ];

    const ranking = makeResponse(inputGroups, {
      requests: 110,
      "total-tokens": 10010,
    });

    const reqAnalytics = buildAnalytics({
      ranking,
      series: makeResponse(),
      totalSeries: makeResponse(),
      dimension: "account",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts,
    });
    expect(reqAnalytics.rows[0].key).toBe("acc-high-req");

    const tokAnalytics = buildAnalytics({
      ranking,
      series: makeResponse(),
      totalSeries: makeResponse(),
      dimension: "account",
      metric: "tokens",
      range: "1h",
      nowMs,
      accounts,
    });
    expect(tokAnalytics.rows[0].key).toBe("acc-high-tok");
  });

  it("calculates avgLatencyMs from average-latency-ms when present, else total-latency-ms/requests, else 0", () => {
    const inputGroups = [
      {
        "bucket-start-ms": null,
        account: "acc-avg",
        provider: "codex",
        model: null,
        "key-label": null,
        status: null,
        totals: {
          ...defaultTotals,
          requests: 10,
          "average-latency-ms": 123.45,
        },
      },
      {
        "bucket-start-ms": null,
        account: "acc-tot",
        provider: "codex",
        model: null,
        "key-label": null,
        status: null,
        totals: {
          ...defaultTotals,
          requests: 10,
          "total-latency-ms": 2500,
        },
      },
      {
        "bucket-start-ms": null,
        account: "acc-none",
        provider: "codex",
        model: null,
        "key-label": null,
        status: null,
        totals: {
          ...defaultTotals,
          requests: 10,
        },
      },
    ];

    const ranking = makeResponse(inputGroups, { requests: 30 });
    const analytics = buildAnalytics({
      ranking,
      series: makeResponse(),
      totalSeries: makeResponse(),
      dimension: "account",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts,
    });

    const rAvg = analytics.rows.find((r) => r.key === "acc-avg");
    const rTot = analytics.rows.find((r) => r.key === "acc-tot");
    const rNone = analytics.rows.find((r) => r.key === "acc-none");

    expect(rAvg?.avgLatencyMs).toBe(123.45);
    expect(rTot?.avgLatencyMs).toBe(250);
    expect(rNone?.avgLatencyMs).toBe(0);
  });

  it("Series zero-fill: a response with one populated bucket in a 1h window produces 60 points, exactly one non-zero", () => {
    const range: TelemetryRange = "1h"; // duration 3600000 ms, bucket "minute" = 60000 ms -> 60 points
    const startMs = nowMs - 3600000;
    const populatedBucketTs = startMs + 10 * 60000; // index 10

    const ranking = makeResponse([
      {
        "bucket-start-ms": null,
        model: "gpt-4o",
        provider: "codex",
        account: null,
        "key-label": null,
        status: null,
        totals: { ...defaultTotals, requests: 5 },
      },
    ]);

    const series = makeResponse([
      {
        "bucket-start-ms": populatedBucketTs,
        model: "gpt-4o",
        provider: "codex",
        account: null,
        "key-label": null,
        status: null,
        totals: { ...defaultTotals, requests: 5 },
      },
    ]);

    const totalSeries = makeResponse([
      {
        "bucket-start-ms": populatedBucketTs,
        model: null,
        provider: null,
        account: null,
        "key-label": null,
        status: null,
        totals: { ...defaultTotals, requests: 5 },
      },
    ]);

    const analytics = buildAnalytics({
      ranking,
      series,
      totalSeries,
      dimension: "model",
      metric: "requests",
      range,
      nowMs,
      accounts,
    });

    expect(analytics.series).toHaveLength(60);

    const nonZeroPoints = analytics.series.filter((p) => p.total > 0);
    expect(nonZeroPoints).toHaveLength(1);

    const point = analytics.series[10];
    expect(point.total).toBe(5);
    expect(point.values["gpt-4o"]).toBe(5);

    // Idle points are zero filled
    expect(analytics.series[0].total).toBe(0);
    expect(analytics.series[0].values["gpt-4o"]).toBe(0);
  });

  it("Other series clamping: a totalSeries bucket smaller than the sum of top-N values yields 0, never a negative number", () => {
    const range: TelemetryRange = "1h";
    const startMs = nowMs - 3600000;
    const populatedBucketTs = startMs + 5 * 60000;

    // Create 7 models to trigger Top-N folding (6 top + 1 other)
    const rankingGroups = Array.from({ length: 7 }, (_, i) => ({
      "bucket-start-ms": null,
      model: `model-${i + 1}`,
      provider: "codex",
      account: null,
      "key-label": null,
      status: null,
      totals: { ...defaultTotals, requests: 10 },
    }));

    const ranking = makeResponse(rankingGroups, { requests: 70 });

    // Series has model-1 with 8 requests in this bucket
    const series = makeResponse([
      {
        "bucket-start-ms": populatedBucketTs,
        model: "model-1",
        provider: "codex",
        account: null,
        "key-label": null,
        status: null,
        totals: { ...defaultTotals, requests: 8 },
      },
    ]);

    // totalSeries has only 5 requests in this bucket (smaller than 8)
    const totalSeries = makeResponse([
      {
        "bucket-start-ms": populatedBucketTs,
        model: null,
        provider: null,
        account: null,
        "key-label": null,
        status: null,
        totals: { ...defaultTotals, requests: 5 },
      },
    ]);

    const analytics = buildAnalytics({
      ranking,
      series,
      totalSeries,
      dimension: "model",
      metric: "requests",
      range,
      nowMs,
      accounts,
    });

    const point = analytics.series[5];
    expect(point.values[OTHER_KEY]).toBe(0);
    expect(point.values[OTHER_KEY]).toBeGreaterThanOrEqual(0);
  });

  it("isTokenPartial true when a group has requests 5 and total-tokens 0", () => {
    const ranking = makeResponse([
      {
        "bucket-start-ms": null,
        account: "acc-partial",
        provider: "codex",
        model: null,
        "key-label": null,
        status: null,
        totals: {
          ...defaultTotals,
          requests: 5,
          "total-tokens": 0,
        },
      },
    ]);

    const analytics = buildAnalytics({
      ranking,
      series: makeResponse(),
      totalSeries: makeResponse(),
      dimension: "account",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts,
    });

    expect(analytics.isTokenPartial).toBe(true);
  });

  it("isTokenPartial false when all groups with requests have positive tokens", () => {
    const ranking = makeResponse([
      {
        "bucket-start-ms": null,
        account: "acc-ok",
        provider: "codex",
        model: null,
        "key-label": null,
        status: null,
        totals: {
          ...defaultTotals,
          requests: 5,
          "total-tokens": 500,
        },
      },
    ]);

    const analytics = buildAnalytics({
      ranking,
      series: makeResponse(),
      totalSeries: makeResponse(),
      dimension: "account",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts,
    });

    expect(analytics.isTokenPartial).toBe(false);
  });

  it("hasCostData true when any totals['estimated-cost-usd'] > 0", () => {
    const ranking = makeResponse(
      [
        {
          "bucket-start-ms": null,
          account: "acc-cost",
          provider: "codex",
          model: null,
          "key-label": null,
          status: null,
          totals: {
            ...defaultTotals,
            requests: 5,
            "estimated-cost-usd": 0.05,
          },
        },
      ],
      { "estimated-cost-usd": 0.05 },
    );

    const analytics = buildAnalytics({
      ranking,
      series: makeResponse(),
      totalSeries: makeResponse(),
      dimension: "account",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts,
    });

    expect(analytics.hasCostData).toBe(true);
  });

  it("EMPTY_ANALYTICS returns consistent default structure", () => {
    const empty = EMPTY_ANALYTICS("provider", "requests", "1h");
    expect(empty.source).toBe("history");
    expect(empty.dimension).toBe("provider");
    expect(empty.rows).toEqual([]);
    expect(empty.series).toEqual([]);
    expect(empty.seriesKeys).toEqual([]);
    expect(empty.totals.requests).toBe(0);
    expect(empty.supportsModelDimension).toBe(true);
  });
});

describe("telemetryAnalytics", () => {
  const nowMs = 1700000000000;
  const accounts: readonly NormalizedAccount[] = [
    makeAccount("acc-1", "acc1@example.com", "codex"),
    makeAccount("acc-2", "acc2@example.com", "claude"),
  ];

  const samples: readonly TelemetrySample[] = [
    {
      timestamp: nowMs - 600000,
      served: 10,
      requests: 10,
      successes: 8,
      failures: 2,
      inFlight: 0,
      p50Ms: 150,
      p90Ms: 300,
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      providers: [{ provider: "codex", requests: 10, successes: 8, failures: 2 }],
      accounts: [
        {
          id: "acc-1",
          requests: 10,
          successes: 8,
          failures: 2,
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
        },
      ],
    },
  ];

  it("builds OverviewAnalytics for provider dimension with source 'telemetry' and supportsModelDimension false", () => {
    const analytics = telemetryAnalytics({
      samples,
      dimension: "provider",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts,
    });

    expect(analytics.source).toBe("telemetry");
    expect(analytics.supportsModelDimension).toBe(false);
    expect(analytics.totals.requests).toBe(10);
    expect(analytics.rows.length).toBeGreaterThan(0);
    expect(analytics.rows[0].provider).toBe("codex");
  });

  it("builds OverviewAnalytics for account dimension with source 'telemetry' and supportsModelDimension false", () => {
    const analytics = telemetryAnalytics({
      samples,
      dimension: "account",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts,
    });

    expect(analytics.source).toBe("telemetry");
    expect(analytics.supportsModelDimension).toBe(false);
    expect(analytics.totals.requests).toBe(10);
    expect(analytics.rows.length).toBeGreaterThan(0);
    expect(analytics.rows[0].key).toBe("acc-1");
  });

  it("returns zero rows and empty series for model dimension with supportsModelDimension false", () => {
    const analytics = telemetryAnalytics({
      samples,
      dimension: "model",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts,
    });

    expect(analytics.source).toBe("telemetry");
    expect(analytics.supportsModelDimension).toBe(false);
    expect(analytics.rows).toEqual([]);
    expect(analytics.series).toEqual([]);
    expect(analytics.seriesKeys).toEqual([]);
  });
});

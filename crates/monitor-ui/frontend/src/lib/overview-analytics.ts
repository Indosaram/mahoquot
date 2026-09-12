import type { NormalizedAccount } from "./accounts";
import type { HistoryStatsQuery } from "./api";
import { resolveAccountIdentity, resolveProviderIdentity } from "./dimension-identity";
import type { HistoryStatsResponse } from "./schemas";
import {
  type TelemetryRange,
  type TelemetrySample,
  filterTelemetryRange,
  summarizeTelemetry,
} from "./telemetry";

export type OverviewDimension = "provider" | "model" | "account";
export type OverviewMetric = "requests" | "tokens";
export const OVERVIEW_TOP_N = 6;
export const OTHER_KEY = "__other__";

export interface BreakdownRow {
  readonly key: string; // raw history key (provider id / model id / account identifier), OTHER_KEY for the folded row
  readonly label: string; // display label
  readonly provider: string; // canonical provider id used for glyph + colour
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly avgLatencyMs: number;
  readonly costUsd: number;
  readonly share: number; // 0..1 of the selected metric
  readonly isOther: boolean;
  readonly isUnlinked: boolean;
}

export interface SeriesPoint {
  readonly startMs: number;
  readonly total: number;
  readonly values: Readonly<Record<string, number>>; // series key -> metric value, every seriesKey present (0 when idle)
}

export interface OverviewTotals {
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly avgLatencyMs: number;
  readonly costUsd: number;
}

export interface OverviewAnalytics {
  readonly source: "history" | "telemetry";
  readonly dimension: OverviewDimension;
  readonly metric: OverviewMetric;
  readonly range: TelemetryRange;
  readonly bucketMs: number;
  readonly totals: OverviewTotals;
  readonly rows: readonly BreakdownRow[]; // sorted desc by metric, Other last
  readonly series: readonly SeriesPoint[]; // uniform grid over [now-range, now], zero filled
  readonly seriesKeys: readonly string[]; // stack + legend order, same order as rows
  readonly hasCostData: boolean;
  readonly isTokenPartial: boolean;
  readonly supportsModelDimension: boolean; // false when source === "telemetry"
}

const rangeDurations: Readonly<Record<TelemetryRange, number>> = {
  "30m": 1800000,
  "1h": 3600000,
  "1d": 86400000,
  "7d": 604800000,
  "30d": 2592000000,
};

export const bucketForRange: Readonly<Record<TelemetryRange, "minute" | "hour" | "day">> = {
  "30m": "minute",
  "1h": "minute",
  "1d": "hour",
  "7d": "hour",
  "30d": "day",
};

export const bucketMsFor = (bucket: "minute" | "hour" | "day"): number => {
  switch (bucket) {
    case "minute":
      return 60000;
    case "hour":
      return 3600000;
    case "day":
      return 86400000;
  }
};

export const buildOverviewQueries = ({
  range,
  dimension,
  nowMs,
  topKeys,
}: {
  range: TelemetryRange;
  dimension: OverviewDimension;
  nowMs: number;
  topKeys?: readonly string[];
}): {
  ranking: HistoryStatsQuery;
  series: HistoryStatsQuery;
  totalSeries: HistoryStatsQuery;
} => {
  const duration = rangeDurations[range];
  const startMs = nowMs - duration;
  const endMs = nowMs;
  const bucket = bucketForRange[range];

  const ranking: HistoryStatsQuery = {
    startMs,
    endMs,
    groupBy: dimension === "model" ? ["model", "provider"] : [dimension],
  };

  const series: HistoryStatsQuery = {
    startMs,
    endMs,
    groupBy: [dimension],
    timeBucket: bucket,
    ...(topKeys !== undefined
      ? dimension === "model"
        ? { models: topKeys }
        : dimension === "provider"
          ? { providers: topKeys }
          : { accounts: topKeys }
      : {}),
  };

  const totalSeries: HistoryStatsQuery = {
    startMs,
    endMs,
    timeBucket: bucket,
  };

  return { ranking, series, totalSeries };
};

interface AggregateAccumulator {
  key: string;
  label: string;
  provider: string;
  isUnlinked: boolean;
  requests: number;
  successes: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  costUsd: number;
  avgLatencyMsDirect?: number;
}

export const buildAnalytics = ({
  ranking,
  series,
  totalSeries,
  dimension,
  metric,
  range,
  nowMs,
  accounts,
}: {
  ranking: HistoryStatsResponse;
  series: HistoryStatsResponse;
  totalSeries: HistoryStatsResponse;
  dimension: OverviewDimension;
  metric: OverviewMetric;
  range: TelemetryRange;
  nowMs: number;
  accounts: readonly NormalizedAccount[];
}): OverviewAnalytics => {
  const aggregates = new Map<string, AggregateAccumulator>();

  for (const group of ranking.groups) {
    const rawKey =
      dimension === "model"
        ? (group.model ?? "unknown")
        : dimension === "provider"
          ? (group.provider ?? "unknown")
          : (group.account ?? "unknown");

    let label = rawKey;
    let provider = "unknown";
    let isUnlinked = false;

    if (dimension === "model") {
      label = rawKey;
      provider = resolveProviderIdentity(group.provider ?? "unknown");
    } else if (dimension === "account") {
      const identity = resolveAccountIdentity(rawKey, accounts);
      label = identity.label;
      provider = identity.provider;
      isUnlinked = identity.isUnlinked;
    } else {
      label = rawKey;
      provider = resolveProviderIdentity(rawKey);
    }

    const current = aggregates.get(rawKey);
    const requests = (current?.requests ?? 0) + group.totals.requests;
    const successes = (current?.successes ?? 0) + group.totals["successful-requests"];
    const failures = (current?.failures ?? 0) + group.totals["failed-requests"];
    const inputTokens = (current?.inputTokens ?? 0) + group.totals["input-tokens"];
    const outputTokens = (current?.outputTokens ?? 0) + group.totals["output-tokens"];
    const totalTokens = (current?.totalTokens ?? 0) + group.totals["total-tokens"];
    const costUsd = (current?.costUsd ?? 0) + group.totals["estimated-cost-usd"];

    const groupLatency =
      group.totals["total-latency-ms"] ??
      (group.totals["average-latency-ms"] !== undefined
        ? group.totals["average-latency-ms"] * group.totals.requests
        : 0);
    const totalLatencyMs = (current?.totalLatencyMs ?? 0) + groupLatency;

    // Direct avgLatencyMs if present and single group
    const avgLatencyMsDirect =
      current === undefined ? group.totals["average-latency-ms"] : undefined;

    // Prefer provider with more requests if duplicate model entries exist
    const finalProvider =
      current === undefined || group.totals.requests > current.requests - group.totals.requests
        ? provider
        : current.provider;

    aggregates.set(rawKey, {
      key: rawKey,
      label,
      provider: finalProvider,
      isUnlinked,
      requests,
      successes,
      failures,
      inputTokens,
      outputTokens,
      totalTokens,
      totalLatencyMs,
      costUsd,
      avgLatencyMsDirect,
    });
  }

  const sortedAggregates = [...aggregates.values()].sort((a, b) => {
    const valA = metric === "requests" ? a.requests : a.totalTokens;
    const valB = metric === "requests" ? b.requests : b.totalTokens;
    return valB - valA || a.key.localeCompare(b.key);
  });

  const topAggregates = sortedAggregates.slice(0, OVERVIEW_TOP_N);
  const remainder = sortedAggregates.slice(OVERVIEW_TOP_N);

  const topRows: BreakdownRow[] = topAggregates.map((a) => ({
    key: a.key,
    label: a.label,
    provider: a.provider,
    requests: a.requests,
    successes: a.successes,
    failures: a.failures,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    totalTokens: a.totalTokens,
    avgLatencyMs:
      a.avgLatencyMsDirect !== undefined
        ? a.avgLatencyMsDirect
        : a.requests > 0
          ? a.totalLatencyMs / a.requests
          : 0,
    costUsd: a.costUsd,
    share: 0,
    isOther: false,
    isUnlinked: a.isUnlinked,
  }));

  let rows: BreakdownRow[] = topRows;

  if (remainder.length > 0) {
    const remRequests = remainder.reduce((s, g) => s + g.requests, 0);
    const remSuccesses = remainder.reduce((s, g) => s + g.successes, 0);
    const remFailures = remainder.reduce((s, g) => s + g.failures, 0);
    const remInputTokens = remainder.reduce((s, g) => s + g.inputTokens, 0);
    const remOutputTokens = remainder.reduce((s, g) => s + g.outputTokens, 0);
    const remTotalTokens = remainder.reduce((s, g) => s + g.totalTokens, 0);
    const remCostUsd = remainder.reduce((s, g) => s + g.costUsd, 0);
    const remTotalLatency = remainder.reduce((s, g) => s + g.totalLatencyMs, 0);
    const remAvgLatency = remRequests > 0 ? remTotalLatency / remRequests : 0;

    const otherRow: BreakdownRow = {
      key: OTHER_KEY,
      label: "Other",
      provider: "other",
      requests: remRequests,
      successes: remSuccesses,
      failures: remFailures,
      inputTokens: remInputTokens,
      outputTokens: remOutputTokens,
      totalTokens: remTotalTokens,
      avgLatencyMs: remAvgLatency,
      costUsd: remCostUsd,
      share: 0,
      isOther: true,
      isUnlinked: false,
    };

    rows = [...topRows, otherRow];
  }

  const sumMetrics = rows.reduce(
    (sum, r) => sum + (metric === "requests" ? r.requests : r.totalTokens),
    0,
  );
  rows = rows.map((r) => {
    const rowMetric = metric === "requests" ? r.requests : r.totalTokens;
    return {
      ...r,
      share: sumMetrics > 0 ? rowMetric / sumMetrics : 0,
    };
  });

  const seriesKeys = rows.map((r) => r.key);

  const duration = rangeDurations[range];
  const bucketMs = bucketMsFor(bucketForRange[range]);
  const bucketCount = Math.max(1, Math.floor(duration / bucketMs));
  const startMs = nowMs - duration;

  const totalSeriesByBucket = new Map<number, number>();
  for (const group of totalSeries.groups) {
    const ts = group["bucket-start-ms"];
    if (ts !== null && ts !== undefined) {
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((ts - startMs) / bucketMs)));
      const val = metric === "requests" ? group.totals.requests : group.totals["total-tokens"];
      totalSeriesByBucket.set(idx, (totalSeriesByBucket.get(idx) ?? 0) + val);
    }
  }

  const seriesByBucketAndKey = new Map<number, Map<string, number>>();
  for (const group of series.groups) {
    const ts = group["bucket-start-ms"];
    if (ts !== null && ts !== undefined) {
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((ts - startMs) / bucketMs)));
      const key =
        dimension === "model"
          ? group.model
          : dimension === "provider"
            ? group.provider
            : group.account;
      if (key) {
        const val = metric === "requests" ? group.totals.requests : group.totals["total-tokens"];
        let bucketMap = seriesByBucketAndKey.get(idx);
        if (!bucketMap) {
          bucketMap = new Map();
          seriesByBucketAndKey.set(idx, bucketMap);
        }
        bucketMap.set(key, (bucketMap.get(key) ?? 0) + val);
      }
    }
  }

  const points: SeriesPoint[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = startMs + i * bucketMs;
    const values: Record<string, number> = {};
    let topNSum = 0;
    const bucketMap = seriesByBucketAndKey.get(i);

    for (const k of seriesKeys) {
      if (k !== OTHER_KEY) {
        const val = bucketMap?.get(k) ?? 0;
        values[k] = val;
        topNSum += val;
      }
    }

    if (seriesKeys.includes(OTHER_KEY)) {
      const totalVal = totalSeriesByBucket.get(i) ?? 0;
      const otherVal = Math.max(0, totalVal - topNSum);
      values[OTHER_KEY] = otherVal;
    }

    const pointTotal = Object.values(values).reduce((sum, v) => sum + v, 0);
    points.push({
      startMs: bucketStart,
      total: pointTotal,
      values,
    });
  }

  const totals: OverviewTotals = {
    requests: ranking.totals.requests,
    successes: ranking.totals["successful-requests"],
    failures: ranking.totals["failed-requests"],
    inputTokens: ranking.totals["input-tokens"],
    outputTokens: ranking.totals["output-tokens"],
    totalTokens: ranking.totals["total-tokens"],
    avgLatencyMs:
      ranking.totals["average-latency-ms"] ??
      (ranking.totals["total-latency-ms"] !== undefined && ranking.totals.requests > 0
        ? ranking.totals["total-latency-ms"] / ranking.totals.requests
        : 0),
    costUsd: ranking.totals["estimated-cost-usd"],
  };

  const isTokenPartial = ranking.groups.some(
    (g) => g.totals.requests > 0 && g.totals["total-tokens"] === 0,
  );
  const hasCostData =
    ranking.totals["estimated-cost-usd"] > 0 ||
    ranking.groups.some((g) => g.totals["estimated-cost-usd"] > 0);

  return {
    source: "history",
    dimension,
    metric,
    range,
    bucketMs,
    totals,
    rows,
    series: points,
    seriesKeys,
    hasCostData,
    isTokenPartial,
    supportsModelDimension: true,
  };
};

export const telemetryAnalytics = ({
  samples,
  dimension,
  metric,
  range,
  nowMs,
  accounts,
}: {
  samples: readonly TelemetrySample[];
  dimension: OverviewDimension;
  metric: OverviewMetric;
  range: TelemetryRange;
  nowMs: number;
  accounts: readonly NormalizedAccount[];
}): OverviewAnalytics => {
  const bucketMs = bucketMsFor(bucketForRange[range]);

  if (dimension === "model") {
    return {
      source: "telemetry",
      dimension: "model",
      metric,
      range,
      bucketMs,
      totals: {
        requests: 0,
        successes: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        avgLatencyMs: 0,
        costUsd: 0,
      },
      rows: [],
      series: [],
      seriesKeys: [],
      hasCostData: false,
      isTokenPartial: false,
      supportsModelDimension: false,
    };
  }

  const filtered = filterTelemetryRange(samples, range, nowMs);
  const summary = summarizeTelemetry(filtered);

  const duration = rangeDurations[range];
  const bucketCount = Math.max(1, Math.floor(duration / bucketMs));
  const startMs = nowMs - duration;

  let rows: BreakdownRow[] = [];

  if (dimension === "provider") {
    const providerTokens = new Map<
      string,
      { inputTokens: number; outputTokens: number; totalTokens: number }
    >();
    for (const sample of filtered) {
      for (const acc of sample.accounts) {
        const found = accounts.find((a) => a.id === acc.id);
        const prov = found?.provider ?? "unknown";
        const current = providerTokens.get(prov) ?? {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        providerTokens.set(prov, {
          inputTokens: current.inputTokens + (acc.inputTokens ?? 0),
          outputTokens: current.outputTokens + (acc.outputTokens ?? 0),
          totalTokens: current.totalTokens + (acc.totalTokens ?? 0),
        });
      }
    }

    const providerRows: BreakdownRow[] = summary.providers.map((p) => {
      const toks = providerTokens.get(p.provider);
      return {
        key: p.provider,
        label: p.provider,
        provider: resolveProviderIdentity(p.provider),
        requests: p.requests,
        successes: p.successes,
        failures: p.failures,
        inputTokens: toks?.inputTokens ?? 0,
        outputTokens: toks?.outputTokens ?? 0,
        totalTokens: toks?.totalTokens ?? 0,
        avgLatencyMs: 0,
        costUsd: 0,
        share: 0,
        isOther: false,
        isUnlinked: false,
      };
    });

    providerRows.sort((a, b) => {
      const valA = metric === "requests" ? a.requests : a.totalTokens;
      const valB = metric === "requests" ? b.requests : b.totalTokens;
      return valB - valA || a.key.localeCompare(b.key);
    });

    const top = providerRows.slice(0, OVERVIEW_TOP_N);
    const rem = providerRows.slice(OVERVIEW_TOP_N);
    if (rem.length > 0) {
      const remRequests = rem.reduce((s, r) => s + r.requests, 0);
      const remSuccesses = rem.reduce((s, r) => s + r.successes, 0);
      const remFailures = rem.reduce((s, r) => s + r.failures, 0);
      const remInputTokens = rem.reduce((s, r) => s + r.inputTokens, 0);
      const remOutputTokens = rem.reduce((s, r) => s + r.outputTokens, 0);
      const remTotalTokens = rem.reduce((s, r) => s + r.totalTokens, 0);

      const otherRow: BreakdownRow = {
        key: OTHER_KEY,
        label: "Other",
        provider: "other",
        requests: remRequests,
        successes: remSuccesses,
        failures: remFailures,
        inputTokens: remInputTokens,
        outputTokens: remOutputTokens,
        totalTokens: remTotalTokens,
        avgLatencyMs: 0,
        costUsd: 0,
        share: 0,
        isOther: true,
        isUnlinked: false,
      };
      rows = [...top, otherRow];
    } else {
      rows = top;
    }
  } else {
    // dimension === "account"
    const accountMap = new Map<
      string,
      {
        requests: number;
        successes: number;
        failures: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }
    >();

    for (const sample of filtered) {
      for (const acc of sample.accounts) {
        const cur = accountMap.get(acc.id) ?? {
          requests: 0,
          successes: 0,
          failures: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        accountMap.set(acc.id, {
          requests: cur.requests + acc.requests,
          successes: cur.successes + acc.successes,
          failures: cur.failures + acc.failures,
          inputTokens: cur.inputTokens + (acc.inputTokens ?? 0),
          outputTokens: cur.outputTokens + (acc.outputTokens ?? 0),
          totalTokens: cur.totalTokens + (acc.totalTokens ?? 0),
        });
      }
    }

    const accRows: BreakdownRow[] = [...accountMap.entries()].map(([id, data]) => {
      const identity = resolveAccountIdentity(id, accounts);
      return {
        key: id,
        label: identity.label,
        provider: identity.provider,
        requests: data.requests,
        successes: data.successes,
        failures: data.failures,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        totalTokens: data.totalTokens,
        avgLatencyMs: 0,
        costUsd: 0,
        share: 0,
        isOther: false,
        isUnlinked: identity.isUnlinked,
      };
    });

    accRows.sort((a, b) => {
      const valA = metric === "requests" ? a.requests : a.totalTokens;
      const valB = metric === "requests" ? b.requests : b.totalTokens;
      return valB - valA || a.key.localeCompare(b.key);
    });

    const top = accRows.slice(0, OVERVIEW_TOP_N);
    const rem = accRows.slice(OVERVIEW_TOP_N);
    if (rem.length > 0) {
      const remRequests = rem.reduce((s, r) => s + r.requests, 0);
      const remSuccesses = rem.reduce((s, r) => s + r.successes, 0);
      const remFailures = rem.reduce((s, r) => s + r.failures, 0);
      const remInputTokens = rem.reduce((s, r) => s + r.inputTokens, 0);
      const remOutputTokens = rem.reduce((s, r) => s + r.outputTokens, 0);
      const remTotalTokens = rem.reduce((s, r) => s + r.totalTokens, 0);

      const otherRow: BreakdownRow = {
        key: OTHER_KEY,
        label: "Other",
        provider: "other",
        requests: remRequests,
        successes: remSuccesses,
        failures: remFailures,
        inputTokens: remInputTokens,
        outputTokens: remOutputTokens,
        totalTokens: remTotalTokens,
        avgLatencyMs: 0,
        costUsd: 0,
        share: 0,
        isOther: true,
        isUnlinked: false,
      };
      rows = [...top, otherRow];
    } else {
      rows = top;
    }
  }

  const sumMetrics = rows.reduce(
    (sum, r) => sum + (metric === "requests" ? r.requests : r.totalTokens),
    0,
  );
  rows = rows.map((r) => {
    const rowMetric = metric === "requests" ? r.requests : r.totalTokens;
    return {
      ...r,
      share: sumMetrics > 0 ? rowMetric / sumMetrics : 0,
    };
  });

  const seriesKeys = rows.map((r) => r.key);

  const seriesByBucketAndKey = new Map<number, Map<string, number>>();
  const totalByBucket = new Map<number, number>();

  for (const sample of filtered) {
    const idx = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((sample.timestamp - startMs) / bucketMs)),
    );
    const sampleVal = metric === "requests" ? sample.requests : (sample.totalTokens ?? 0);
    totalByBucket.set(idx, (totalByBucket.get(idx) ?? 0) + sampleVal);

    if (dimension === "provider") {
      for (const p of sample.providerDeltas ?? sample.providers) {
        let bucketMap = seriesByBucketAndKey.get(idx);
        if (!bucketMap) {
          bucketMap = new Map();
          seriesByBucketAndKey.set(idx, bucketMap);
        }
        const val = metric === "requests" ? p.requests : 0;
        bucketMap.set(p.provider, (bucketMap.get(p.provider) ?? 0) + val);
      }
    } else {
      for (const acc of sample.accounts) {
        let bucketMap = seriesByBucketAndKey.get(idx);
        if (!bucketMap) {
          bucketMap = new Map();
          seriesByBucketAndKey.set(idx, bucketMap);
        }
        const val = metric === "requests" ? acc.requests : (acc.totalTokens ?? 0);
        bucketMap.set(acc.id, (bucketMap.get(acc.id) ?? 0) + val);
      }
    }
  }

  const points: SeriesPoint[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = startMs + i * bucketMs;
    const values: Record<string, number> = {};
    let topNSum = 0;
    const bucketMap = seriesByBucketAndKey.get(i);

    for (const k of seriesKeys) {
      if (k !== OTHER_KEY) {
        const val = bucketMap?.get(k) ?? 0;
        values[k] = val;
        topNSum += val;
      }
    }

    if (seriesKeys.includes(OTHER_KEY)) {
      const totalVal = totalByBucket.get(i) ?? 0;
      const otherVal = Math.max(0, totalVal - topNSum);
      values[OTHER_KEY] = otherVal;
    }

    const pointTotal = Object.values(values).reduce((sum, v) => sum + v, 0);
    points.push({
      startMs: bucketStart,
      total: pointTotal,
      values,
    });
  }

  const totals: OverviewTotals = {
    requests: summary.requests,
    successes: summary.successes,
    failures: summary.failures,
    inputTokens: summary.tokenTotals.inputTokens,
    outputTokens: summary.tokenTotals.outputTokens,
    totalTokens: summary.tokenTotals.totalTokens,
    avgLatencyMs: 0,
    costUsd: 0,
  };

  return {
    source: "telemetry",
    dimension,
    metric,
    range,
    bucketMs,
    totals,
    rows,
    series: points,
    seriesKeys,
    hasCostData: false,
    isTokenPartial: summary.tokenTotals.isPartial ?? false,
    supportsModelDimension: false,
  };
};

export const EMPTY_ANALYTICS = (
  dimension: OverviewDimension,
  metric: OverviewMetric,
  range: TelemetryRange,
): OverviewAnalytics => ({
  source: "history",
  dimension,
  metric,
  range,
  bucketMs: bucketMsFor(bucketForRange[range]),
  totals: {
    requests: 0,
    successes: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    avgLatencyMs: 0,
    costUsd: 0,
  },
  rows: [],
  series: [],
  seriesKeys: [],
  hasCostData: false,
  isTokenPartial: false,
  supportsModelDimension: true,
});

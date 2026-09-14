import type { NormalizedAccount } from "@/lib/accounts";
import type { GatewayClients } from "@/lib/api";
import {
  EMPTY_ANALYTICS,
  OVERVIEW_TOP_N,
  type OverviewAnalytics,
  type OverviewDimension,
  type OverviewMetric,
  buildAnalytics,
  buildOverviewQueries,
  telemetryAnalytics,
} from "@/lib/overview-analytics";
import type { HistoryStatsResponse } from "@/lib/schemas";
import type { TelemetryRange, TelemetrySample } from "@/lib/telemetry";
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseOverviewAnalyticsArgs {
  readonly clients: GatewayClients;
  readonly range: TelemetryRange;
  readonly dimension: OverviewDimension;
  readonly metric: OverviewMetric;
  readonly accounts: readonly NormalizedAccount[];
  readonly samples: readonly TelemetrySample[];
  readonly enabled: boolean;
  readonly nowMs?: number;
}

export interface UseOverviewAnalyticsResult {
  readonly analytics: OverviewAnalytics;
  readonly isLoading: boolean;
  readonly error: string;
  readonly refresh: () => Promise<void>;
}

interface CachedRawResponses {
  readonly ranking: HistoryStatsResponse;
  readonly series: HistoryStatsResponse;
  readonly totalSeries: HistoryStatsResponse;
  readonly nowMs: number;
}

/** Inputs that produced the analytics object currently held in state. When a
 * rebuild would run over exactly these inputs, its result is content-identical
 * to what is already rendered — only the object identity churns, which resets
 * the chart entrance animation for nothing (stats polls refresh the `accounts`
 * identity every cycle without changing its content). */
interface BuiltFrom {
  readonly cacheKey: string;
  readonly metric: OverviewMetric;
  readonly ranking: HistoryStatsResponse;
  readonly series: HistoryStatsResponse;
  readonly totalSeries: HistoryStatsResponse;
  readonly nowMs: number;
  readonly accountsKey: string;
}

// resolveAccountIdentity matches accounts by id/email/credentialName and takes
// label/provider from the match, so only those fields can change a rebuild's
// output. Everything else (quota, health, counters) is presentation-only.
const accountIdentityKey = (accounts: readonly NormalizedAccount[]): string =>
  accounts
    .map(
      (account) =>
        `${account.id}\n${account.email}\n${account.label}\n${account.provider}\n${account.credentialName ?? ""}`,
    )
    .join("\u0000");

const buildsMatch = (last: BuiltFrom | null, built: BuiltFrom): boolean =>
  last !== null &&
  last.cacheKey === built.cacheKey &&
  last.metric === built.metric &&
  last.ranking === built.ranking &&
  last.series === built.series &&
  last.totalSeries === built.totalSeries &&
  last.nowMs === built.nowMs &&
  last.accountsKey === built.accountsKey;

const buildCachedAnalytics = (
  cached: CachedRawResponses,
  dimension: OverviewDimension,
  metric: OverviewMetric,
  range: TelemetryRange,
  accounts: readonly NormalizedAccount[],
): { analytics: OverviewAnalytics; built: BuiltFrom } => {
  const analytics = buildAnalytics({
    ranking: cached.ranking,
    series: cached.series,
    totalSeries: cached.totalSeries,
    dimension,
    metric,
    range,
    nowMs: cached.nowMs,
    accounts,
  });
  return {
    analytics,
    built: {
      cacheKey: `${range}|${dimension}`,
      metric,
      ranking: cached.ranking,
      series: cached.series,
      totalSeries: cached.totalSeries,
      nowMs: cached.nowMs,
      accountsKey: accountIdentityKey(accounts),
    },
  };
};

const deriveTopKeys = (
  ranking: HistoryStatsResponse,
  dimension: OverviewDimension,
  metric: OverviewMetric,
): readonly string[] => {
  const aggregates = new Map<string, { requests: number; tokens: number }>();

  for (const group of ranking.groups) {
    const rawKey =
      dimension === "model"
        ? (group.model ?? "unknown")
        : dimension === "provider"
          ? (group.provider ?? "unknown")
          : (group.account ?? "unknown");

    const current = aggregates.get(rawKey) ?? { requests: 0, tokens: 0 };
    current.requests += group.totals.requests;
    current.tokens += group.totals["total-tokens"];
    aggregates.set(rawKey, current);
  }

  const sorted = [...aggregates.entries()].sort(([keyA, a], [keyB, b]) => {
    const valA = metric === "requests" ? a.requests : a.tokens;
    const valB = metric === "requests" ? b.requests : b.tokens;
    return valB - valA || keyA.localeCompare(keyB);
  });

  return sorted.slice(0, OVERVIEW_TOP_N).map(([key]) => key);
};

export function useOverviewAnalytics({
  clients,
  range,
  dimension,
  metric,
  accounts,
  samples,
  enabled,
  nowMs,
}: UseOverviewAnalyticsArgs): UseOverviewAnalyticsResult {
  const cacheKey = `${range}|${dimension}`;

  const cacheRef = useRef<Map<string, CachedRawResponses>>(new Map());
  const generationRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);
  // Null means the current analytics object did not come from a cache build
  // (initial empty state or a telemetry fallback); every analytics replacement
  // must either record the inputs it was built from or null this out.
  const lastBuildRef = useRef<BuiltFrom | null>(null);

  const prevClientsRef = useRef(clients);
  if (prevClientsRef.current !== clients) {
    prevClientsRef.current = clients;
    cacheRef.current.clear();
    generationRef.current += 1;
  }

  const [analytics, setAnalytics] = useState<OverviewAnalytics>(() =>
    EMPTY_ANALYTICS(dimension, metric, range),
  );
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string>("");

  // Track previous props to adjust state during render
  const [prevCacheKey, setPrevCacheKey] = useState(cacheKey);
  const [prevMetric, setPrevMetric] = useState(metric);
  const [prevAccounts, setPrevAccounts] = useState(accounts);
  const [prevSamples, setPrevSamples] = useState(samples);

  // Adjust during render on cacheKey change
  if (cacheKey !== prevCacheKey) {
    setPrevCacheKey(cacheKey);
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setIsLoading(false);
      const { analytics: next, built } = buildCachedAnalytics(
        cached,
        dimension,
        metric,
        range,
        accounts,
      );
      if (!buildsMatch(lastBuildRef.current, built)) {
        lastBuildRef.current = built;
        setAnalytics(next);
      }
    } else {
      if (enabled) {
        setIsLoading(true);
      }
    }
  }

  // Adjust during render on metric change (changing ONLY metric must NOT fetch)
  if (metric !== prevMetric) {
    setPrevMetric(metric);
    if (cacheKey === prevCacheKey) {
      const cached = cacheRef.current.get(cacheKey);
      if (cached) {
        const { analytics: next, built } = buildCachedAnalytics(
          cached,
          dimension,
          metric,
          range,
          accounts,
        );
        if (!buildsMatch(lastBuildRef.current, built)) {
          lastBuildRef.current = built;
          setAnalytics(next);
        }
      } else if (analytics.source === "telemetry") {
        lastBuildRef.current = null;
        setAnalytics(
          telemetryAnalytics({
            samples,
            dimension,
            metric,
            range,
            nowMs: nowMs ?? Date.now(),
            accounts,
          }),
        );
      }
    }
  }

  // Adjust during render if accounts or samples update in degraded mode
  if (accounts !== prevAccounts) {
    setPrevAccounts(accounts);
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      // Stats polls replace the accounts identity every cycle; rebuilding over
      // the same cached responses would churn analytics identity and replay
      // the chart entrance although nothing changed.
      const { analytics: next, built } = buildCachedAnalytics(
        cached,
        dimension,
        metric,
        range,
        accounts,
      );
      if (!buildsMatch(lastBuildRef.current, built)) {
        lastBuildRef.current = built;
        setAnalytics(next);
      }
    } else if (analytics.source === "telemetry") {
      lastBuildRef.current = null;
      setAnalytics(
        telemetryAnalytics({
          samples,
          dimension,
          metric,
          range,
          nowMs: nowMs ?? Date.now(),
          accounts,
        }),
      );
    }
  }

  if (samples !== prevSamples) {
    setPrevSamples(samples);
    if (analytics.source === "telemetry") {
      lastBuildRef.current = null;
      setAnalytics(
        telemetryAnalytics({
          samples,
          dimension,
          metric,
          range,
          nowMs: nowMs ?? Date.now(),
          accounts,
        }),
      );
    }
  }

  // Keep latest values in refs for async callbacks
  const metricRef = useRef(metric);
  metricRef.current = metric;

  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const samplesRef = useRef(samples);
  samplesRef.current = samples;

  const nowMsRef = useRef(nowMs);
  nowMsRef.current = nowMs;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const executeRound = useCallback(
    async (_forceFresh = false): Promise<void> => {
      if (!enabled) return;

      const currentKey = `${range}|${dimension}`;
      const isFirstRound = !cacheRef.current.has(currentKey);

      if (isFirstRound) {
        setIsLoading(true);
      }

      const generation = ++generationRef.current;
      const roundNow = nowMsRef.current ?? Date.now();

      try {
        const initialQueries = buildOverviewQueries({
          range,
          dimension,
          nowMs: roundNow,
        });

        const rankingResp = await clients.management.historyStats(initialQueries.ranking);

        if (!mountedRef.current || generation !== generationRef.current) {
          return;
        }

        const topKeys = deriveTopKeys(rankingResp, dimension, metricRef.current);

        const seriesQueries = buildOverviewQueries({
          range,
          dimension,
          nowMs: roundNow,
          topKeys,
        });

        const [seriesResp, totalSeriesResp] = await Promise.all([
          clients.management.historyStats(seriesQueries.series),
          clients.management.historyStats(seriesQueries.totalSeries),
        ]);

        if (!mountedRef.current || generation !== generationRef.current) {
          return;
        }

        const cachedResponses: CachedRawResponses = {
          ranking: rankingResp,
          series: seriesResp,
          totalSeries: totalSeriesResp,
          nowMs: roundNow,
        };
        cacheRef.current.set(currentKey, cachedResponses);

        const { analytics: nextAnalytics, built } = buildCachedAnalytics(
          cachedResponses,
          dimension,
          metricRef.current,
          range,
          accountsRef.current,
        );

        lastBuildRef.current = built;
        setAnalytics(nextAnalytics);
        setError("");
      } catch (err) {
        if (!mountedRef.current || generation !== generationRef.current) {
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        setError(message);

        const fallback = telemetryAnalytics({
          samples: samplesRef.current,
          dimension,
          metric: metricRef.current,
          range,
          nowMs: roundNow,
          accounts: accountsRef.current,
        });

        lastBuildRef.current = null;
        setAnalytics(fallback);
      } finally {
        if (mountedRef.current && generation === generationRef.current) {
          setIsLoading(false);
        }
      }
    },
    [clients, range, dimension, enabled],
  );

  const executeRoundRef = useRef(executeRound);
  executeRoundRef.current = executeRound;

  // Trigger a round on mount when enabled is true, and whenever range, dimension, clients, or enabled change
  useEffect(() => {
    if (!enabled) return;
    void executeRound();
  }, [enabled, executeRound]);

  // Schedule a repeat round every 60000 ms while enabled, skipping when document.hidden is true
  useEffect(() => {
    if (!enabled) return;

    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void executeRoundRef.current();
    }, 60000);

    return () => {
      window.clearInterval(timer);
    };
  }, [enabled]);

  const refresh = useCallback(async (): Promise<void> => {
    await executeRoundRef.current(true);
  }, []);

  if (!enabled) {
    return {
      analytics: EMPTY_ANALYTICS(dimension, metric, range),
      isLoading: false,
      error: "",
      refresh,
    };
  }

  return {
    analytics,
    isLoading,
    error,
    refresh,
  };
}

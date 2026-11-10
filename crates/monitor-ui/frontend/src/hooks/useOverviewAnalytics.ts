import type { NormalizedAccount } from "@/lib/accounts";
import type { GatewayClients } from "@/lib/api";
import { GatewayError } from "@/lib/api";
import {
  EMPTY_ANALYTICS,
  type OverviewAnalytics,
  type OverviewDimension,
  type OverviewMetric,
  buildAnalytics,
  buildOverviewQueries,
  telemetryAnalytics,
} from "@/lib/overview-analytics";
import type { HistoryStatsResponse } from "@/lib/schemas";
import type { TelemetryRange, TelemetrySample } from "@/lib/telemetry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/// Turns a failed analytics round into something an operator can act on.
///
/// The gateway payload is parsed with Zod at the boundary, and a ZodError's
/// `message` is the serialized issue array. Rendering that verbatim put a JSON
/// dump of `code`/`expected`/`path` objects in the dashboard where a sentence
/// belongs, which says nothing about what broke or what to do next.
const describeAnalyticsFailure = (error: unknown): string => {
  if (error instanceof Error && error.name === "ZodError") {
    return "The gateway returned usage data this console does not understand. Update the gateway or the app so both speak the same schema.";
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "Usage history is unavailable right now.";
};

/// Only failures an operator can act on (auth, version skew) earn a banner;
/// rate limits, 5xx and timeouts are operational and fall back silently.
const isActionableAnalyticsFailure = (error: unknown): boolean =>
  (error instanceof Error && error.name === "ZodError") ||
  (error instanceof GatewayError && (error.status === 401 || error.status === 403));

const isOperationalAnalyticsFailure = (error: unknown): boolean =>
  error instanceof GatewayError &&
  (error.status === 0 || error.status === 429 || error.status >= 500);

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
  JSON.stringify(accounts.map((account) => [
    account.id, account.email, account.label, account.provider, account.credentialName,
  ]));

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

  const [previousInputs, setPreviousInputs] = useState({
    cacheKey, metric, accounts, samples, enabled, nowMs, clients,
  });
  if (
    previousInputs.cacheKey !== cacheKey || previousInputs.metric !== metric ||
    previousInputs.accounts !== accounts || previousInputs.samples !== samples ||
    previousInputs.enabled !== enabled || previousInputs.nowMs !== nowMs ||
    previousInputs.clients !== clients
  ) {
    setPreviousInputs({ cacheKey, metric, accounts, samples, enabled, nowMs, clients });
    if (enabled) {
      const cached = cacheRef.current.get(cacheKey);
      if (cached) {
        const built: BuiltFrom = {
          cacheKey, metric, ranking: cached.ranking, series: cached.series,
          totalSeries: cached.totalSeries, nowMs: cached.nowMs,
          accountsKey: accountIdentityKey(accounts),
        };
        if (!buildsMatch(lastBuildRef.current, built)) {
          const next = buildCachedAnalytics(cached, dimension, metric, range, accounts);
          lastBuildRef.current = next.built;
          setAnalytics(next.analytics);
        }
        setIsLoading(false);
      } else if (analytics.source === "telemetry" && previousInputs.clients === clients) {
        lastBuildRef.current = null;
        setAnalytics(telemetryAnalytics({
          samples, dimension, metric, range, nowMs: nowMs ?? Date.now(), accounts,
        }));
      } else {
        setIsLoading(true);
      }
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

        // The series query stays unfiltered on purpose: filtering it to the
        // fetch-time top-N keys froze the cached series to whichever metric
        // was selected during that round, so a later metric switch rendered
        // the previous metric's key set instead of the selected metric's
        // amounts. Full-key series let every metric switch recompute
        // truthfully from the cached raw responses without a refetch.
        const [seriesResp, totalSeriesResp] = await Promise.all([
          clients.management.historyStats(initialQueries.series),
          clients.management.historyStats(initialQueries.totalSeries),
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

        // A cached round for this key is still truthful history: keep showing
        // it instead of swapping to the telemetry fallback. Only a failure the
        // operator must act on raises the banner over it.
        const actionable = isActionableAnalyticsFailure(err);
        if (cacheRef.current.has(currentKey)) {
          if (actionable) setError(describeAnalyticsFailure(err));
          return;
        }
        setError(
          actionable || !isOperationalAnalyticsFailure(err) ? describeAnalyticsFailure(err) : "",
        );

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
    return () => {
      generationRef.current += 1;
    };
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

    // Rounds are skipped while hidden; catch up the moment the window is shown
    // instead of serving history up to a minute behind the stats poll.
    const onVisibility = () => {
      if (!document.hidden) void executeRoundRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  const refresh = useCallback(async (): Promise<void> => {
    await executeRoundRef.current(true);
  }, []);

  // App.tsx only forwards `analytics` and `error` into OverviewDashboard, so a
  // top-level `isLoading` would be discarded before any surface can use it
  // (F-M1). Carry the flag inside the analytics object instead: rows keep
  // their identity, but no surface presents them as the current window while a
  // round for the current cache key is in flight.
  const presentedAnalytics = useMemo(
    () => (isLoading ? { ...analytics, isLoading: true } : analytics),
    [analytics, isLoading],
  );

  if (!enabled) {
    return {
      analytics: EMPTY_ANALYTICS(dimension, metric, range),
      isLoading: false,
      error: "",
      refresh,
    };
  }

  return {
    analytics: presentedAnalytics,
    isLoading,
    error,
    refresh,
  };
}

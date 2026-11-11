import { type GatewayClients, GatewayError } from "@/lib/api";
import type { GatewayLifecycleStatus } from "@/lib/native";
import {
  type AdminStats,
  type AuthFileItem,
  EXPECTED_API_SCHEMA,
  type GatewayModelEntry,
  type LogRecord,
  type ModelRegistryStatus,
} from "@/lib/schemas";
import {
  DEFAULT_HISTORY_MINUTES,
  type TelemetrySample,
  appendTelemetrySample,
  persistedTelemetrySamples,
} from "@/lib/telemetry";
import { useCallback, useEffect, useRef, useState } from "react";

export type LoadState = "loading" | "online" | "starting" | "stopped" | "relay-locked";

/** Outcome of one refresh round. A superseded round (a newer refresh started
 * while it was in flight) says nothing about gateway health, so the poll loop
 * must not back off on it. A relay-locked round means the gateway rejected our
 * credentials, which no amount of retrying can fix. */
type RoundOutcome = "ok" | "failed" | "relay-locked" | "superseded";

const POLL_INTERVAL_MS = 10_000;
const STARTUP_RETRY_MS = 2_000;

/** Upper bound on the one history-carrying round. The history in
 * `/admin/stats` only backfills the charts when `history/stats` is unavailable,
 * so it must never size the opening request by the stored chart range: the
 * gateway's full month of retention is 21.6MB and takes 82s to serialize,
 * against 556KB and 5.3s for a day. */
const MAX_BACKFILL_MINUTES = 24 * 60;

/** Log lines pulled per poll. The Logs table reads paginated history; this tail
 * only backs the proxy view, so an unbounded reply would re-ship the whole
 * on-disk log on every cycle. */
const LOG_TAIL_LIMIT = 500;

/** Next poll delay after a round: fast retries until the first success, then
 * a 10s cadence with capped exponential backoff on later failures. Before
 * the first successful stats fetch the freshly spawned gateway is still
 * coming up, so failures retry fast instead of backing off for tens of
 * seconds. */
export function nextPollDelayMs(ok: boolean, hasSucceeded: boolean, delay: number): number {
  if (ok) return POLL_INTERVAL_MS;
  if (!hasSucceeded) return STARTUP_RETRY_MS;
  return Math.min(delay * 2, 60_000);
}

const emptyStats: AdminStats = {
  uptime_secs: 0,
  in_flight: 0,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  ttft: null,
  accounts: [],
  history: [],
};

/**
 * Owns the gateway poll. Contract: user-triggered refreshes spin the tray
 * icon; background polls never do, and failed rounds back off exponentially.
 *
 * `historyMinutes` is the span of per-minute buckets the first round backfills
 * for the charts. It follows the chart's selected range so the opening request
 * never drags the gateway's whole month-long retention across the wire.
 */
export function useGatewayPolling(
  clients: GatewayClients,
  historyMinutes: number = DEFAULT_HISTORY_MINUTES,
) {
  const [stats, setStats] = useState<AdminStats>(emptyStats);
  const [credentials, setCredentials] = useState<readonly AuthFileItem[]>([]);
  const [logs, setLogs] = useState<readonly LogRecord[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [gatewayLifecycle, setGatewayLifecycle] = useState<GatewayLifecycleStatus>("running");
  const [telemetry, setTelemetry] = useState<readonly TelemetrySample[]>([]);
  const [credentialsError, setCredentialsError] = useState("");
  const [inventoryState, setInventoryState] = useState<"loading" | "ready" | "error">("loading");
  const [logsError, setLogsError] = useState("");
  const [schemaMismatch, setSchemaMismatch] = useState<string | null>(null);
  const [modelRegistryStatus, setModelRegistryStatus] = useState<ModelRegistryStatus | null>(null);
  const [modelRegistryError, setModelRegistryError] = useState("");
  const [gatewayModels, setGatewayModels] = useState<readonly GatewayModelEntry[]>([]);
  const firstLoad = useRef(true);
  const hasSucceeded = useRef(false);
  // Read through a ref so a chart range change does not invalidate `runRound`, which
  // would restart the poll loop and abort the round already in flight.
  const historyMinutesRef = useRef(historyMinutes);
  useEffect(() => {
    historyMinutesRef.current = historyMinutes;
  }, [historyMinutes]);
  const usageRefreshAt = useRef(0);
  const pollGeneration = useRef(0);
  const spinTimerRef = useRef<number | undefined>(undefined);
  const manualRefreshInFlight = useRef<GatewayClients | null>(null);
  const prevClientsRef = useRef(clients);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  if (prevClientsRef.current !== clients) {
    prevClientsRef.current = clients;
    pollGeneration.current += 1;
    firstLoad.current = true;
    hasSucceeded.current = false;
    usageRefreshAt.current = 0;
  }

  // `clients` is this hook's own parameter, not an outer-scope value: dropping it
  // makes the previous gateway's stats and telemetry survive a gateway switch,
  // which use-gateway-polling.test.tsx pins.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dep is a hook parameter and is load-bearing
  useEffect(() => {
    // Reset server-bound state when clients change to isolate gateways.
    setStats(emptyStats);
    setTelemetry([]);
    setFetchedAt(null);
    setLoadState("loading");
    // Drop the previous gateway's logs/credentials too, so its tail and auth
    // never linger under the new gateway until the first successful poll.
    setLogs([]);
    setLogsError("");
    setCredentials([]);
    setInventoryState("loading");
    setModelRegistryStatus(null);
    setGatewayModels([]);
    setCredentialsError("");
    setModelRegistryError("");
    setSchemaMismatch(null);
    setRefreshing(false);
    manualRefreshInFlight.current = null;
    window.clearTimeout(spinTimerRef.current);
  }, [clients]);

  // Mirrors gatewayLifecycle so refresh can read it without becoming a new
  // callback on every lifecycle flip, which remounted the poll effect and
  // duplicated in-flight polls.
  const gatewayLifecycleRef = useRef(gatewayLifecycle);
  useEffect(() => {
    gatewayLifecycleRef.current = gatewayLifecycle;
  }, [gatewayLifecycle]);

  // The gateway publishes its management wire version on the public /healthz
  // probe; a mismatch means IPC calls may silently misbehave, so the console
  // says so instead of failing feature-by-feature. Re-probed whenever the
  // gateway comes (back) online: a restart or upgrade under the same URL can
  // fix or introduce a mismatch.
  useEffect(() => {
    if (loadState !== "online") return;
    let active = true;
    void clients.admin
      .health()
      .then((health) => {
        if (!active) return;
        if (health.api_schema !== EXPECTED_API_SCHEMA) {
          setSchemaMismatch(
            `Gateway ${health.version} speaks management schema ${health.api_schema}, this console expects ${EXPECTED_API_SCHEMA}. Update the gateway or the app.`,
          );
        } else {
          setSchemaMismatch(null);
        }
      })
      .catch(() => {
        // An unreachable gateway is already surfaced through the load state.
      });
    return () => {
      active = false;
    };
  }, [clients, loadState]);

  const refreshUsage = useCallback(
    async (force = false) => {
      if (!mounted.current || prevClientsRef.current !== clients) return;
      const now = Date.now();
      if (!force && now - usageRefreshAt.current < 30_000) return;
      usageRefreshAt.current = now;
      const api = (
        window as {
          __TAURI__?: {
            core?: { invoke: (command: string) => Promise<unknown> };
          };
        }
      ).__TAURI__;
      try {
        if (api?.core) await api.core.invoke("refresh_usage");
        else await clients.management.usageRefresh();
      } catch {
        // the 120s poller is the fallback when the on-demand pass fails
      }
    },
    [clients],
  );

  const runRound = useCallback(async (): Promise<RoundOutcome> => {
    if (!mounted.current || prevClientsRef.current !== clients) return "superseded";
    const generation = ++pollGeneration.current;
    if (firstLoad.current) setLoadState("loading");
    // One round is a stats snapshot plus four independent reads. They used to
    // run in sequence, so a slow snapshot also held back credentials and logs:
    // the gateway answered both in under a second, yet the Accounts and Logs
    // surfaces stayed empty until the whole snapshot finished. Start the
    // snapshot now, but never let it gate the reads.
    //
    // Only the first round carries the bucket history that feeds the charts,
    // and only for the selected range. Every later round asks for the live
    // counters alone: the charts keep accumulating samples locally, while the
    // response drops from tens of megabytes to a few kilobytes.
    // `admin.stats` carries two unrelated things: the live counters every
    // surface reads, and a bucket history that only backfills the charts when
    // the dedicated `history/stats` source is unavailable. That history is the
    // expensive half -- the gateway serializes one bucket per minute of every
    // minute it is asked for, measured at 556KB for a day and 21.6MB/82s for
    // the full month of retention -- so a backfill the console normally throws
    // away must not be allowed to pick the size of the opening request.
    //
    // A day is enough to keep the fallback charts useful, and it always lands
    // well inside the stats deadline no matter which range the switcher has
    // stored. Later rounds ask for the live counters alone.
    const wantsHistory = firstLoad.current;
    const statsAttempt = clients.admin
      .stats(
        wantsHistory
          ? { historyMinutes: Math.min(historyMinutesRef.current, MAX_BACKFILL_MINUTES) }
          : { historyMinutes: 0 },
      )
      .then(
        (stats) => ({ stats }) as const,
        (error: unknown) => ({ error }) as const,
      );
    hasSucceeded.current = true;
    // These are independent so failures in optional services do not strip credentials.
    const [credentialResult, logResult, registryResult, modelsResult] = await Promise.allSettled([
      clients.management.credentials(),
      clients.management.logs(LOG_TAIL_LIMIT),
      clients.management.modelRegistryStatus(),
      clients.management.models(),
    ]);
    if (generation !== pollGeneration.current) return "superseded";
    // A transient rejection keeps the last good inventory/models (unknown is
    // not empty); the [clients] reset effect clears them on a gateway switch.
    if (credentialResult.status === "fulfilled") {
      setCredentials(credentialResult.value);
      setCredentialsError("");
      setInventoryState("ready");
    } else {
      setInventoryState("error");
      setCredentialsError(
        credentialResult.reason instanceof Error
          ? credentialResult.reason.message
          : "unknown error",
      );
    }
    if (logResult.status === "fulfilled") {
      setLogs(logResult.value.records);
      setLogsError("");
    } else {
      setLogs([]);
      setLogsError(logResult.reason instanceof Error ? logResult.reason.message : "unknown error");
    }
    if (registryResult.status === "fulfilled") {
      setModelRegistryStatus(registryResult.value);
      setModelRegistryError("");
    } else {
      setModelRegistryStatus(null);
      setModelRegistryError(
        registryResult.reason instanceof Error ? registryResult.reason.message : "unknown error",
      );
    }
    if (modelsResult.status === "fulfilled") {
      setGatewayModels(modelsResult.value);
    }
    // The snapshot finishes last because it is by far the slowest read; the
    // gateway serializes its whole telemetry store with it.
    const attempt = await statsAttempt;
    if (generation !== pollGeneration.current) return "superseded";
    if ("stats" in attempt) {
      const nextStats = attempt.stats;
      setStats(nextStats);
      const now = Date.now();
      setTelemetry((samples) => {
        // A round that asked for history owns the chart state, including an
        // empty one: that is how a gateway switch clears the previous samples.
        // A live-only round carries no buckets, so append it to keep the
        // charts moving between full reads.
        if (wantsHistory && Array.isArray(nextStats.history)) {
          return persistedTelemetrySamples(nextStats.history);
        }
        return appendTelemetrySample(samples, nextStats, now);
      });
      setLoadState("online");
      setFetchedAt(now);
      setGatewayLifecycle("running");
      firstLoad.current = false;
      return "ok";
    }
    const error = attempt.error;
    const locked = error instanceof GatewayError && error.status === 401;
    setLoadState(
      locked
        ? "relay-locked"
        : gatewayLifecycleRef.current === "stopped"
          ? "stopped"
          : "starting",
    );
    firstLoad.current = false;
    return locked ? "relay-locked" : "failed";
  }, [clients]);

  const refresh = useCallback(
    async (): Promise<boolean> => (await runRound()) === "ok",
    [runRound],
  );

  useEffect(() => () => window.clearTimeout(spinTimerRef.current), []);

  // Only a refresh the user asked for spins the tray icon; the 10s poll must
  // not make it spin on its own. The spinner covers the whole manual round:
  // the forced usage pass waits on every account's upstream quota call, so
  // spinning only after it settled left the button looking dead for seconds.
  // A click while a round is in flight is dropped instead of stacking another
  // full quota pass.
  const refreshNow = useCallback(async () => {
    if (!mounted.current || prevClientsRef.current !== clients || manualRefreshInFlight.current) return;
    manualRefreshInFlight.current = clients;
    setRefreshing(true);
    window.clearTimeout(spinTimerRef.current);
    const start = Date.now();
    try {
      // Usage first, so the snapshot read next carries the new quota rather
      // than the previous poll's.
      await refreshUsage(true);
      await refresh();
    } finally {
      if (mounted.current && prevClientsRef.current === clients && manualRefreshInFlight.current === clients) {
        manualRefreshInFlight.current = null;
        const elapsed = Date.now() - start;
        const minSpinMs = 500;
        if (elapsed < minSpinMs) {
          spinTimerRef.current = window.setTimeout(() => setRefreshing(false), minSpinMs - elapsed);
        } else {
          setRefreshing(false);
        }
      }
    }
  }, [clients, refresh, refreshUsage]);

  useEffect(() => {
    // Polls every 10s on a healthy gateway; each failed round doubles the
    // delay (capped at 60s) so a down gateway is not hammered while hidden
    // tabs stay paused.
    let timer = 0;
    let delay = POLL_INTERVAL_MS;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) {
        timer = window.setTimeout(tick, delay);
        return;
      }
      const outcome = await runRound();
      // A 401 means the gateway rejected our credentials. Five failed
      // management calls trip its brute-force guard and ban this machine for
      // 30 minutes, so stop polling until the key changes: a new key rebuilds
      // `clients`, which restarts this effect and polls at once.
      if (outcome === "relay-locked") return;
      if (outcome !== "superseded") {
        delay = nextPollDelayMs(outcome === "ok", hasSucceeded.current, delay);
      }
      if (!cancelled) timer = window.setTimeout(tick, delay);
    };
    void tick();
    return () => {
      cancelled = true;
      pollGeneration.current += 1;
      window.clearTimeout(timer);
    };
  }, [runRound]);

  useEffect(() => {
    // The console window is created hidden; the moment the OS brings it to
    // front (dock reopen, tray open) the visible data must load right then.
    const tauriWindow = (
      window as unknown as {
        __TAURI__?: {
          window?: {
            getCurrentWindow?: () => {
              onFocusChanged?: (
                handler: (event: { payload: boolean }) => void,
              ) => Promise<() => void>;
            };
          };
        };
      }
    ).__TAURI__;
    const currentWindow = tauriWindow?.window?.getCurrentWindow?.();
    if (!currentWindow?.onFocusChanged) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void currentWindow
      .onFocusChanged((event) => {
        if (event.payload && !document.hidden) void refresh();
      })
      .then((fn) => {
        if (disposed) fn?.();
        else unlisten = fn;
      })
      .catch(() => {
        // Focus refresh is an optimization; the regular poll remains authoritative.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  useEffect(() => {
    // hidden tray/notch windows skip the poll; the moment one becomes visible
    // it must show fresh quota instead of waiting for the next tick
    const onVisibility = () => {
      if (!document.hidden) void refreshUsage().finally(() => void refresh());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh, refreshUsage]);

  return {
    stats,
    setStats,
    credentials,
    setCredentials,
    logs,
    setLogs,
    credentialsError,
    inventoryState,
    logsError,
    loadState,
    setLoadState,
    fetchedAt,
    refreshing,
    gatewayLifecycle,
    setGatewayLifecycle,
    telemetry,
    setTelemetry,
    schemaMismatch,
    modelRegistryStatus,
    setModelRegistryStatus,
    modelRegistryError,
    gatewayModels,
    setGatewayModels,
    refresh,
    refreshUsage,
    refreshNow,
  };
}

import { type GatewayClients, GatewayError } from "@/lib/api";
import type { GatewayLifecycleStatus } from "@/lib/native";
import { EXPECTED_API_SCHEMA } from "@/lib/schemas";
import type { LogRecord } from "@/lib/schemas";
import type { AdminStats, AuthFileItem } from "@/lib/schemas";
import {
  type TelemetrySample,
  appendTelemetrySample,
  persistedTelemetrySamples,
} from "@/lib/telemetry";
import { useCallback, useEffect, useRef, useState } from "react";

export type LoadState = "loading" | "online" | "starting" | "stopped" | "relay-locked";

const POLL_INTERVAL_MS = 10_000;

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
 */
export function useGatewayPolling(clients: GatewayClients) {
  const [stats, setStats] = useState<AdminStats>(emptyStats);
  const [credentials, setCredentials] = useState<readonly AuthFileItem[]>([]);
  const [logs, setLogs] = useState<readonly LogRecord[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [gatewayLifecycle, setGatewayLifecycle] = useState<GatewayLifecycleStatus>("running");
  const [telemetry, setTelemetry] = useState<readonly TelemetrySample[]>([]);
  const [credentialsError, setCredentialsError] = useState("");
  const [logsError, setLogsError] = useState("");
  const [schemaMismatch, setSchemaMismatch] = useState<string | null>(null);
  const firstLoad = useRef(true);
  const usageRefreshAt = useRef(0);

  // Mirrors gatewayLifecycle so refresh can read it without becoming a new
  // callback on every lifecycle flip, which remounted the poll effect and
  // duplicated in-flight polls.
  const gatewayLifecycleRef = useRef(gatewayLifecycle);
  useEffect(() => {
    gatewayLifecycleRef.current = gatewayLifecycle;
  }, [gatewayLifecycle]);

  // The gateway publishes its management wire version on the public /healthz
  // probe; a mismatch means IPC calls may silently misbehave, so the console
  // says so instead of failing feature-by-feature.
  const checkGatewayVersion = useCallback(async () => {
    try {
      const health = await clients.admin.health();
      if (health.api_schema !== EXPECTED_API_SCHEMA) {
        setSchemaMismatch(
          `Gateway ${health.version} speaks management schema ${health.api_schema}, this console expects ${EXPECTED_API_SCHEMA}. Update the gateway or the app.`,
        );
      } else {
        setSchemaMismatch(null);
      }
    } catch {
      // An unreachable gateway is already surfaced through the load state.
    }
  }, [clients]);
  useEffect(() => {
    void checkGatewayVersion();
  }, [checkGatewayVersion]);

  const refreshUsage = useCallback(
    async (force = false) => {
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

  const refresh = useCallback(async (): Promise<boolean> => {
    if (firstLoad.current) setLoadState("loading");
    let succeeded = true;
    try {
      const nextStats = await clients.admin.stats();
      setStats(nextStats);
      const now = Date.now();
      setTelemetry((samples) => {
        const persisted = persistedTelemetrySamples(nextStats.history ?? []);
        return persisted.length ? persisted : appendTelemetrySample(samples, nextStats, now);
      });
      setLoadState("online");
      setFetchedAt(Date.now());
      setGatewayLifecycle("running");
      firstLoad.current = false;
    } catch (error) {
      succeeded = false;
      setLoadState(
        error instanceof GatewayError && error.status === 401
          ? "relay-locked"
          : gatewayLifecycleRef.current === "stopped"
            ? "stopped"
            : "starting",
      );
      firstLoad.current = false;
      return false;
    }
    // These two are independent: the gateway rejects /logs outright while file
    // logging is disabled, and folding both into one Promise.all used to wipe the
    // credential inventory on every poll, silently stripping account management.
    const [credentialResult, logResult] = await Promise.allSettled([
      clients.management.credentials(),
      clients.management.logs(),
    ]);
    if (credentialResult.status === "fulfilled") {
      setCredentials(credentialResult.value);
      setCredentialsError("");
    } else {
      setCredentials([]);
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
    return succeeded;
  }, [clients]);

  // Only a refresh the user asked for spins the tray icon; the 10s poll must
  // not make it spin on its own.
  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

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
      const ok = await refresh();
      delay = ok ? POLL_INTERVAL_MS : Math.min(delay * 2, 60_000);
      if (!cancelled) timer = window.setTimeout(tick, delay);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
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
    refresh,
    refreshUsage,
    refreshNow,
  };
}

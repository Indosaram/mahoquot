import type { LoadState } from "@/hooks/useGatewayPolling";
import type { GatewayClients } from "@/lib/api";
import { pendingKey } from "@/lib/pending";
import type { ProviderProxyPolicy, ProxyProvidersMap } from "@/lib/schemas";
import { parseProxyProviders } from "@/lib/schemas";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

type SetText = (value: string) => void;

/**
 * Load state of the six gateway scalars read by this hook.
 * `loading` covers both "waiting to start" and "read in flight".
 */
export type SettingsScalarsStatus = "loading" | "loaded" | "error";

let settingsScalarsStatus: SettingsScalarsStatus = "loading";
const settingsScalarsListeners = new Set<() => void>();

const setSettingsScalarsStatus = (next: SettingsScalarsStatus) => {
  if (next === settingsScalarsStatus) return;
  settingsScalarsStatus = next;
  for (const listener of settingsScalarsListeners) listener();
};

/** Synchronous read so save paths can gate without waiting for a re-render. */
export const getSettingsScalarsStatus = (): SettingsScalarsStatus => settingsScalarsStatus;

export const subscribeSettingsScalarsStatus = (listener: () => void): (() => void) => {
  settingsScalarsListeners.add(listener);
  return () => {
    settingsScalarsListeners.delete(listener);
  };
};

/**
 * Surfaces the hook-owned scalar load state to components (SettingsSurface
 * gates Save on it) without prop wiring through App.tsx.
 */
export function useSettingsScalarsStatus(): SettingsScalarsStatus {
  return useSyncExternalStore(
    subscribeSettingsScalarsStatus,
    getSettingsScalarsStatus,
    getSettingsScalarsStatus,
  );
}

interface ConnectionSettingsArgs {
  clients: GatewayClients;
  loadState: LoadState;
  surface: string;
  setNotice: SetText;
  setPending: SetText;
}

/**
 * Connection/scalar settings surface state: reading the gateway's scalars once
 * per surface visit, persisting edits, and re-reading them after a save that
 * may have repointed the console at a different gateway instance.
 */
export function useConnectionSettings({
  clients,
  loadState,
  surface,
  setNotice,
  setPending,
}: ConnectionSettingsArgs) {
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyProviders, setProxyProviders] = useState<ProxyProvidersMap>({});
  const [routingStrategy, setRoutingStrategy] = useState("round-robin");
  const [requestRetry, setRequestRetry] = useState("3");
  const [loggingToFile, setLoggingToFile] = useState(false);
  const [codexFastMode, setCodexFastMode] = useState(false);
  const [settingsLoaded, setSettingsLoadedState] = useState(false);

  // App.tsx drops this latch directly after connection/config/gateway changes;
  // wrap it so every drop also flips the external status the Save gate reads.
  const setSettingsLoaded = useCallback((loaded: boolean) => {
    setSettingsLoadedState(loaded);
    setSettingsScalarsStatus(loaded ? "loaded" : "loading");
  }, []);

  // Gateway restarts and connection losses outside App's own actions (crash,
  // manual restart) invalidate the latched scalars. Drop the latch only on an
  // online → offline TRANSITION: a drop on every non-online render would
  // ping-pong with the read effect below (read succeeds → loaded → drop →
  // read …), starving the event loop whenever reads answer while the gateway
  // reports anything but "online".
  const gatewayWasOnlineRef = useRef(false);
  useEffect(() => {
    const wasOnline = gatewayWasOnlineRef.current;
    gatewayWasOnlineRef.current = loadState === "online";
    if (wasOnline && loadState !== "online" && settingsLoaded) setSettingsLoaded(false);
  }, [loadState, setSettingsLoaded, settingsLoaded]);

  useEffect(() => {
    // Start the scalar read at mount (H1): the Save gate must be armed before
    // the settings card first renders, so reads cannot wait for a settings
    // visit or for loadState to settle. A failure stays silent off-surface and
    // retries whenever clients/loadState/surface change (gateway comes online,
    // connection saved, settings reopened).
    // A relay lock answers scalar reads with 401 — skip while locked so the
    // status keeps its honest "waiting" state, and re-run when loadState moves.
    // A prior run may have populated the form while this run was orphaned by a
    // dep change; reconcile the store instead of leaving it on "loading".
    if (settingsLoaded) {
      if (getSettingsScalarsStatus() !== "error") setSettingsScalarsStatus("loaded");
      return;
    }
    if (loadState === "relay-locked") return;
    let active = true;
    setSettingsScalarsStatus("loading");
    void Promise.all([
      clients.management.scalar("proxy-url"),
      clients.management.scalar("routing/strategy"),
      clients.management.scalar("request-retry"),
      clients.management.scalar("logging-to-file"),
      clients.management.scalar("codex-fast-mode"),
      clients.management.scalar("proxy-providers").catch(() => ({})),
    ])
      .then(([proxy, routing, retry, logging, fastMode, providers]) => {
        if (!active) return;
        if (typeof proxy["proxy-url"] === "string") setProxyUrl(proxy["proxy-url"]);
        if (typeof routing.strategy === "string") setRoutingStrategy(routing.strategy);
        if (typeof retry["request-retry"] === "number") {
          setRequestRetry(String(retry["request-retry"]));
        }
        if (typeof logging["logging-to-file"] === "boolean") {
          setLoggingToFile(logging["logging-to-file"]);
        }
        if (typeof fastMode["codex-fast-mode"] === "boolean") {
          setCodexFastMode(fastMode["codex-fast-mode"]);
        }
        setProxyProviders(parseProxyProviders(providers));
        setSettingsLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) {
          setSettingsScalarsStatus("error");
          // Only surface the failure while the settings card is visible; elsewhere
          // the Save gate + inline alert cover it when the user arrives.
          if (surface === "settings") {
            setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
          }
        }
      });
    return () => {
      active = false;
    };
  }, [clients, loadState, setNotice, settingsLoaded, setSettingsLoaded, surface]);

  const saveProxySettings = useCallback(async () => {
    const retry = Number(requestRetry);
    if (!Number.isInteger(retry) || retry < 0) {
      setNotice("Request retry count must be a non-negative integer.");
      return;
    }
    // H1: before the scalar read completes (or after it fails) the form holds
    // hardcoded defaults — never persist them over the gateway's live values.
    if (getSettingsScalarsStatus() !== "loaded") {
      setNotice("Gateway settings have not loaded yet; wait for them before saving.");
      return;
    }
    setPending(pendingKey.settingsSave);
    setNotice("");
    try {
      await Promise.all([
        clients.management.saveScalar("proxy-url", proxyUrl.trim()),
        clients.management.saveScalar("routing/strategy", routingStrategy),
        clients.management.saveScalar("request-retry", retry),
        clients.management.saveScalar("logging-to-file", loggingToFile),
        clients.management.saveScalar("codex-fast-mode", codexFastMode),
      ]);
      setNotice("Proxy settings saved and applied.");
      // The save may have repointed the console at a different gateway
      // instance; drop the loaded-settings latch so its scalars re-read.
      setSettingsLoaded(false);
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  }, [
    clients,
    codexFastMode,
    loggingToFile,
    proxyUrl,
    requestRetry,
    routingStrategy,
    setNotice,
    setPending,
    setSettingsLoaded,
  ]);

  const saveProviderProxySettings = useCallback(async () => {
    // Same H1 gate as saveProxySettings: the provider table is part of the
    // same scalar batch, so an unloaded form must not overwrite it either.
    if (getSettingsScalarsStatus() !== "loaded") {
      setNotice("Gateway settings have not loaded yet; wait for them before saving.");
      return;
    }
    setPending(pendingKey.settingsSave);
    setNotice("");
    try {
      await clients.management.saveScalar(
        "proxy-providers",
        proxyProviders as unknown as Record<string, unknown>,
      );
      setNotice("Provider proxy routing saved and applied live.");
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  }, [clients, proxyProviders, setNotice, setPending]);

  const updateProxyProviderPolicy = useCallback(
    (provider: string, patch: Partial<ProviderProxyPolicy>) => {
      setProxyProviders((prev) => {
        const current = prev[provider] ?? {
          enabled: false,
          sticky: true,
          "ttl-secs": 0,
          url: "",
        };
        return {
          ...prev,
          [provider]: {
            ...current,
            ...patch,
          },
        };
      });
    },
    [],
  );

  return {
    proxyUrl,
    setProxyUrl,
    proxyProviders,
    setProxyProviders,
    updateProxyProviderPolicy,
    routingStrategy,
    setRoutingStrategy,
    requestRetry,
    setRequestRetry,
    loggingToFile,
    setLoggingToFile,
    codexFastMode,
    setCodexFastMode,
    settingsLoaded,
    setSettingsLoaded,
    saveProxySettings,
    saveProviderProxySettings,
  };
}

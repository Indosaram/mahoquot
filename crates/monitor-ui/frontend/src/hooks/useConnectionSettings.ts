import type { LoadState } from "@/hooks/useGatewayPolling";
import type { GatewayClients } from "@/lib/api";
import { pendingKey } from "@/lib/pending";
import type { ProviderProxyPolicy, ProxyProvidersMap } from "@/lib/schemas";
import { parseProxyProviders } from "@/lib/schemas";
import { useCallback, useEffect, useState } from "react";

type SetText = (value: string) => void;

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
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    if (surface !== "settings" || settingsLoaded || loadState !== "online") return;
    let active = true;
    void Promise.all([
      clients.management.scalar("proxy-url"),
      clients.management.scalar("routing/strategy"),
      clients.management.scalar("request-retry"),
      clients.management.scalar("logging-to-file"),
      clients.management.scalar("proxy-providers").catch(() => ({})),
    ])
      .then(([proxy, routing, retry, logging, providers]) => {
        if (!active) return;
        if (typeof proxy["proxy-url"] === "string") setProxyUrl(proxy["proxy-url"]);
        if (typeof routing.strategy === "string") setRoutingStrategy(routing.strategy);
        if (typeof retry["request-retry"] === "number") {
          setRequestRetry(String(retry["request-retry"]));
        }
        if (typeof logging["logging-to-file"] === "boolean") {
          setLoggingToFile(logging["logging-to-file"]);
        }
        setProxyProviders(parseProxyProviders(providers));
        setSettingsLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      });
    return () => {
      active = false;
    };
  }, [clients, loadState, setNotice, settingsLoaded, surface]);

  const saveProxySettings = useCallback(async () => {
    const retry = Number(requestRetry);
    if (!Number.isInteger(retry) || retry < 0) {
      setNotice("Request retry count must be a non-negative integer.");
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
  }, [clients, loggingToFile, proxyUrl, requestRetry, routingStrategy, setNotice, setPending]);

  const saveProviderProxySettings = useCallback(async () => {
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
    settingsLoaded,
    setSettingsLoaded,
    saveProxySettings,
    saveProviderProxySettings,
  };
}

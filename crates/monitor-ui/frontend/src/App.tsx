import { useConnectionSettings } from "@/hooks/useConnectionSettings";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  KeyRound,
  Plus,
  RefreshCw,
  Settings2,
  TerminalSquare,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountsSurface, accountMenuItems } from "./components/AccountsSurface";
import { AgentsSurface } from "./components/AgentsSurface";
import { ContextMenu, useContextMenu } from "./components/ContextMenu";
import { DurableLogs } from "./components/DurableLogs";
import { NotchSurface } from "./components/NotchSurface";
import { OverviewDashboard } from "./components/OverviewDashboard";
import { ProviderGlyph, providerLabel } from "./components/ProviderGlyph";
import { SettingsSurface } from "./components/SettingsSurface";
import { ToastStack, useToasts } from "./components/Toasts";
import { TotpVaultSurface } from "./components/TotpVaultSurface";
import { TrayPanel } from "./components/TrayPanel";
import { AppShell, OverlayLayer } from "./components/layout";
import { Button } from "./components/ui";
import { useGatewayPolling } from "./hooks/useGatewayPolling";
import { useTotpVault } from "./hooks/useTotpVault";
import { type NormalizedAccount, mergeAccountsAndCredentials } from "./lib/accounts";
import { createGatewayClients, discoverProviderModels } from "./lib/api";
import type { HistoryStatsQuery, ProviderAuthStatus } from "./lib/api";
import { wantsNativeMenu } from "./lib/context-menu";
import {
  type CliAgentId,
  type CliAgentStatus,
  type CliConfigPreview,
  type CodexInstance,
  type CodexLaunchRequest,
  type NativeSettingsState,
  SecretStoreError,
  type UpdateStatus,
  checkForUpdate,
  configureCliAgent,
  downloadCloudflared,
  getGatewayLifecycle,
  getNativeSettings,
  getTunnelStatus,
  installUpdate,
  launchCodexInstance,
  listCliAgents,
  listCodexInstances,
  migrateLegacyDesktopSecret,
  openExternalUrl,
  previewCliAgent,
  readDesktopSecret,
  requestNativeNotificationPermission,
  restoreCliAgent,
  setLoginStart,
  startManagedGateway,
  startTunnel,
  stopCodexInstance,
  stopManagedGateway,
  stopTunnel,
  writeDesktopSecret,
} from "./lib/native";
import {
  ACCOUNT_KIND_STEP,
  CUSTOM_API_PROVIDER_TILE,
  LOCAL_IMPORT_METHODS,
  ONBOARDING_PROVIDERS,
  type OnboardingScope,
  type OnboardingStep,
  PROVIDER_STEP,
  formStepFor,
} from "./lib/onboarding";
import { blocks, pendingKey } from "./lib/pending";
import { GENERIC_PROVIDER_OPTIONS } from "./lib/provider-catalog";
import { RELAY_PLAN_GROUPS, buildRelayCredential, isRelayTarget } from "./lib/relay-plans";
import type { ScopedApiKey } from "./lib/schemas";
import {
  type HistoryHealth,
  type HistoryStatsResponse,
  type ModelPrice,
  RawCredentialDocumentSchema,
  type SchedulerSettings,
  type SchedulerStatus,
} from "./lib/schemas";
import {
  DEFAULT_GATEWAY_URL,
  getGatewayBaseUrl,
  getLegacyRelayKey,
  getQuotaShowRemaining,
  getTheme,
  setTheme as persistTheme,
  removeLegacyRelayKey,
  setGatewayBaseUrl,
  setQuotaShowRemaining,
  validateGatewayBaseUrl,
} from "./lib/storage";

type Surface = "overview" | "accounts" | "agents" | "logs" | "settings" | "notch" | "tray";
const getInitialSurface = (): Surface => {
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("surface");
    if (param === "notch") return "notch";
    if (param === "tray") return "tray";
    if (
      param === "accounts" ||
      param === "agents" ||
      param === "logs" ||
      param === "settings" ||
      param === "overview"
    ) {
      return param;
    }
  }
  return "overview";
};

type AuthorizationSession = {
  readonly provider: string;
  readonly state: string;
  readonly status: ProviderAuthStatus["status"];
  readonly error?: string;
};

const actionFailed = (reason: unknown): string =>
  `Action failed: ${reason instanceof Error ? reason.message : "unknown error"}`;

export default function App() {
  const [surface, setSurface] = useState<Surface>(getInitialSurface);
  const { menu, openMenu, closeMenu } = useContextMenu();

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (wantsNativeMenu(event.target)) {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  const [theme, setTheme] = useState(getTheme);
  const [baseUrl, setBaseUrlState] = useState(getGatewayBaseUrl);
  // The Gateway URL input edits `baseUrl` per keystroke; secret work must key
  // off the value the operator actually committed with Save & reconnect.
  const [committedBaseUrl, setCommittedBaseUrl] = useState(getGatewayBaseUrl);
  const [relayKey, setRelayKeyState] = useState(() => getLegacyRelayKey() ?? "");
  const [secretResolved, setSecretResolved] = useState(() => Boolean(getLegacyRelayKey()));
  const [secretStoreError, setSecretStoreError] = useState<SecretStoreError | null>(null);
  const [secretRetry, setSecretRetry] = useState(0);
  const [showRemaining, setShowRemainingState] = useState(getQuotaShowRemaining());

  const setShowRemaining = useCallback((value: boolean) => {
    setQuotaShowRemaining(value);
    setShowRemainingState(value);
    const api = (
      window as {
        __TAURI__?: { event?: { emit: (event: string, payload: unknown) => void } };
      }
    ).__TAURI__;
    api?.event?.emit("mahoquot-quota-mode", value);
  }, []);
  const [provider, setProvider] = useState(
    () => window.sessionStorage.getItem("mahoquot.provider") ?? "all",
  );
  const { toasts, pushToast, dismissToast } = useToasts();
  const setNotice = useCallback((message: string) => pushToast(message), [pushToast]);
  const [pending, setPending] = useState("");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  const [step, setStep] = useState<OnboardingStep>(ACCOUNT_KIND_STEP);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [onboardingScope, setOnboardingScope] = useState<OnboardingScope>("api");
  const [dragging, setDragging] = useState("");
  const [gatewayUrlError, setGatewayUrlError] = useState<string | null>(null);
  const [configYaml, setConfigYaml] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [scopedKeys, setScopedKeys] = useState<readonly ScopedApiKey[]>([]);
  const [authorization, setAuthorization] = useState<AuthorizationSession | null>(null);
  const [zcodeCallbackUrl, setZcodeCallbackUrl] = useState("");
  const [cliAgents, setCliAgents] = useState<CliAgentStatus[]>([]);
  const [busyAgent, setBusyAgent] = useState<CliAgentId | null>(null);
  const [agentPreview, setAgentPreview] = useState<CliConfigPreview | null>(null);
  const [codexInstances, setCodexInstances] = useState<CodexInstance[]>([]);
  const [codexBusy, setCodexBusy] = useState(false);
  const [historyStats, setHistoryStats] = useState<HistoryStatsResponse | null>(null);
  const [liveLogTick, setLiveLogTick] = useState(0);
  const [historyHealth, setHistoryHealth] = useState<HistoryHealth | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [schedulerSettings, setSchedulerSettings] = useState<SchedulerSettings | null>(null);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [schedulerError, setSchedulerError] = useState("");
  const [schedulerPending, setSchedulerPending] = useState(false);
  const [modelPrices, setModelPrices] = useState<readonly ModelPrice[]>([]);
  const [tunnelStatus, setTunnelStatus] = useState({
    enabled: false,
    running: false,
    public_url: null as string | null,
    has_binary: false,
  });
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [nativeSettings, setNativeSettings] = useState<NativeSettingsState | null>(null);
  const [nativeSettingsBusy, setNativeSettingsBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const totp = useTotpVault(committedBaseUrl || DEFAULT_GATEWAY_URL);

  const reloadCliAgents = useCallback(async () => {
    const agents = await listCliAgents();
    setCliAgents(Array.isArray(agents) ? agents : []);
    return agents;
  }, []);

  useEffect(() => {
    if (surface !== "agents" && surface !== "settings") return;
    void Promise.all([reloadCliAgents(), listCodexInstances().then(setCodexInstances)]).catch(
      (error: unknown) => setNotice(actionFailed(error)),
    );
  }, [reloadCliAgents, setNotice, surface]);

  const launchCodex = useCallback(
    async (request: CodexLaunchRequest) => {
      setCodexBusy(true);
      try {
        await launchCodexInstance(request);
        setCodexInstances(await listCodexInstances());
        setNotice(`Codex instance ${request.instance_id} launched.`);
      } catch (error) {
        setNotice(actionFailed(error));
      } finally {
        setCodexBusy(false);
      }
    },
    [setNotice],
  );

  const stopCodex = useCallback(
    async (instanceId: string) => {
      setCodexBusy(true);
      try {
        setCodexInstances(await stopCodexInstance(instanceId));
        setNotice(`Codex instance ${instanceId} stopped.`);
      } catch (error) {
        setNotice(actionFailed(error));
      } finally {
        setCodexBusy(false);
      }
    },
    [setNotice],
  );

  const restoreAgent = useCallback(
    async (agentId: CliAgentId) => {
      setBusyAgent(agentId);
      try {
        const result = await restoreCliAgent(agentId);
        setNotice(
          result.outcome === "conflict"
            ? "Restore conflict — newer file preserved."
            : `${result.state.display_name} restored.`,
        );
        await reloadCliAgents();
      } catch (error) {
        setNotice(actionFailed(error));
      } finally {
        setBusyAgent(null);
      }
    },
    [reloadCliAgents, setNotice],
  );

  useEffect(() => {
    if (!onboardingOpen && !configOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (onboardingOpen) setOnboardingOpen(false);
      if (configOpen) setConfigOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onboardingOpen, configOpen]);

  const clients = useMemo(
    () => createGatewayClients(committedBaseUrl || DEFAULT_GATEWAY_URL, relayKey),
    [committedBaseUrl, relayKey],
  );

  const reloadScopedKeys = useCallback(async () => {
    try {
      const keys = await clients.management.scopedKeys();
      setScopedKeys(keys);
    } catch {
      // Ignored when offline or non-responsive
    }
  }, [clients]);

  useEffect(() => {
    void reloadScopedKeys();
  }, [reloadScopedKeys]);

  const queryHistory = useCallback(
    async (query: HistoryStatsQuery = {}) => {
      setHistoryError("");
      try {
        const [nextStats, nextHealth] = await Promise.all([
          clients.management.historyStats(query),
          clients.management.historyHealth(),
        ]);
        setHistoryStats(nextStats);
        setHistoryHealth(nextHealth);
      } catch (error) {
        setHistoryStats(null);
        setHistoryHealth(null);
        const message = error instanceof Error ? error.message : "Request history unavailable";
        setHistoryError(
          message.includes("request history worker is unavailable")
            ? "request history worker is unavailable"
            : message,
        );
      }
    },
    [clients],
  );

  useEffect(() => {
    if (surface !== "logs" && surface !== "settings") return;
    void queryHistory();
  }, [queryHistory, surface]);

  // The gateway streams every new log line; the Logs surface consumes the tick
  // instead of polling. Only subscribe while that surface is mounted.
  useEffect(() => {
    if (surface !== "logs") return;
    return clients.management.subscribeLogs((record) => {
      if (record.kind === "request") setLiveLogTick((tick) => tick + 1);
    });
  }, [clients, surface]);

  const clearHistory = useCallback(
    async (query: HistoryStatsQuery) => clients.management.clearHistory(query),
    [clients],
  );

  useEffect(() => {
    if (surface !== "settings") return;
    setSchedulerError("");
    void Promise.all([clients.management.schedulerSettings(), clients.management.schedulerStatus()])
      .then(([settings, status]) => {
        setSchedulerSettings(settings);
        setSchedulerStatus(status);
      })
      .catch((error: unknown) => {
        setSchedulerError(error instanceof Error ? error.message : "scheduler unavailable");
      });
  }, [clients, surface]);

  useEffect(() => {
    if (surface !== "settings") return;
    void clients.management
      .modelPrices()
      .then(setModelPrices)
      .catch((error: unknown) => setNotice(actionFailed(error)));
  }, [clients, setNotice, surface]);

  const saveSchedulerSettings = async (patch: Partial<SchedulerSettings>) => {
    setSchedulerPending(true);
    try {
      const status = await clients.management.saveSchedulerSettings(patch);
      setSchedulerSettings((current) => (current ? { ...current, ...patch } : current));
      setSchedulerStatus(status);
      setNotice("Scheduler settings saved.");
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setSchedulerPending(false);
    }
  };

  const saveSchedulerOrder = async (order: readonly string[]) => {
    setSchedulerPending(true);
    try {
      const saved = await clients.management.saveSchedulerOrder(order);
      setSchedulerStatus((current) => (current ? { ...current, order: [...saved] } : current));
      setNotice("Scheduler order saved.");
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setSchedulerPending(false);
    }
  };

  const saveModelPrice = async (price: ModelPrice) => {
    if (
      price["input-per-million"] < 0 ||
      price["output-per-million"] < 0 ||
      price["cached-input-per-million"] < 0
    ) {
      setNotice("Action failed: model prices must be non-negative.");
      return;
    }
    try {
      const saved = await clients.management.saveModelPrice(price);
      setModelPrices((current) =>
        current.map((item) => (item.model === saved.model ? saved : item)),
      );
      setNotice("Model price saved.");
    } catch (error) {
      setNotice(actionFailed(error));
    }
  };

  const {
    stats,
    credentials,
    logs,
    loadState,
    fetchedAt,
    refreshing,
    gatewayLifecycle,
    setGatewayLifecycle,
    telemetry,
    schemaMismatch,
    credentialsError,
    modelRegistryStatus,
    modelRegistryError,
    gatewayModels,
    refresh,
    refreshUsage,
    refreshNow,
    setCredentials,
    setLoadState,
  } = useGatewayPolling(clients);

  const agentRequest = useCallback(
    (agentId: CliAgentId) => ({
      agent_id: agentId,
      gateway_url: committedBaseUrl || DEFAULT_GATEWAY_URL,
      models: gatewayModels.map((model) => model.id),
    }),
    [committedBaseUrl, gatewayModels],
  );

  const previewAgent = useCallback(
    async (agentId: CliAgentId) => {
      setBusyAgent(agentId);
      try {
        setAgentPreview(await previewCliAgent(agentRequest(agentId)));
      } catch (error) {
        setAgentPreview(null);
        setNotice(actionFailed(error));
      } finally {
        setBusyAgent(null);
      }
    },
    [agentRequest, setNotice],
  );

  const applyAgent = useCallback(
    async (agentId: CliAgentId, adoptCurrent: boolean) => {
      setBusyAgent(agentId);
      try {
        const result = await configureCliAgent({
          ...agentRequest(agentId),
          adopt_current: adoptCurrent,
        });
        setNotice(
          result.outcome === "conflict"
            ? "Configuration conflict — file left unchanged."
            : `${result.state.display_name} configured.`,
        );
        setAgentPreview(null);
        await reloadCliAgents();
      } catch (error) {
        setNotice(actionFailed(error));
      } finally {
        setBusyAgent(null);
      }
    },
    [agentRequest, reloadCliAgents, setNotice],
  );

  const refreshModelRegistry = useCallback(async () => {
    setPending(pendingKey.auth("registry:refresh"));
    try {
      await clients.management.refreshModelRegistry();
      await refresh();
      setNotice("Model registry catalog refreshed.");
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  }, [clients, refresh, setNotice]);

  const {
    proxyUrl,
    setProxyUrl,
    routingStrategy,
    setRoutingStrategy,
    requestRetry,
    setRequestRetry,
    loggingToFile,
    setLoggingToFile,
    setSettingsLoaded,
    saveProxySettings,
  } = useConnectionSettings({ clients, loadState, surface, setNotice, setPending });

  const resetOnboarding = useCallback(() => {
    setProviderSearch("");
    setStep(ACCOUNT_KIND_STEP);
    setAuthorization(null);
  }, []);

  const openOnboarding = useCallback(() => {
    resetOnboarding();
    setOnboardingOpen(true);
  }, [resetOnboarding]);

  const finishOnboarding = useCallback(
    (providerId: string) => {
      setProvider(providerId);
      setOnboardingOpen(false);
      resetOnboarding();
    },
    [resetOnboarding],
  );

  useEffect(() => {
    void getGatewayLifecycle().then(setGatewayLifecycle);
  }, [setGatewayLifecycle]);

  useEffect(() => {
    if (surface !== "settings") return;
    void Promise.all([
      getTunnelStatus().then(setTunnelStatus),
      getNativeSettings().then(setNativeSettings),
    ]).catch((error: unknown) => setNotice(actionFailed(error)));
  }, [setNotice, surface]);

  useEffect(() => {
    // The notch and tray are secondary webviews that never own onboarding, so
    // they read the stored management key instead of running the console's
    // one-time legacy migration. Without it every gateway call 401s and the
    // notch renders its empty ring even though accounts exist.
    if (surface !== "notch" && surface !== "tray") return;
    let active = true;
    void readDesktopSecret(committedBaseUrl || DEFAULT_GATEWAY_URL, "default", "management_key")
      .then((value) => {
        if (active) {
          setRelayKeyState(value ?? "");
          setSecretResolved(true);
        }
      })
      .catch(() => {
        // These surfaces have no settings UI to recover in; the console owns
        // surfacing secret-store failures.
        if (active) setSecretResolved(true);
      });
    return () => {
      active = false;
    };
  }, [committedBaseUrl, surface]);

  useEffect(() => {
    if (surface === "notch" || surface === "tray") return;
    void secretRetry;
    let active = true;
    const legacyValue = getLegacyRelayKey();
    void migrateLegacyDesktopSecret(
      committedBaseUrl || DEFAULT_GATEWAY_URL,
      "default",
      "management_key",
      legacyValue,
    )
      .then((outcome) => {
        if (!active) return;
        if (outcome.remove_legacy) removeLegacyRelayKey();
        setRelayKeyState(outcome.value ?? "");
        setSecretStoreError(null);
        setSecretResolved(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const typed =
          error instanceof SecretStoreError
            ? error
            : new SecretStoreError({ kind: "backend", detail: String(error) });
        setSecretStoreError(typed);
        setNotice(typed.message);
        setSecretResolved(true);
      });
    return () => {
      active = false;
    };
  }, [committedBaseUrl, secretRetry, setNotice, surface]);

  useEffect(() => {
    // the quota display mode is flipped in the console settings; the tray and
    // notch windows live in separate webviews and only hear about it via events
    const api = (
      window as {
        __TAURI__?: {
          event?: {
            listen: (
              event: string,
              handler: (message: { payload: unknown }) => void,
            ) => Promise<() => void>;
          };
        };
      }
    ).__TAURI__;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void api?.event
      ?.listen("mahoquot-quota-mode", (message: { payload: unknown }) => {
        setShowRemainingState(Boolean(message.payload));
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (surface === "notch" || surface === "tray") {
      document.documentElement.dataset.surface = surface;
      return () => {
        delete document.documentElement.dataset.surface;
      };
    }
  }, [surface]);

  useEffect(() => {
    window.sessionStorage.setItem("mahoquot.provider", provider);
  }, [provider]);

  const accounts = useMemo(
    () => mergeAccountsAndCredentials(stats.accounts, credentials),
    [stats, credentials],
  );
  const providers = useMemo(
    () => [...new Set(accounts.map((account) => account.provider))].sort(),
    [accounts],
  );
  const selectedProvider = providers.includes(provider) ? provider : providers[0];
  const visibleAccounts = accounts.filter((account) => account.provider === selectedProvider);

  const runAccountAction = async (action: "warm" | "reset", account: NormalizedAccount) => {
    if (!account.runtimeId) return;
    setPending(pendingKey.account(action, account.id));
    setNotice("");
    try {
      if (action === "warm") {
        await clients.admin.warm(account.runtimeId);
        setNotice("Warm-up requested — active now.");
      } else {
        await clients.admin.reset(account.runtimeId);
        setNotice(`Window reset for ${account.label} — refreshed quota active.`);
      }
      await refresh();
      await refreshUsage();
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const removeCredential = async (account: NormalizedAccount) => {
    if (!account.credentialName) return;
    setPending(pendingKey.remove(account.id));
    setNotice("");
    try {
      await clients.management.removeCredential(account.credentialName);
      setNotice("Credential removed from the runtime pool.");
      await refresh();
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
      setConfirmRemove("");
    }
  };

  const setCredentialDisabled = async (account: NormalizedAccount, disabled: boolean) => {
    if (!account.credentialName) return;
    setPending(pendingKey.status(account.id));
    try {
      await clients.management.setCredentialDisabled(account.credentialName, disabled);
      setCredentials((current) =>
        current.map((credential) =>
          credential.name === account.credentialName ? { ...credential, disabled } : credential,
        ),
      );
      if (!disabled) {
        await refreshUsage(true);
      }
      await refresh();
      setNotice(`${account.label} ${disabled ? "disabled" : "enabled"}.`);
    } catch (reason) {
      setNotice(actionFailed(reason));
    } finally {
      setPending("");
    }
  };

  const handleAccountRefresh = useCallback(async () => {
    await refreshUsage(true);
    await refresh();
  }, [refreshUsage, refresh]);

  const moveCredential = async (account: NormalizedAccount, direction: -1 | 1) => {
    if (!account.credentialName) return;
    const names = credentials.map((credential) => credential.name);
    const index = names.indexOf(account.credentialName);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= names.length) return;
    [names[index], names[nextIndex]] = [names[nextIndex] as string, names[index] as string];
    await applyCredentialOrder(names, account.id);
  };

  const dropCredentialOn = async (target: NormalizedAccount) => {
    const source = dragging;
    setDragging("");
    if (!source || !target.credentialName || source === target.credentialName) return;
    const names = credentials.map((credential) => credential.name);
    const from = names.indexOf(source);
    const to = names.indexOf(target.credentialName);
    if (from < 0 || to < 0) return;
    names.splice(to, 0, ...names.splice(from, 1));
    await applyCredentialOrder(names, target.id);
  };

  const applyCredentialOrder = async (names: readonly string[], accountId: string) => {
    setPending(pendingKey.order(accountId));
    setNotice("");
    try {
      const saved = await clients.management.saveCredentialOrder(names);
      // Re-sync from the server's saved order: a render-stale capture or an
      // interleaved poll must not be able to resurrect a reverted order.
      const order = saved.length ? saved : names;
      setCredentials((prev) =>
        [...prev].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)),
      );
      setNotice("Account priority saved. Top accounts are used first in Fill-first routing.");
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const beginOnboarding = async (methodId: string) => {
    setPending(pendingKey.auth(methodId));
    setNotice("");
    try {
      const localImport = LOCAL_IMPORT_METHODS[methodId];
      if (localImport) {
        await clients.management.importLocalTrae();
        setNotice(localImport.notice);
        finishOnboarding(localImport.provider);
        await refreshUsage(true);
        await refresh();
        return;
      }
      const form = formStepFor(methodId);
      if (form) {
        setStep(form);
        return;
      }
      if (methodId === "custom-endpoint") {
        setStep({
          kind: "generic",
          provider: {
            id: "custom",
            label: "Custom API",
            authKind: "key",
            adapter: "openai-chat",
            baseUrl: "",
            models: [],
          },
          label: "Custom API",
          apiKey: "",
          baseUrl: "",
          plan: "",
        });
        return;
      }
      if (methodId.startsWith("generic:")) {
        const providerId = methodId.slice("generic:".length);
        const preset = GENERIC_PROVIDER_OPTIONS.find((provider) => provider.id === providerId);
        if (!preset) throw new Error(`Unknown provider preset: ${providerId}`);
        setStep({
          kind: "generic",
          provider: preset,
          label: preset.label,
          apiKey: "",
          baseUrl: preset.baseUrl,
          plan: "",
        });
        return;
      }
      const auth = await clients.management.beginProviderAuth(methodId);
      const refreshOnFocus = () => {
        window.removeEventListener("focus", refreshOnFocus);
        void refresh();
      };
      window.addEventListener("focus", refreshOnFocus, { once: true });
      await openExternalUrl(auth.url);
      setAuthorization({ provider: methodId, state: auth.state, status: "pending" });
      setNotice("Authorization pending. Approve in the provider window; this updates itself.");
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const submitRawCredential = async () => {
    if (step.kind !== "raw-credential") return;
    const form = step;
    setPending(pendingKey.auth(form.provider));
    try {
      if (form.provider === "vertex") {
        await clients.management.importVertexServiceAccount(form.document);
      } else {
        const parsed = RawCredentialDocumentSchema.safeParse(JSON.parse(form.document) as unknown);
        if (!parsed.success) {
          throw new Error("credential document must be a non-empty JSON object");
        }
        await clients.management.importCredential(`kiro-import-${Date.now()}.json`, {
          ...parsed.data,
          type: "kiro",
        });
      }
      finishOnboarding(form.provider);
      setNotice("Credential imported and live in the runtime pool.");
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const submitKeyImport = async () => {
    if (step.kind !== "key-import") return;
    const form = step;
    setPending(pendingKey.auth(form.provider));
    try {
      if (form.provider === "command-code") {
        await clients.management.importCommandCode(form.apiKey.trim(), form.label.trim());
      } else {
        await clients.management.createGenericCredential({
          provider: "iflow",
          label: form.label.trim(),
          adapter: "openai-chat",
          baseUrl: "https://api.iflow.cn/v1",
          apiKey: form.apiKey.trim(),
          models: ["iflow-rome", "iflow-milan"],
        });
      }
      finishOnboarding(form.provider);
      setNotice(`${form.label} account saved and live in the runtime pool.`);
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const handleDiscoverModels = async () => {
    if (step.kind !== "generic") return;
    setDiscoveringModels(true);
    try {
      const discovered = await discoverProviderModels(
        step.baseUrl.trim(),
        step.apiKey.trim() || undefined,
        step.provider.staticHeaders,
      );
      setStep((current) => {
        if (current.kind !== "generic") return current;
        return {
          ...current,
          provider: {
            ...current.provider,
            models: discovered,
          },
        };
      });
      setNotice(`Discovered ${discovered.length} models from provider endpoint.`);
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setDiscoveringModels(false);
    }
  };

  const submitGenericCredential = async () => {
    if (step.kind !== "generic") return;
    const form = step;
    setPending(pendingKey.auth(`generic:${form.provider.id}`));
    setNotice("");
    try {
      const label = form.label.trim() || form.provider.label;
      const baseUrl = form.baseUrl.trim();
      if (isRelayTarget(baseUrl)) {
        // Hidden relay path: the nekos/ccapi usage poller only recognizes
        // claude-type credentials, so the relay doc bypasses the generic shape.
        const doc = buildRelayCredential({
          label,
          apiKey: form.apiKey.trim(),
          baseUrl,
          plan: form.plan,
        });
        await clients.management.importCredential(doc.name, doc.content);
        setNotice(`${label} relay account saved and live in the runtime pool.`);
      } else {
        await clients.management.createGenericCredential({
          provider: form.provider.id,
          label,
          adapter: form.provider.adapter,
          baseUrl,
          apiKey: form.apiKey.trim(),
          models: form.provider.models,
          ...(form.provider.staticHeaders ? { staticHeaders: form.provider.staticHeaders } : {}),
        });
        setNotice(`${form.provider.label} account saved and live in the runtime pool.`);
      }
      finishOnboarding(form.provider.id);
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const submitZcodeKey = async () => {
    if (step.kind !== "zcode-key") return;
    const form = step;
    setPending(pendingKey.auth("zcode-key"));
    setNotice("");
    try {
      await clients.management.createZcodeCredential(form.email.trim(), form.key.trim());
      setNotice("Z.ai key saved and live in the runtime pool.");
      finishOnboarding("zcode");
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const submitZcodeCallback = async () => {
    if (!authorization) return;
    const callbackUrl = zcodeCallbackUrl.trim();
    if (!callbackUrl) return;
    setPending(pendingKey.auth("zcode-callback"));
    setNotice("");
    try {
      await clients.management.completeZcodeAuth(authorization.state, callbackUrl);
      setAuthorization({ ...authorization, status: "ok" });
      setZcodeCallbackUrl("");
      setNotice("ZCode authorization completed.");
      finishOnboarding("zcode");
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const reauthenticate = async (account: NormalizedAccount) => {
    const dedicated = ONBOARDING_PROVIDERS.find((provider) => provider.glyph === account.provider);
    setStep(dedicated ? { kind: "methods", provider: dedicated } : PROVIDER_STEP);
    setOnboardingOpen(true);
    await beginOnboarding(dedicated ? account.provider : `generic:${account.provider}`);
  };

  /**
   * The single place an authorization outcome is applied. The 3s poller and
   * the manual "Check authorization status" button both route through it, so
   * a completion can never be handled twice with two slightly different
   * success paths.
   */
  const settleAuthorization = useCallback(
    async (session: AuthorizationSession, result: ProviderAuthStatus): Promise<void> => {
      setAuthorization({
        provider: session.provider,
        state: session.state,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
      if (result.status === "ok") {
        setNotice(`${providerLabel(session.provider)} authorization completed.`);
        finishOnboarding(session.provider);
        await refreshUsage(true);
        await refresh();
      } else if (result.status === "error") {
        setNotice(`Action failed: ${result.error ?? "authorization failed"}`);
      }
    },
    [finishOnboarding, refresh, refreshUsage, setNotice],
  );

  // Approval happens in a separate browser window the console cannot observe,
  // so the session polls itself instead of stranding the user on "Pending".
  const authPending = authorization?.status === "pending";
  const authProvider = authorization?.provider ?? "";
  const authState = authorization?.state ?? "";
  useEffect(() => {
    if (!authPending) return;
    const session = { provider: authProvider, state: authState, status: "pending" } as const;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await clients.management.providerAuthStatus(session.state);
        if (cancelled || result.status === "pending") return;
        await settleAuthorization(session, result);
      } catch {
        // A transient failure while the provider window is still open is not
        // an authorization outcome; the next tick retries.
      }
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authPending, authProvider, authState, clients, settleAuthorization]);

  const checkAuthorization = async () => {
    if (!authorization) return;
    const session = authorization;
    setPending(pendingKey.authStatus(session.provider));
    try {
      const result = await clients.management.providerAuthStatus(session.state);
      await settleAuthorization(session, result);
      if (result.status === "pending") {
        setNotice("Authorization still pending. Approve in the provider window.");
      }
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const toggleGateway = async () => {
    setPending(pendingKey.gateway);
    setNotice("");
    try {
      const next =
        gatewayLifecycle === "running" ? await stopManagedGateway() : await startManagedGateway();
      setGatewayLifecycle(next);
      setLoadState(next === "running" ? "starting" : "stopped");
      if (next === "running") {
        await refresh();
      }
    } catch (error) {
      setNotice(
        `Action failed: ${error instanceof Error ? error.message : "gateway control failed"}`,
      );
    } finally {
      setPending("");
    }
  };

  const changeLoginStart = async (enabled: boolean): Promise<void> => {
    setNativeSettingsBusy(true);
    try {
      setNativeSettings(await setLoginStart(enabled));
      setNotice(enabled ? "Mahoquot will start at login." : "Login startup disabled.");
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setNativeSettingsBusy(false);
    }
  };

  const enableNativeNotifications = async (): Promise<void> => {
    setNativeSettingsBusy(true);
    try {
      const next = await requestNativeNotificationPermission();
      setNativeSettings(next);
      setNotice(
        next.notifications === "available"
          ? "Native notifications enabled."
          : (next.action ?? "Native notifications remain unavailable."),
      );
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setNativeSettingsBusy(false);
    }
  };

  const runTunnelAction = async (action: "download" | "enable" | "disable"): Promise<void> => {
    setTunnelBusy(true);
    try {
      const next =
        action === "download"
          ? await downloadCloudflared()
          : action === "enable"
            ? await startTunnel()
            : await stopTunnel();
      setTunnelStatus(next);
      setNotice(
        action === "download"
          ? "Verified cloudflared downloaded. Public tunnel remains disabled."
          : action === "enable"
            ? `Public tunnel enabled${next.public_url ? `: ${next.public_url}` : "."}`
            : "Public tunnel disabled and cloudflared stopped.",
      );
    } catch (error) {
      setTunnelStatus((current) => ({
        ...current,
        enabled: false,
        running: false,
        public_url: null,
      }));
      setNotice(actionFailed(error));
    } finally {
      setTunnelBusy(false);
    }
  };

  const openConfigEditor = async () => {
    setNotice("");
    setPending(pendingKey.configLoad);
    try {
      setConfigYaml(await clients.management.configYaml());
      setConfigOpen(true);
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  const saveConfig = async () => {
    setPending(pendingKey.configSave);
    setNotice("");
    try {
      await clients.management.saveConfigYaml(configYaml);
      setNotice("Configuration saved and applied.");
      setConfigOpen(false);
    } catch (error) {
      setNotice(actionFailed(error));
    } finally {
      setPending("");
    }
  };

  if (surface === "notch") {
    return (
      <NotchSurface
        accounts={accounts}
        loadState={loadState}
        showRemaining={showRemaining}
        totpEntries={totp.entries}
        totpCodes={totp.codes}
        totpRemaining={totp.remaining}
        onCopyTotpCode={totp.copyCode}
      />
    );
  }
  if (surface === "tray") {
    const api = (
      window as {
        __TAURI__?: {
          core?: { invoke: (command: string) => Promise<unknown> };
        };
      }
    ).__TAURI__;
    return (
      <TrayPanel
        accounts={accounts}
        proxyUrl={committedBaseUrl || "Same-origin gateway"}
        online={loadState === "online"}
        gatewayLifecycle={gatewayLifecycle}
        refreshing={refreshing}
        showRemaining={showRemaining}
        fetchedAgoSecs={fetchedAt === null ? null : Math.round((Date.now() - fetchedAt) / 1000)}
        onRefresh={() => void refreshNow()}
        onOpenConsole={() => void api?.core?.invoke("open_console")}
        onQuit={() => void api?.core?.invoke("quit_app")}
        onStartGateway={() => void api?.core?.invoke("start_gateway")}
        onStopGateway={() => void api?.core?.invoke("stop_gateway")}
        totpEntries={totp.entries}
        totpCodes={totp.codes}
        totpRemaining={totp.remaining}
        onCopyTotpCode={totp.copyCode}
      />
    );
  }

  return (
    <AppShell className="app" data-mahoquot-app="operations-console">
      {schemaMismatch && (
        <div role="alert" className="schema-banner" data-testid="schema-banner">
          {schemaMismatch}
        </div>
      )}
      <aside className="sidebar">
        <div className="titlebar-drag" data-tauri-drag-region />
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark">Q</span>
          <div>
            <strong>Mahoquot</strong>
            <small>Operations console</small>
          </div>
        </div>
        <nav aria-label="Primary navigation">
          {(
            [
              ["overview", CircleGauge, "Overview"],
              ["accounts", Users, "Accounts"],
              ["logs", TerminalSquare, "Logs"],
              ["settings", Settings2, "Settings"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              type="button"
              key={id}
              className={surface === id ? "nav-item active" : "nav-item"}
              onClick={() => setSurface(id)}
            >
              <Icon size={17} />
              {label}
              <ChevronRight size={14} />
            </button>
          ))}
        </nav>
      </aside>

      <main>
        <header className="topbar" data-tauri-drag-region>
          <h1 data-tauri-drag-region>{surface.charAt(0).toUpperCase() + surface.slice(1)}</h1>
          {surface === "accounts" ? (
            <div className="top-actions">
              <Button
                aria-label="Refresh snapshot"
                disabled={refreshing}
                onClick={() => {
                  void refreshNow();
                  void refreshUsage(true);
                }}
              >
                <RefreshCw size={15} className={refreshing ? "spin" : ""} /> Refresh
              </Button>
              <Button aria-label="Add account" onClick={() => void openOnboarding()}>
                <Plus size={16} />
              </Button>
            </div>
          ) : null}
        </header>

        <div className="mobile-nav" aria-label="Mobile navigation">
          {(["overview", "accounts", "logs", "settings"] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={surface === item ? "active" : ""}
              onClick={() => setSurface(item)}
            >
              {item}
            </button>
          ))}
        </div>

        {loadState === "relay-locked" && secretResolved ? (
          <div className="state-panel warning">
            <KeyRound /> API key required to load gateway telemetry and management data.
          </div>
        ) : null}

        {surface === "overview" ? <OverviewDashboard stats={stats} samples={telemetry} /> : null}

        {surface === "accounts" ? (
          <AccountsSurface
            accounts={accounts}
            providers={providers}
            selectedProvider={selectedProvider}
            visibleAccounts={visibleAccounts}
            showRemaining={showRemaining}
            pending={pending}
            credentialsError={credentialsError}
            dragging={dragging}
            confirmRemove={confirmRemove}
            onSelectProvider={setProvider}
            onRunAccountAction={runAccountAction}
            onRefresh={handleAccountRefresh}
            onSetCredentialDisabled={setCredentialDisabled}
            onReauthenticate={reauthenticate}
            onRemoveCredential={removeCredential}
            onSetConfirmRemove={setConfirmRemove}
            onMoveCredential={moveCredential}
            onDropCredential={dropCredentialOn}
            onSetDragging={setDragging}
            onContextMenu={(event, account) => openMenu(event, accountMenuItems(account))}
          />
        ) : null}

        {surface === "logs" ? (
          <div className="content logs-surface">
            <DurableLogs
              records={logs}
              fromMemoryTail={!loggingToFile}
              loadHistory={clients.management.historyEvents}
              loadHistoryDetail={clients.management.historyEvent}
              liveTick={liveLogTick}
            />
          </div>
        ) : null}

        {surface === "settings" ? (
          <div className="content settings-surface">
            <SettingsSurface
              agentsSlot={
                <AgentsSurface
                  agents={cliAgents}
                  busyAgent={busyAgent}
                  pendingPreview={agentPreview}
                  onPreview={previewAgent}
                  onApply={applyAgent}
                  onCancelPreview={() => setAgentPreview(null)}
                  onRestore={restoreAgent}
                  codexAccounts={accounts
                    .filter((account) => account.provider === "codex")
                    .map((account) => ({ id: account.id, label: account.label }))}
                  codexInstances={codexInstances}
                  codexBusy={codexBusy}
                  runtimeModels={gatewayModels.map((m) => m.id)}
                  onLaunchCodex={launchCodex}
                  onStopCodex={stopCodex}
                />
              }
              totpVaultSlot={
                <TotpVaultSurface
                  entries={totp.entries}
                  codes={totp.codes}
                  remaining={totp.remaining}
                  error={totp.error}
                  onAdd={totp.add}
                  onEdit={totp.edit}
                  onRemove={totp.remove}
                  onImport={totp.importEntries}
                  onRetry={totp.reload}
                  onCopyCode={totp.copyCode}
                />
              }
              gatewayLifecycle={gatewayLifecycle}
              pending={pending}
              loadState={loadState}
              baseUrl={baseUrl}
              gatewayUrlError={gatewayUrlError}
              relayKey={relayKey}
              scopedKeys={scopedKeys}
              availableModels={gatewayModels}
              availableAccounts={accounts.map((a) => ({ id: a.id, provider: a.provider }))}
              onCreateScopedKey={async (payload) => {
                const res = await clients.management.createScopedKey(payload);
                await reloadScopedKeys();
                return res;
              }}
              onPatchScopedKey={async (id, payload) => {
                await clients.management.patchScopedKey(id, payload);
                await reloadScopedKeys();
              }}
              onDeleteScopedKey={async (id) => {
                await clients.management.deleteScopedKey(id);
                await reloadScopedKeys();
              }}
              onRefreshScopedKeys={reloadScopedKeys}
              routingStrategy={routingStrategy}
              requestRetry={requestRetry}
              proxyUrl={proxyUrl}
              loggingToFile={loggingToFile}
              theme={theme}
              showRemaining={showRemaining}
              onShowRemainingChange={setShowRemaining}
              onToggleGateway={toggleGateway}
              nativeSettings={nativeSettings}
              nativeSettingsBusy={nativeSettingsBusy}
              updateStatus={updateStatus}
              updateBusy={updateBusy}
              onCheckUpdate={() => {
                setUpdateBusy(true);
                void checkForUpdate()
                  .then(setUpdateStatus)
                  .catch((error) => setNotice(actionFailed(error)))
                  .finally(() => setUpdateBusy(false));
              }}
              onInstallUpdate={() => {
                setUpdateBusy(true);
                void installUpdate().catch((error) => {
                  setNotice(actionFailed(error));
                  setUpdateBusy(false);
                });
              }}
              onLoginStartChange={changeLoginStart}
              onRequestNotificationPermission={enableNativeNotifications}
              onBaseUrlChange={(val) => {
                setBaseUrlState(val);
                setGatewayUrlError(null);
              }}
              secretStoreError={secretStoreError}
              onRetrySecretStore={() => setSecretRetry((value) => value + 1)}
              onRelayKeyChange={(value) => {
                setRelayKeyState(value);
                setSecretStoreError(null);
              }}
              onRelayKeyBlur={() => {
                void writeDesktopSecret(
                  committedBaseUrl || DEFAULT_GATEWAY_URL,
                  "default",
                  "management_key",
                  relayKey.trim(),
                )
                  .then(() => setSecretStoreError(null))
                  .catch((error: unknown) => {
                    const typed =
                      error instanceof SecretStoreError
                        ? error
                        : new SecretStoreError({ kind: "backend", detail: String(error) });
                    setSecretStoreError(typed);
                    setNotice(typed.message);
                  });
              }}
              onCopyRelayKey={() => {
                void navigator.clipboard
                  .writeText(relayKey)
                  .then(() => setNotice("API key copied."))
                  .catch(() => setNotice("Action failed: clipboard unavailable"));
              }}
              onSaveConnection={() => {
                const error = validateGatewayBaseUrl(baseUrl);
                setGatewayUrlError(error);
                if (error) {
                  setNotice(error);
                  return;
                }
                const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
                setGatewayBaseUrl(baseUrl);
                setBaseUrlState(normalizedBase);
                setCommittedBaseUrl(normalizedBase);
                void writeDesktopSecret(
                  normalizedBase,
                  "default",
                  "management_key",
                  relayKey.trim(),
                )
                  .then(() => {
                    setSecretStoreError(null);
                    // The saved scalars belong to the previous instance; force the
                    // settings surface to reload them from the new connection.
                    setSettingsLoaded(false);
                  })
                  .catch((reason: unknown) => {
                    const typed =
                      reason instanceof SecretStoreError
                        ? reason
                        : new SecretStoreError({ kind: "backend", detail: String(reason) });
                    setSecretStoreError(typed);
                    setNotice(typed.message);
                  });
                setNotice("Connection saved — active now for this console.");
                void refresh();
              }}
              onRoutingStrategyChange={setRoutingStrategy}
              onRequestRetryChange={setRequestRetry}
              onProxyUrlChange={setProxyUrl}
              onLoggingToFileChange={setLoggingToFile}
              onSaveProxySettings={saveProxySettings}
              onThemeChange={(nextTheme) => {
                persistTheme(nextTheme);
                setTheme(nextTheme);
              }}
              onOpenConfigEditor={openConfigEditor}
              historyHealth={historyHealth}
              historyStats={historyStats}
              historyError={historyError}
              countHistory={clients.management.historyCount}
              clearHistory={clearHistory}
              exportHistory={clients.management.exportHistory}
              onHistoryCleared={(deleted) =>
                setNotice(`Cleared ${deleted.toLocaleString("en-US")} request records.`)
              }
              schedulerSettings={schedulerSettings}
              schedulerStatus={schedulerStatus}
              schedulerAccountLabels={Object.fromEntries(
                accounts.map((account) => [account.id, account.label]),
              )}
              schedulerError={schedulerError}
              schedulerPending={schedulerPending}
              onSaveSchedulerSettings={saveSchedulerSettings}
              onSaveSchedulerOrder={saveSchedulerOrder}
              modelPrices={modelPrices}
              onSaveModelPrice={saveModelPrice}
              modelRegistryStatus={modelRegistryStatus}
              modelRegistryError={modelRegistryError}
              onRefreshModelRegistry={refreshModelRegistry}
              tunnelStatus={tunnelStatus}
              tunnelBusy={tunnelBusy}
              onDownloadCloudflared={() => runTunnelAction("download")}
              onEnableTunnel={() => runTunnelAction("enable")}
              onDisableTunnel={() => runTunnelAction("disable")}
              onCopyTunnelUrl={() => {
                if (!tunnelStatus.public_url) return;
                void navigator.clipboard
                  .writeText(tunnelStatus.public_url)
                  .then(() => setNotice("Public tunnel URL copied."))
                  .catch(() => setNotice("Action failed: clipboard unavailable"));
              }}
            />
          </div>
        ) : null}
      </main>

      {onboardingOpen ? (
        <OverlayLayer className="drawer-backdrop">
          <aside className="drawer onboarding-drawer" aria-label="Provider onboarding">
            <div className="section-head">
              <div>
                <h2>Add Account</h2>
                <span className="kicker">Click any provider to add multiple accounts</span>
              </div>
              <Button aria-label="Close onboarding" onClick={() => setOnboardingOpen(false)}>
                <X />
              </Button>
            </div>
            {step.kind === "raw-credential" ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setStep(PROVIDER_STEP)}
                >
                  <ChevronLeft size={15} /> All providers
                </button>
                <strong>
                  {step.provider === "vertex" ? "Vertex service account" : "Kiro credential JSON"}
                </strong>
                <textarea
                  className="input raw-credential-input"
                  aria-label="Credential JSON"
                  value={step.document}
                  onChange={(event) => setStep({ ...step, document: event.target.value })}
                />
                <Button
                  disabled={blocks(pending, "onboarding") || !step.document.trim()}
                  onClick={() => void submitRawCredential()}
                >
                  Import credential
                </Button>
              </div>
            ) : step.kind === "key-import" ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setStep(PROVIDER_STEP)}
                >
                  <ChevronLeft size={15} /> All providers
                </button>
                <strong>{step.provider === "command-code" ? "Command Code" : "iFlow"}</strong>
                <label className="zcode-field">
                  <span>Account label</span>
                  <input
                    aria-label="Imported account label"
                    value={step.label}
                    onChange={(event) => setStep({ ...step, label: event.target.value })}
                  />
                </label>
                <label className="zcode-field">
                  <span>API key</span>
                  <input
                    aria-label="Imported provider API key"
                    type="password"
                    value={step.apiKey}
                    onChange={(event) => setStep({ ...step, apiKey: event.target.value })}
                  />
                </label>
                <Button
                  disabled={
                    blocks(pending, "onboarding") || !step.apiKey.trim() || !step.label.trim()
                  }
                  onClick={() => void submitKeyImport()}
                >
                  Save account
                </Button>
              </div>
            ) : step.kind === "generic" ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setStep(PROVIDER_STEP)}
                >
                  <ChevronLeft size={15} /> All providers
                </button>
                <div className="provider-methods-head">
                  <span className="provider-option-icon" aria-hidden="true">
                    <ProviderGlyph provider={step.provider.id} />
                  </span>
                  <strong>{step.provider.label}</strong>
                </div>
                <label className="zcode-field">
                  <span>Account label</span>
                  <input
                    aria-label="Provider account label"
                    value={step.label}
                    onChange={(event) => setStep({ ...step, label: event.target.value })}
                  />
                </label>
                <label className="zcode-field">
                  <span>Provider endpoint</span>
                  <input
                    aria-label="Provider endpoint"
                    value={step.baseUrl}
                    onChange={(event) => setStep({ ...step, baseUrl: event.target.value })}
                  />
                </label>
                {step.provider.models.length > 0 || step.provider.defaultModel ? (
                  <div className="provider-preset-models" aria-label="Suggested models">
                    <span>Suggested models</span>
                    <small>
                      {step.provider.defaultModel
                        ? `${step.provider.defaultModel}${
                            step.provider.models.length > 0 &&
                            !step.provider.models.includes(step.provider.defaultModel)
                              ? ` (${step.provider.models.join(", ")})`
                              : ""
                          }`
                        : step.provider.models.join(", ")}
                    </small>
                  </div>
                ) : null}
                {isRelayTarget(step.baseUrl) ? (
                  <label className="zcode-field">
                    <span>Plan</span>
                    <select
                      aria-label="Relay plan"
                      value={step.plan}
                      onChange={(event) => setStep({ ...step, plan: event.target.value })}
                    >
                      <option value="">No plan selected</option>
                      {RELAY_PLAN_GROUPS.map((group) => (
                        <optgroup key={group.name} label={group.name}>
                          {group.plans.map((plan) => (
                            <option key={plan.id} value={plan.id}>
                              {plan.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                ) : null}
                {step.provider.authKind !== "local" ? (
                  <label className="zcode-field">
                    <span>API key</span>
                    <input
                      aria-label="Provider API key"
                      type="password"
                      value={step.apiKey}
                      onChange={(event) => setStep({ ...step, apiKey: event.target.value })}
                    />
                  </label>
                ) : null}
                <Button
                  type="button"
                  disabled={!step.baseUrl.trim() || discoveringModels}
                  onClick={() => void handleDiscoverModels()}
                >
                  {discoveringModels ? "Discovering…" : "Discover models"}
                </Button>
                <Button
                  disabled={
                    blocks(pending, "onboarding") ||
                    !step.label.trim() ||
                    !step.baseUrl.trim() ||
                    step.baseUrl.includes("{") ||
                    (step.provider.authKind !== "local" &&
                      !step.provider.keyOptional &&
                      !step.apiKey.trim())
                  }
                  onClick={() => void submitGenericCredential()}
                >
                  {pending === pendingKey.auth(`generic:${step.provider.id}`)
                    ? "Saving…"
                    : "Save account"}
                </Button>
              </div>
            ) : step.kind === "zcode-key" ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setStep(PROVIDER_STEP)}
                >
                  <ChevronLeft size={15} /> All providers
                </button>
                <div className="provider-methods-head">
                  <span className="provider-option-icon" aria-hidden="true">
                    <ProviderGlyph provider="zcode" />
                  </span>
                  <strong>Z.ai</strong>
                </div>
                <label className="zcode-field">
                  <span>Account email</span>
                  <input
                    aria-label="Z.ai account email"
                    value={step.email}
                    onChange={(event) => setStep({ ...step, email: event.target.value })}
                  />
                </label>
                <label className="zcode-field">
                  <span>Provisioned API key</span>
                  <input
                    aria-label="Z.ai provisioned API key"
                    placeholder="{id}.{secret}"
                    value={step.key}
                    onChange={(event) => setStep({ ...step, key: event.target.value })}
                  />
                </label>
                <Button
                  disabled={blocks(pending, "onboarding") || !step.email.trim() || !step.key.trim()}
                  onClick={() => void submitZcodeKey()}
                >
                  {pending === pendingKey.auth("zcode-key") ? "Saving…" : "Save key"}
                </Button>
              </div>
            ) : step.kind === "methods" ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setStep(PROVIDER_STEP)}
                >
                  <ChevronLeft size={15} /> All providers
                </button>
                <div className="provider-methods-head">
                  <span className="provider-option-icon" aria-hidden="true">
                    <ProviderGlyph provider={step.provider.glyph} />
                  </span>
                  <div>
                    <h3>Add {step.provider.name} account</h3>
                  </div>
                </div>
                <span className="provider-detail-label">Add account</span>
                {step.provider.methods.map((method) => (
                  <button
                    type="button"
                    key={method.id}
                    className="provider-method"
                    aria-label={method.name}
                    disabled={blocks(pending, "onboarding")}
                    onClick={() => void beginOnboarding(method.id)}
                  >
                    <span>
                      <strong>
                        {pending === pendingKey.auth(method.id) ? "Starting…" : method.name}
                      </strong>
                      <small>{method.hint}</small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
                {authorization && authorization.provider === step.provider.glyph ? (
                  <div className="authorization-status">
                    <div>
                      <strong>{providerLabel(authorization.provider)} authorization</strong>
                      <span>
                        {authorization.status === "ok"
                          ? "Completed"
                          : authorization.status === "error"
                            ? (authorization.error ?? "Failed")
                            : "Waiting for provider approval…"}
                      </span>
                    </div>
                    {authorization.status === "pending" ? (
                      <Button
                        disabled={blocks(pending, "onboarding")}
                        onClick={() => void checkAuthorization()}
                      >
                        {pending.startsWith("auth-status:")
                          ? "Checking…"
                          : "Check authorization status"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {authorization &&
                authorization.provider === "zcode" &&
                authorization.status === "pending" ? (
                  <div className="zcode-field">
                    <span>
                      The browser lands on a zcode:// address. Paste that full address here to
                      finish sign-in.
                    </span>
                    <input
                      aria-label="ZCode redirect URL"
                      placeholder="zcode://oauth/callback?code=…&state=…"
                      value={zcodeCallbackUrl}
                      onChange={(event) => setZcodeCallbackUrl(event.target.value)}
                    />
                    <Button
                      disabled={blocks(pending, "onboarding") || !zcodeCallbackUrl.trim()}
                      onClick={() => void submitZcodeCallback()}
                    >
                      {pending === pendingKey.auth("zcode-callback")
                        ? "Completing…"
                        : "Complete sign-in"}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : step.kind === "account-kind" ? (
              <div className="provider-options">
                <button
                  type="button"
                  className="provider-method"
                  aria-label="Coding plan"
                  disabled={blocks(pending, "onboarding")}
                  onClick={() => {
                    setOnboardingScope("plan");
                    setProviderSearch("");
                    setStep(PROVIDER_STEP);
                  }}
                >
                  <span>
                    <strong>Coding plan</strong>
                    <small>Subscription sign-ins and local session imports.</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
                <button
                  type="button"
                  className="provider-method"
                  aria-label="API"
                  disabled={blocks(pending, "onboarding")}
                  onClick={() => {
                    setOnboardingScope("api");
                    setProviderSearch("");
                    setStep(PROVIDER_STEP);
                  }}
                >
                  <span>
                    <strong>API</strong>
                    <small>Paste a key or point at any endpoint.</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              </div>
            ) : (
              <div className="provider-options">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setStep(ACCOUNT_KIND_STEP)}
                >
                  <ChevronLeft size={15} /> Account type
                </button>
                <input
                  className="input provider-search"
                  aria-label="Search providers"
                  placeholder={
                    onboardingScope === "plan" ? "Search plan providers" : "Search API providers"
                  }
                  value={providerSearch}
                  onChange={(event) => setProviderSearch(event.target.value)}
                />
                {(onboardingScope === "plan"
                  ? ONBOARDING_PROVIDERS
                  : [
                      CUSTOM_API_PROVIDER_TILE,
                      ...GENERIC_PROVIDER_OPTIONS.map((provider) => ({
                        glyph: provider.id,
                        name: provider.label,
                        methods: [
                          {
                            id: `generic:${provider.id}`,
                            name:
                              provider.authKind === "local"
                                ? "Connect local endpoint"
                                : "Add API key",
                            hint:
                              provider.authKind === "local"
                                ? provider.baseUrl
                                : `Uses ${provider.adapter} at ${provider.baseUrl}`,
                          },
                        ],
                      })),
                    ]
                )
                  .filter((provider) =>
                    `${provider.name} ${provider.glyph}`
                      .toLowerCase()
                      .includes(providerSearch.trim().toLowerCase()),
                  )
                  .map((provider) => {
                    const owned = accounts.filter(
                      (account) => account.provider === provider.glyph,
                    ).length;
                    return (
                      <button
                        type="button"
                        key={provider.glyph}
                        disabled={blocks(pending, "onboarding")}
                        onClick={() => setStep({ kind: "methods", provider })}
                      >
                        <span className="provider-option-icon" aria-hidden="true">
                          <ProviderGlyph provider={provider.glyph} />
                          {owned ? <i className="provider-option-count">{owned}</i> : null}
                        </span>
                        <span className="provider-option-label">{provider.name}</span>
                      </button>
                    );
                  })}
              </div>
            )}
          </aside>
        </OverlayLayer>
      ) : null}
      {configOpen ? (
        <OverlayLayer className="drawer-backdrop">
          <aside className="drawer config-drawer" aria-label="Advanced configuration editor">
            <div className="section-head">
              <div>
                <span className="kicker">RAW YAML</span>
                <h2>Gateway configuration</h2>
              </div>
              <Button aria-label="Close configuration editor" onClick={() => setConfigOpen(false)}>
                <X />
              </Button>
            </div>
            <div className="state-panel warning">
              <AlertTriangle /> This document may contain API keys, proxy credentials, and other
              secrets. Review before copying or sharing.
            </div>
            <label className="yaml-field">
              <span>config.yaml</span>
              <textarea
                aria-label="Raw configuration YAML"
                value={configYaml}
                onChange={(event) => setConfigYaml(event.target.value)}
                spellCheck={false}
              />
            </label>
            <div className="drawer-actions">
              <Button onClick={() => setConfigOpen(false)}>Cancel</Button>
              <Button disabled={blocks(pending, "config")} onClick={() => void saveConfig()}>
                {pending === pendingKey.configSave ? "Saving…" : "Save configuration"}
              </Button>
            </div>
          </aside>
        </OverlayLayer>
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ContextMenu menu={menu} onClose={closeMenu} />
    </AppShell>
  );
}

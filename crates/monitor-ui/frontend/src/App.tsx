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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccountsSurface,
  accountMenuItems,
  formatQuotaPercent,
  quotaRows,
} from "./components/AccountsSurface";
import { ContextMenu, useContextMenu } from "./components/ContextMenu";
import { LegacyMigrationDialog } from "./components/LegacyMigrationPrompt";
import { LogsSurface } from "./components/LogsSurface";
import { OverviewDashboard } from "./components/OverviewDashboard";
import { ProviderGlyph, providerLabel, providerLogos } from "./components/ProviderGlyph";
import { SettingsSurface } from "./components/SettingsSurface";
import { ToastStack, useToasts } from "./components/Toasts";
import { TrayPanel } from "./components/TrayPanel";
import { AppShell, OverlayLayer } from "./components/layout";
import { Button } from "./components/ui";
import {
  type NormalizedAccount,
  formatResetTime,
  mergeAccountsAndCredentials,
} from "./lib/accounts";
import { GatewayError, createGatewayClients } from "./lib/api";
import type { ProviderAuthStatus } from "./lib/api";
import { wantsNativeMenu } from "./lib/context-menu";
import {
  type GatewayLifecycleStatus,
  getGatewayLifecycle,
  getLegacyMigrationStatus,
  openExternalUrl,
  startManagedGateway,
  stopManagedGateway,
} from "./lib/native";
import { type LocalPoint, groupNotchProviders, providerAtPoint } from "./lib/notch";
import { GENERIC_PROVIDER_OPTIONS, type ProviderCatalogEntry } from "./lib/provider-catalog";
import type { LogRecord } from "./lib/schemas";
import type { AdminStats, AuthFileItem } from "./lib/schemas";
import {
  getGatewayBaseUrl,
  getQuotaShowRemaining,
  getRelayKey,
  getTheme,
  setTheme as persistTheme,
  setGatewayBaseUrl,
  setQuotaShowRemaining,
  setRelayKey,
  validateGatewayBaseUrl,
} from "./lib/storage";
import {
  type TelemetrySample,
  appendTelemetrySample,
  persistedTelemetrySamples,
} from "./lib/telemetry";

type Surface = "overview" | "accounts" | "logs" | "settings" | "notch" | "tray";
type LoadState = "loading" | "online" | "starting" | "stopped" | "relay-locked";

const getInitialSurface = (): Surface => {
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("surface");
    if (param === "notch") return "notch";
    if (param === "tray") return "tray";
    if (param === "accounts" || param === "logs" || param === "settings" || param === "overview") {
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

type OnboardingMethod = {
  /** Passed to beginOnboarding; identifies the flow, not the provider. */
  readonly id: string;
  readonly name: string;
  readonly hint: string;
};

/** One tile per provider. A provider with several ways in keeps them behind its
 * own tile rather than scattering each method across the grid. */
const ONBOARDING_PROVIDERS: readonly {
  readonly glyph: string;
  readonly name: string;
  readonly methods: readonly OnboardingMethod[];
}[] = [
  {
    glyph: "claude",
    name: "Claude",
    methods: [
      {
        id: "claude",
        name: "Sign in with Anthropic",
        hint: "Opens the Claude OAuth consent page.",
      },
      {
        id: "claude-local",
        name: "Import Claude Code subscription",
        hint: "Reuses the credential the Claude Code CLI already stores on this machine.",
      },
    ],
  },
  {
    glyph: "codex",
    name: "Codex",
    methods: [{ id: "codex", name: "Sign in with OpenAI", hint: "Opens the Codex consent page." }],
  },
  {
    glyph: "antigravity",
    name: "Antigravity",
    methods: [
      {
        id: "antigravity",
        name: "Sign in with Google",
        hint: "Opens the Antigravity consent page.",
      },
    ],
  },
  {
    glyph: "gemini-cli",
    name: "Gemini CLI",
    methods: [
      { id: "gemini-cli", name: "Sign in with Google", hint: "Uses Gemini CLI OAuth credentials." },
    ],
  },
  {
    glyph: "cursor",
    name: "Cursor",
    methods: [
      { id: "cursor", name: "Sign in with Cursor", hint: "Opens the Cursor consent page." },
    ],
  },
  {
    glyph: "kiro",
    name: "Kiro",
    methods: [
      {
        id: "kiro-import",
        name: "Import Kiro credential",
        hint: "Adds a Kiro Social or AWS IAM Identity Center credential JSON.",
      },
    ],
  },
  {
    glyph: "kimi",
    name: "Kimi",
    methods: [{ id: "kimi", name: "Sign in with Moonshot", hint: "Opens the Kimi consent page." }],
  },
  {
    glyph: "qwen",
    name: "Qwen Code",
    methods: [
      { id: "qwen", name: "Sign in with Qwen Code", hint: "Starts Qoder device authorization." },
    ],
  },
  {
    glyph: "github-copilot",
    name: "GitHub Copilot",
    methods: [
      {
        id: "github-copilot",
        name: "Sign in with GitHub",
        hint: "Starts GitHub device authorization and Copilot token exchange.",
      },
    ],
  },
  {
    glyph: "command-code",
    name: "Command Code",
    methods: [
      {
        id: "command-code",
        name: "Sign in with Command Code",
        hint: "Opens Command Code Studio and validates the returned key with whoami.",
      },
    ],
  },
  {
    glyph: "vertex",
    name: "Vertex AI",
    methods: [
      {
        id: "vertex-service-account",
        name: "Import service account",
        hint: "Exchanges a signed service-account JWT for a Google access token.",
      },
    ],
  },
  {
    glyph: "iflow",
    name: "iFlow",
    methods: [
      { id: "iflow-key", name: "Add iFlow key", hint: "Uses the iFlow OpenAI-compatible API." },
    ],
  },
  {
    glyph: "trae",
    name: "Trae",
    methods: [
      {
        id: "trae-local",
        name: "Import Trae session",
        hint: "Reads Trae IDE local storage without adding it to inference routing.",
      },
    ],
  },
  {
    glyph: "nous",
    name: "Nous Portal",
    methods: [
      { id: "nous", name: "Sign in with Nous", hint: "Starts Hermes device authorization." },
    ],
  },
  {
    glyph: "xai",
    name: "xAI",
    methods: [{ id: "xai", name: "Sign in with xAI", hint: "Opens the xAI consent page." }],
  },
  {
    glyph: "zcode",
    name: "Z.ai",
    methods: [
      {
        id: "zcode-key",
        name: "Paste a provisioned API key",
        // Z.ai's OAuth redirects to zcode://oauth/callback, a scheme no server
        // can receive, so the key is entered rather than captured.
        hint: "Z.ai issues an {id}.{secret} key; OAuth cannot be captured by this console.",
      },
    ],
  },
];

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : "unknown error";

const providerRingColors: Readonly<Record<string, string>> = {
  claude: "#D97757",
  codex: "#10A37F",
  antigravity: "#3186FF",
  kiro: "#993FF5",
  cursor: "#8E8E93",
};

const providerRingColor = (provider: string): string =>
  providerRingColors[provider.trim().toLowerCase()] ?? "#8E8E93";

// Island silhouette matching reference: smooth continuous S-curve flare (55px)
// with vertical screen tangents, rounded convex shoulders, and straight vertical wall.
// ViewBox 0 0 108 520, shared by shadow/glass/edge layers.
const NOTCH_ISLAND_PATH = "M108 0 C108 22 0 33 0 55 V465 C0 487 108 498 108 520 Z";

const worstUsedPercent = (rows: readonly { usedPercent: number }[]): number | null => {
  const values = rows.map((row) => row.usedPercent).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
};

const NotchGlyph = ({ provider }: { provider: string }) => {
  const normalized = provider.trim().toLowerCase();
  const logo = providerLogos[normalized] ?? providerLogos.generic;
  return logo ? (
    <img
      src={logo}
      className={`provider-logo notch-provider-logo notch-provider-logo-color notch-provider-logo-${normalized}`}
      alt=""
      aria-hidden="true"
      data-testid={`provider-logo-${normalized}`}
    />
  ) : (
    <TerminalSquare size={15} />
  );
};

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

  useEffect(
    () => () => {
      if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    },
    [],
  );
  const [notchExpanded, setNotchExpanded] = useState(false);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const [nativeCursor, setNativeCursor] = useState<LocalPoint | null>(null);
  const hoverCloseTimer = useRef<number | undefined>(undefined);
  const [theme, setTheme] = useState(getTheme);
  const [baseUrl, setBaseUrlState] = useState(getGatewayBaseUrl);
  const [relayKey, setRelayKeyState] = useState(getRelayKey);
  const [stats, setStats] = useState<AdminStats>(emptyStats);
  const [credentials, setCredentials] = useState<readonly AuthFileItem[]>([]);
  const [logs, setLogs] = useState<readonly LogRecord[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
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
  const [refreshing, setRefreshing] = useState(false);
  const [gatewayLifecycle, setGatewayLifecycle] = useState<GatewayLifecycleStatus>("running");
  const [provider, setProvider] = useState(
    () => window.sessionStorage.getItem("mahoquot.provider") ?? "all",
  );
  const { toasts, pushToast, dismissToast } = useToasts();
  const setNotice = (message: string) => {
    pushToast(message);
  };
  const [pending, setPending] = useState("");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  const [migrationPromptOpen, setMigrationPromptOpen] = useState(false);
  const [openMethods, setOpenMethods] = useState<(typeof ONBOARDING_PROVIDERS)[number] | null>(
    null,
  );
  const [dragging, setDragging] = useState("");
  const [zcodeForm, setZcodeForm] = useState<{ email: string; key: string } | null>(null);
  const [genericForm, setGenericForm] = useState<{
    readonly provider: ProviderCatalogEntry;
    readonly label: string;
    readonly apiKey: string;
    readonly baseUrl: string;
  } | null>(null);
  const [rawCredentialForm, setRawCredentialForm] = useState<{
    readonly provider: "kiro" | "vertex";
    readonly document: string;
  } | null>(null);
  const [keyImportForm, setKeyImportForm] = useState<{
    readonly provider: "command-code" | "iflow";
    readonly label: string;
    readonly apiKey: string;
  } | null>(null);
  const [credentialsError, setCredentialsError] = useState("");
  const [logsError, setLogsError] = useState("");
  const [gatewayUrlError, setGatewayUrlError] = useState<string | null>(null);
  const [configYaml, setConfigYaml] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [authorization, setAuthorization] = useState<AuthorizationSession | null>(null);
  const [proxyUrl, setProxyUrl] = useState("");
  const [routingStrategy, setRoutingStrategy] = useState("round-robin");
  const [requestRetry, setRequestRetry] = useState("3");
  const [loggingToFile, setLoggingToFile] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [telemetry, setTelemetry] = useState<readonly TelemetrySample[]>([]);
  const firstLoad = useRef(true);

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

  const clients = useMemo(() => createGatewayClients(baseUrl, relayKey), [baseUrl, relayKey]);

  const resetOnboarding = useCallback(() => {
    setProviderSearch("");
    setOpenMethods(null);
    setAuthorization(null);
    setRawCredentialForm(null);
    setKeyImportForm(null);
    setGenericForm(null);
    setZcodeForm(null);
  }, []);

  const openOnboarding = useCallback(async () => {
    resetOnboarding();
    const migration = await getLegacyMigrationStatus();
    if (migration) {
      setMigrationPromptOpen(true);
      return;
    }
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

  const usageRefreshAt = useRef(0);
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

  const refresh = useCallback(async () => {
    if (firstLoad.current) setLoadState("loading");
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
      setLoadState(
        error instanceof GatewayError && error.status === 401
          ? "relay-locked"
          : gatewayLifecycle === "stopped"
            ? "stopped"
            : "starting",
      );
      firstLoad.current = false;
      return;
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
      setCredentialsError(errorMessage(credentialResult.reason));
    }
    if (logResult.status === "fulfilled") {
      setLogs(logResult.value.records);
      setLogsError("");
    } else {
      setLogs([]);
      setLogsError(errorMessage(logResult.reason));
    }
  }, [clients, gatewayLifecycle]);

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
    void getGatewayLifecycle().then(setGatewayLifecycle);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    return () => window.clearInterval(timer);
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

  // macOS delivers pointer events only to the active app, so an unfocused notch
  // never sees mouseenter. Native hover is the sole expansion owner; keeping a
  // DOM/rAF feedback path here deadlocks background WebKit rendering.
  useEffect(() => {
    if (surface !== "notch") return;
    const hover = (event: Event) => {
      setNotchExpanded(Boolean((event as CustomEvent<unknown>).detail));
    };
    const cursor = (event: Event) => {
      setNativeCursor(((event as CustomEvent<unknown>).detail as LocalPoint | null) ?? null);
    };
    window.addEventListener("mahoquot:notch-hover", hover);
    window.addEventListener("mahoquot:notch-cursor", cursor);
    return () => {
      window.removeEventListener("mahoquot:notch-hover", hover);
      window.removeEventListener("mahoquot:notch-cursor", cursor);
    };
  }, [surface]);

  useEffect(() => {
    if (surface !== "notch") return;
    const api = (
      window as {
        __TAURI__?: {
          event?: {
            listen: (
              event: string,
              handler: (message: { payload: boolean }) => void,
            ) => Promise<() => void>;
          };
        };
      }
    ).__TAURI__;
    if (!api?.event?.listen) return;
    const disposers: (() => void)[] = [];
    let cancelled = false;
    const subscribe = (event: string, handler: (payload: unknown) => void) => {
      void api.event
        ?.listen(event, (message: { payload: unknown }) => handler(message.payload))
        .then((unlisten) => {
          if (cancelled) unlisten();
          else disposers.push(unlisten);
        });
    };
    subscribe("notch-hover", (payload) => setNotchExpanded(Boolean(payload)));
    subscribe("notch-cursor", (payload) => setNativeCursor((payload as LocalPoint | null) ?? null));
    return () => {
      cancelled = true;
      for (const dispose of disposers) dispose();
    };
  }, [surface]);

  const openNotchTooltip = useCallback((provider: string) => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = undefined;
    setActiveTooltip(provider);
  }, []);

  const scheduleNotchTooltipClose = useCallback(() => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    // Brief grace lets the pointer cross the gap between icon and tooltip.
    hoverCloseTimer.current = window.setTimeout(() => setActiveTooltip(null), 150);
  }, []);

  useEffect(() => {
    if (!notchExpanded) setActiveTooltip(null);
  }, [notchExpanded]);

  // The webview gets no pointer events while another app is frontmost, so the
  // forwarded native cursor drives stage-two hover instead.
  useEffect(() => {
    if (surface !== "notch" || !notchExpanded) return;
    if (!nativeCursor) {
      scheduleNotchTooltipClose();
      return;
    }
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        ".notch-ring-item[data-hover-provider], .react-visible .notch-tooltip[data-hover-provider], .notch-empty-ring[data-hover-provider]",
      ),
    ].map((element) => ({
      provider: element.dataset.hoverProvider as string,
      rect: element.getBoundingClientRect(),
    }));
    const hit = providerAtPoint(nativeCursor, targets);
    if (hit) openNotchTooltip(hit);
    else scheduleNotchTooltipClose();
  }, [nativeCursor, notchExpanded, surface, openNotchTooltip, scheduleNotchTooltipClose]);

  useEffect(() => {
    window.sessionStorage.setItem("mahoquot.provider", provider);
  }, [provider]);

  useEffect(() => {
    if (surface !== "settings" || settingsLoaded || loadState !== "online") return;
    let active = true;
    void Promise.all([
      clients.management.scalar("proxy-url"),
      clients.management.scalar("routing/strategy"),
      clients.management.scalar("request-retry"),
      clients.management.scalar("logging-to-file"),
    ])
      .then(([proxy, routing, retry, logging]) => {
        if (!active) return;
        if (typeof proxy["proxy-url"] === "string") setProxyUrl(proxy["proxy-url"]);
        if (typeof routing.strategy === "string") setRoutingStrategy(routing.strategy);
        if (typeof retry["request-retry"] === "number") {
          setRequestRetry(String(retry["request-retry"]));
        }
        if (typeof logging["logging-to-file"] === "boolean") {
          setLoggingToFile(logging["logging-to-file"]);
        }
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
  }, [clients, loadState, settingsLoaded, surface]);

  const accounts = useMemo(
    () => mergeAccountsAndCredentials(stats.accounts, credentials),
    [stats, credentials],
  );
  const providers = useMemo(
    () => [...new Set(accounts.map((account) => account.provider))].sort(),
    [accounts],
  );
  const selectedProvider = provider === "all" ? providers[0] : provider;
  const visibleAccounts = accounts.filter((account) => account.provider === selectedProvider);

  const runAccountAction = async (action: "warm" | "reset", account: NormalizedAccount) => {
    if (!account.runtimeId) return;
    const key = `${action}:${account.id}`;
    setPending(key);
    setNotice("");
    try {
      if (action === "warm") await clients.admin.warm(account.runtimeId);
      else await clients.admin.reset(account.runtimeId);
      setNotice(`${action === "warm" ? "Warm-up" : "Reset"} requested — active now.`);
      await refresh();
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const removeCredential = async (account: NormalizedAccount) => {
    if (!account.credentialName) return;
    setPending(`remove:${account.id}`);
    setNotice("");
    try {
      await clients.management.removeCredential(account.credentialName);
      setNotice("Credential removed from the runtime pool.");
      await refresh();
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
      setConfirmRemove("");
    }
  };

  const setCredentialDisabled = async (account: NormalizedAccount, disabled: boolean) => {
    if (!account.credentialName) return;
    setPending(`status:${account.id}`);
    try {
      await clients.management.setCredentialDisabled(account.credentialName, disabled);
      setCredentials((current) =>
        current.map((credential) =>
          credential.name === account.credentialName ? { ...credential, disabled } : credential,
        ),
      );
      await refresh();
      setNotice(`${account.label} ${disabled ? "disabled" : "enabled"}.`);
    } catch (reason) {
      setNotice(`Action failed: ${errorMessage(reason)}`);
    } finally {
      setPending("");
    }
  };

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
    setPending(`order:${accountId}`);
    setNotice("");
    try {
      await clients.management.saveCredentialOrder(names);
      setCredentials(
        [...credentials].sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name)),
      );
      setNotice("Account order saved. This is a display order and does not change routing.");
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const beginOnboarding = async (nextProvider: string) => {
    setPending(`auth:${nextProvider}`);
    setNotice("");
    try {
      if (nextProvider === "claude-local") {
        await clients.management.importLocalClaude();
        setNotice("Claude Code subscription imported and live in the runtime pool.");
        await refresh();
        return;
      }
      if (nextProvider === "trae-local") {
        await clients.management.importLocalTrae();
        setNotice("Trae session imported for local quota monitoring.");
        await refresh();
        return;
      }
      if (nextProvider === "kiro-import") {
        setRawCredentialForm({ provider: "kiro", document: "" });
        return;
      }
      if (nextProvider === "vertex-service-account") {
        setRawCredentialForm({ provider: "vertex", document: "" });
        return;
      }
      if (nextProvider === "iflow-key") {
        const provider = "iflow";
        setKeyImportForm({
          provider,
          label: "iFlow",
          apiKey: "",
        });
        return;
      }
      if (nextProvider === "zcode-key") {
        setZcodeForm({ email: "", key: "" });
        return;
      }
      if (nextProvider.startsWith("generic:")) {
        const providerId = nextProvider.slice("generic:".length);
        const preset = GENERIC_PROVIDER_OPTIONS.find((provider) => provider.id === providerId);
        if (!preset) throw new Error(`Unknown provider preset: ${providerId}`);
        setGenericForm({
          provider: preset,
          label: preset.label,
          apiKey: "",
          baseUrl: preset.baseUrl,
        });
        return;
      }
      const auth = await clients.management.beginProviderAuth(nextProvider);
      const refreshOnFocus = () => {
        window.removeEventListener("focus", refreshOnFocus);
        void refresh();
      };
      window.addEventListener("focus", refreshOnFocus, { once: true });
      await openExternalUrl(auth.url);
      setAuthorization({ provider: nextProvider, state: auth.state, status: "pending" });
      setNotice("Authorization pending. Approve in the provider window; this updates itself.");
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const submitRawCredential = async () => {
    if (!rawCredentialForm) return;
    setPending(`auth:${rawCredentialForm.provider}`);
    try {
      if (rawCredentialForm.provider === "vertex") {
        await clients.management.importVertexServiceAccount(rawCredentialForm.document);
      } else {
        const content = JSON.parse(rawCredentialForm.document) as Record<string, unknown>;
        await clients.management.importCredential(`kiro-import-${Date.now()}.json`, {
          ...content,
          type: "kiro",
        });
      }
      setRawCredentialForm(null);
      await refresh();
      finishOnboarding(rawCredentialForm.provider === "vertex" ? "vertex" : "kiro");
      setNotice("Credential imported and live in the runtime pool.");
    } catch (error) {
      setNotice(`Action failed: ${errorMessage(error)}`);
    } finally {
      setPending("");
    }
  };

  const submitKeyImport = async () => {
    if (!keyImportForm) return;
    setPending(`auth:${keyImportForm.provider}`);
    try {
      if (keyImportForm.provider === "command-code") {
        await clients.management.importCommandCode(
          keyImportForm.apiKey.trim(),
          keyImportForm.label.trim(),
        );
      } else {
        await clients.management.createGenericCredential({
          provider: "iflow",
          label: keyImportForm.label.trim(),
          adapter: "openai-chat",
          baseUrl: "https://api.iflow.cn/v1",
          apiKey: keyImportForm.apiKey.trim(),
          models: ["iflow-rome", "iflow-milan"],
        });
      }
      setKeyImportForm(null);
      await refresh();
      finishOnboarding(keyImportForm.provider);
      setNotice(`${keyImportForm.label} account saved and live in the runtime pool.`);
    } catch (error) {
      setNotice(`Action failed: ${errorMessage(error)}`);
    } finally {
      setPending("");
    }
  };

  const submitGenericCredential = async () => {
    if (!genericForm) return;
    setPending(`auth:generic:${genericForm.provider.id}`);
    setNotice("");
    try {
      await clients.management.createGenericCredential({
        provider: genericForm.provider.id,
        label: genericForm.label.trim() || genericForm.provider.label,
        adapter: genericForm.provider.adapter,
        baseUrl: genericForm.baseUrl.trim(),
        apiKey: genericForm.apiKey.trim(),
        models: genericForm.provider.models,
        ...(genericForm.provider.staticHeaders
          ? { staticHeaders: genericForm.provider.staticHeaders }
          : {}),
      });
      setGenericForm(null);
      setNotice(`${genericForm.provider.label} account saved and live in the runtime pool.`);
      await refresh();
      finishOnboarding(genericForm.provider.id);
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const submitZcodeKey = async () => {
    if (!zcodeForm) return;
    setPending("auth:zcode-key");
    setNotice("");
    try {
      await clients.management.createZcodeCredential(zcodeForm.email.trim(), zcodeForm.key.trim());
      setZcodeForm(null);
      setOpenMethods(null);
      setNotice("Z.ai key saved and live in the runtime pool.");
      await refresh();
      finishOnboarding("zcode");
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const reauthenticate = async (account: NormalizedAccount) => {
    const dedicated = ONBOARDING_PROVIDERS.find((provider) => provider.glyph === account.provider);
    setOpenMethods(dedicated ?? null);
    setOnboardingOpen(true);
    await beginOnboarding(dedicated ? account.provider : `generic:${account.provider}`);
  };

  // Approval happens in a separate browser window the console cannot observe,
  // so the session polls itself instead of stranding the user on "Pending".
  const authPending = authorization?.status === "pending";
  const authProvider = authorization?.provider ?? "";
  const authState = authorization?.state ?? "";
  useEffect(() => {
    if (!authPending) return;
    const provider = authProvider;
    const state = authState;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await clients.management.providerAuthStatus(state);
        if (cancelled || result.status === "pending") return;
        setAuthorization({
          provider,
          state,
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
        });
        if (result.status === "ok") {
          setNotice(`${providerLabel(provider)} authorization completed.`);
          await refresh();
          finishOnboarding(provider);
        } else {
          setNotice(`Action failed: ${result.error ?? "authorization failed"}`);
        }
      } catch {
        // A transient failure while the provider window is still open is not
        // an authorization outcome; the next tick retries.
      }
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authPending, authProvider, authState, clients, refresh, finishOnboarding]);

  const checkAuthorization = async () => {
    if (!authorization) return;
    setPending(`auth-status:${authorization.provider}`);
    try {
      const result = await clients.management.providerAuthStatus(authorization.state);
      setAuthorization({
        provider: authorization.provider,
        state: authorization.state,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
      if (result.status === "ok") {
        setNotice(`${providerLabel(authorization.provider)} authorization completed.`);
        await refresh();
        finishOnboarding(authorization.provider);
      } else if (result.status === "error") {
        setNotice(`Action failed: ${result.error ?? "authorization failed"}`);
      } else {
        setNotice("Authorization still pending. Approve in the provider window.");
      }
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const saveProxySettings = async () => {
    const retry = Number(requestRetry);
    if (!Number.isInteger(retry) || retry < 0) {
      setNotice("Request retry count must be a non-negative integer.");
      return;
    }
    setPending("settings:save");
    setNotice("");
    try {
      await Promise.all([
        clients.management.saveScalar("proxy-url", proxyUrl.trim()),
        clients.management.saveScalar("routing/strategy", routingStrategy),
        clients.management.saveScalar("request-retry", retry),
        clients.management.saveScalar("logging-to-file", loggingToFile),
      ]);
      setNotice("Proxy settings saved and applied.");
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const toggleGateway = async () => {
    setPending("gateway:lifecycle");
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

  const openConfigEditor = async () => {
    setNotice("");
    setPending("config:load");
    try {
      setConfigYaml(await clients.management.configYaml());
      setConfigOpen(true);
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const saveConfig = async () => {
    setPending("config:save");
    setNotice("");
    try {
      await clients.management.saveConfigYaml(configYaml);
      setNotice("Configuration saved and applied.");
      setConfigOpen(false);
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

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
        proxyUrl={baseUrl || "Same-origin gateway"}
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
      />
    );
  }

  if (surface === "notch") {
    const notchGroups =
      loadState === "online" && accounts.length
        ? groupNotchProviders(
            accounts.map((account) => ({
              provider: account.provider,
              label: account.label || account.email || account.id,
              rows: quotaRows(account).map((row) => ({
                name: row.name,
                usedPercent: row.usedPercent,
                resetSeconds: row.resetSeconds,
              })),
            })),
          )
        : [];
    const renderNotchTooltip = (group: (typeof notchGroups)[number]) => (
      <div className="notch-tooltip-anchor">
        <div
          className="notch-tooltip"
          role="tooltip"
          data-testid={`notch-tooltip-${group.provider}`}
          data-hover-provider={group.provider}
          onMouseEnter={() => openNotchTooltip(group.provider)}
          onMouseLeave={scheduleNotchTooltipClose}
        >
          <div className="notch-tooltip-head">
            <ProviderGlyph provider={group.provider} />
            <strong className="capitalize">{group.provider}</strong>
            <span className="notch-tooltip-count">
              {group.accountCount} account{group.accountCount > 1 ? "s" : ""}
            </span>
          </div>
          {group.accounts.map((entry) => (
            <div
              className="notch-tooltip-account"
              key={entry.label}
              data-testid={`notch-tooltip-account-${entry.label}`}
            >
              <div className="notch-tooltip-account-head">
                <strong title={entry.label}>{entry.label}</strong>
              </div>
              {entry.rows.length ? (
                entry.rows.map((row, index) => (
                  <div className="notch-tooltip-row" key={`${row.name}-${index}`}>
                    <div className="notch-tooltip-row-head">
                      <span className="notch-tooltip-label">{row.name}</span>
                      <small className="notch-tooltip-reset">
                        Resets{" "}
                        {row.resetSeconds === null ? "later" : formatResetTime(row.resetSeconds)}
                      </small>
                    </div>
                    <div className="notch-tooltip-bar">
                      <i
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(0, showRemaining ? 100 - row.usedPercent : row.usedPercent),
                          )}%`,
                          background: index === 0 ? providerRingColor(group.provider) : "var(--ok)",
                        }}
                      />
                    </div>
                    <div className="notch-tooltip-meta">
                      <span>
                        {formatQuotaPercent(
                          showRemaining ? 100 - row.usedPercent : row.usedPercent,
                        )}
                        % {showRemaining ? "Left" : "Used"}
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="notch-tooltip-row">
                  <div className="notch-tooltip-empty">No quota reported</div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
    return (
      <div
        className={`notch-shell${notchExpanded ? " expanded open" : ""}`}
        data-mahoquot-surface="notch"
      >
        <div className="notch-trigger-strip" data-testid="notch-trigger-strip" />
        <div className="notch-island-shape" aria-hidden="true">
          <svg
            className="notch-island-shadow"
            viewBox="0 0 108 520"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={NOTCH_ISLAND_PATH} />
          </svg>
          <div
            className="notch-island-glass"
            style={{ clipPath: `path("${NOTCH_ISLAND_PATH}")` }}
          />
          <svg
            className="notch-island-edge"
            viewBox="0 0 108 520"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d={NOTCH_ISLAND_PATH} />
          </svg>
        </div>
        <div className={`notch-surface${notchExpanded ? " expanded" : ""}`}>
          {notchGroups.length ? (
            notchGroups.map((group) => {
              const dial = worstUsedPercent(group.rows);
              const circumference = 2 * Math.PI * 24;
              const used =
                dial === null ? 0 : (Math.min(100, Math.max(0, dial)) / 100) * circumference;
              return (
                <button
                  type="button"
                  className="notch-ring-item"
                  key={group.provider}
                  data-provider={group.provider}
                  data-testid={`notch-ring-${group.provider}`}
                  data-hover-provider={group.provider}
                  onMouseEnter={() => openNotchTooltip(group.provider)}
                  onMouseLeave={scheduleNotchTooltipClose}
                  onClick={() => openNotchTooltip(group.provider)}
                >
                  <span className="notch-dial">
                    <svg className="notch-dial-ring" viewBox="0 0 58 58" aria-hidden="true">
                      <circle className="notch-dial-track" cx="29" cy="29" r="24" />
                      {dial !== null && (
                        <circle
                          className="notch-dial-arc"
                          cx="29"
                          cy="29"
                          r="24"
                          style={{
                            stroke: providerRingColor(group.provider),
                            strokeDasharray: `${used} ${circumference}`,
                          }}
                        />
                      )}
                    </svg>
                    <span className="notch-ring-logo">
                      <NotchGlyph provider={group.provider} />
                    </span>
                  </span>
                  <span className="notch-dial-label">
                    {dial === null ? "–" : `${Math.round(dial)}%`}
                  </span>
                  <div className={activeTooltip === group.provider ? "react-visible" : undefined}>
                    {renderNotchTooltip(group)}
                  </div>
                </button>
              );
            })
          ) : (
            <div
              className="notch-empty-ring"
              data-testid="notch-empty-ring"
              data-hover-provider="__empty__"
              onMouseEnter={() => openNotchTooltip("__empty__")}
              onMouseLeave={scheduleNotchTooltipClose}
            >
              <div className="notch-ring-wrap">
                <span className="notch-ring-logo">
                  <strong>Q</strong>
                </span>
              </div>
              <div
                className={`notch-tooltip-anchor${activeTooltip === "__empty__" ? " react-visible" : ""}`}
              >
                <div
                  className="notch-tooltip"
                  role="tooltip"
                  data-testid="notch-tooltip-empty"
                  data-hover-provider="__empty__"
                  onMouseEnter={() => openNotchTooltip("__empty__")}
                  onMouseLeave={scheduleNotchTooltipClose}
                >
                  <div className="notch-tooltip-head">
                    <strong>Mahoquot</strong>
                  </div>
                  <div className="notch-tooltip-row">
                    <div className="notch-tooltip-label">No accounts connected</div>
                    <div className="notch-tooltip-meta">
                      <span>Onboard in Operations Console</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <AppShell className="app" data-mahoquot-app="operations-console">
      <LegacyMigrationDialog
        open={migrationPromptOpen}
        onResolved={() => {
          setMigrationPromptOpen(false);
          resetOnboarding();
          setOnboardingOpen(true);
        }}
      />
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
                onClick={() => void refreshUsage(true).finally(() => void refresh())}
              >
                <RefreshCw size={15} /> Refresh
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

        {loadState === "relay-locked" ? (
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
            pending={pending}
            credentialsError={credentialsError}
            dragging={dragging}
            confirmRemove={confirmRemove}
            onSelectProvider={setProvider}
            onRunAccountAction={runAccountAction}
            onRefresh={refresh}
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
          <LogsSurface records={logs} logsError={logsError} fromMemoryTail={!loggingToFile} />
        ) : null}

        {surface === "settings" ? (
          <SettingsSurface
            gatewayLifecycle={gatewayLifecycle}
            pending={pending}
            loadState={loadState}
            baseUrl={baseUrl}
            gatewayUrlError={gatewayUrlError}
            relayKey={relayKey}
            routingStrategy={routingStrategy}
            requestRetry={requestRetry}
            proxyUrl={proxyUrl}
            loggingToFile={loggingToFile}
            theme={theme}
            showRemaining={showRemaining}
            onShowRemainingChange={setShowRemaining}
            onToggleGateway={toggleGateway}
            onBaseUrlChange={(val) => {
              setBaseUrlState(val);
              setGatewayUrlError(null);
            }}
            onRelayKeyChange={setRelayKeyState}
            onRelayKeyBlur={() => setRelayKey(relayKey)}
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
              setGatewayBaseUrl(baseUrl);
              setRelayKey(relayKey);
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
          />
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
            {rawCredentialForm ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setRawCredentialForm(null)}
                >
                  <ChevronLeft size={15} /> All providers
                </button>
                <strong>
                  {rawCredentialForm.provider === "vertex"
                    ? "Vertex service account"
                    : "Kiro credential JSON"}
                </strong>
                <textarea
                  className="input raw-credential-input"
                  aria-label="Credential JSON"
                  value={rawCredentialForm.document}
                  onChange={(event) =>
                    setRawCredentialForm({ ...rawCredentialForm, document: event.target.value })
                  }
                />
                <Button
                  disabled={pending !== "" || !rawCredentialForm.document.trim()}
                  onClick={() => void submitRawCredential()}
                >
                  Import credential
                </Button>
              </div>
            ) : keyImportForm ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setKeyImportForm(null)}
                >
                  <ChevronLeft size={15} /> All providers
                </button>
                <strong>
                  {keyImportForm.provider === "command-code" ? "Command Code" : "iFlow"}
                </strong>
                <label className="zcode-field">
                  <span>Account label</span>
                  <input
                    aria-label="Imported account label"
                    value={keyImportForm.label}
                    onChange={(event) =>
                      setKeyImportForm({ ...keyImportForm, label: event.target.value })
                    }
                  />
                </label>
                <label className="zcode-field">
                  <span>API key</span>
                  <input
                    aria-label="Imported provider API key"
                    type="password"
                    value={keyImportForm.apiKey}
                    onChange={(event) =>
                      setKeyImportForm({ ...keyImportForm, apiKey: event.target.value })
                    }
                  />
                </label>
                <Button
                  disabled={
                    pending !== "" || !keyImportForm.apiKey.trim() || !keyImportForm.label.trim()
                  }
                  onClick={() => void submitKeyImport()}
                >
                  Save account
                </Button>
              </div>
            ) : genericForm ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setGenericForm(null)}
                >
                  <ChevronLeft size={15} /> All providers
                </button>
                <div className="provider-methods-head">
                  <span className="provider-option-icon" aria-hidden="true">
                    <ProviderGlyph provider={genericForm.provider.id} />
                  </span>
                  <strong>{genericForm.provider.label}</strong>
                </div>
                <label className="zcode-field">
                  <span>Account label</span>
                  <input
                    aria-label="Provider account label"
                    value={genericForm.label}
                    onChange={(event) =>
                      setGenericForm({ ...genericForm, label: event.target.value })
                    }
                  />
                </label>
                <label className="zcode-field">
                  <span>Provider endpoint</span>
                  <input
                    aria-label="Provider endpoint"
                    value={genericForm.baseUrl}
                    onChange={(event) =>
                      setGenericForm({ ...genericForm, baseUrl: event.target.value })
                    }
                  />
                </label>
                {genericForm.provider.authKind !== "local" ? (
                  <label className="zcode-field">
                    <span>API key</span>
                    <input
                      aria-label="Provider API key"
                      type="password"
                      value={genericForm.apiKey}
                      onChange={(event) =>
                        setGenericForm({ ...genericForm, apiKey: event.target.value })
                      }
                    />
                  </label>
                ) : null}
                <Button
                  disabled={
                    pending !== "" ||
                    !genericForm.label.trim() ||
                    !genericForm.baseUrl.trim() ||
                    genericForm.baseUrl.includes("{") ||
                    (genericForm.provider.authKind !== "local" &&
                      !genericForm.provider.keyOptional &&
                      !genericForm.apiKey.trim())
                  }
                  onClick={() => void submitGenericCredential()}
                >
                  {pending === `auth:generic:${genericForm.provider.id}`
                    ? "Saving…"
                    : "Save account"}
                </Button>
              </div>
            ) : zcodeForm ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setZcodeForm(null)}
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
                    value={zcodeForm.email}
                    onChange={(event) => setZcodeForm({ ...zcodeForm, email: event.target.value })}
                  />
                </label>
                <label className="zcode-field">
                  <span>Provisioned API key</span>
                  <input
                    aria-label="Z.ai provisioned API key"
                    placeholder="{id}.{secret}"
                    value={zcodeForm.key}
                    onChange={(event) => setZcodeForm({ ...zcodeForm, key: event.target.value })}
                  />
                </label>
                <Button
                  disabled={pending !== "" || !zcodeForm.email.trim() || !zcodeForm.key.trim()}
                  onClick={() => void submitZcodeKey()}
                >
                  {pending === "auth:zcode-key" ? "Saving…" : "Save key"}
                </Button>
              </div>
            ) : openMethods ? (
              <div className="provider-methods">
                <button
                  type="button"
                  className="provider-methods-back"
                  onClick={() => setOpenMethods(null)}
                >
                  <ChevronLeft size={15} /> All providers
                </button>
                <div className="provider-methods-head">
                  <span className="provider-option-icon" aria-hidden="true">
                    <ProviderGlyph provider={openMethods.glyph} />
                  </span>
                  <div>
                    <h3>Add {openMethods.name} account</h3>
                  </div>
                </div>
                <span className="provider-detail-label">Add account</span>
                {openMethods.methods.map((method) => (
                  <button
                    type="button"
                    key={method.id}
                    className="provider-method"
                    aria-label={method.name}
                    disabled={pending !== ""}
                    onClick={() => void beginOnboarding(method.id)}
                  >
                    <span>
                      <strong>{pending === `auth:${method.id}` ? "Starting…" : method.name}</strong>
                      <small>{method.hint}</small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
                {authorization && authorization.provider === openMethods.glyph ? (
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
                      <Button disabled={pending !== ""} onClick={() => void checkAuthorization()}>
                        {pending.startsWith("auth-status:")
                          ? "Checking…"
                          : "Check authorization status"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="provider-options">
                <input
                  className="input provider-search"
                  aria-label="Search providers"
                  placeholder="Search 83 providers"
                  value={providerSearch}
                  onChange={(event) => setProviderSearch(event.target.value)}
                />
                {[
                  ...ONBOARDING_PROVIDERS,
                  ...GENERIC_PROVIDER_OPTIONS.map((provider) => ({
                    glyph: provider.id,
                    name: provider.label,
                    methods: [
                      {
                        id: `generic:${provider.id}`,
                        name:
                          provider.authKind === "local" ? "Connect local endpoint" : "Add API key",
                        hint:
                          provider.authKind === "local"
                            ? provider.baseUrl
                            : `Uses ${provider.adapter} at ${provider.baseUrl}`,
                      },
                    ],
                  })),
                ]
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
                        disabled={pending !== ""}
                        onClick={() => setOpenMethods(provider)}
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
              <Button disabled={pending !== ""} onClick={() => void saveConfig()}>
                {pending === "config:save" ? "Saving…" : "Save configuration"}
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

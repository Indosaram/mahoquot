import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  Copy,
  GripVertical,
  KeyRound,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Settings2,
  Sparkles,
  TerminalSquare,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import antigravityLogo from "./assets/provider-logos/antigravity.svg";
import claudeLogo from "./assets/provider-logos/claude.svg";
import codexLogo from "./assets/provider-logos/codex.svg";
import cursorLogo from "./assets/provider-logos/cursor.svg";
import kimiLogo from "./assets/provider-logos/kimi.svg";
import kiroLogo from "./assets/provider-logos/kiro.svg";
import xaiLogo from "./assets/provider-logos/xai.svg";
import zcodeLogo from "./assets/provider-logos/zcode.svg";
import { ContextMenu, type ContextMenuItem, useContextMenu } from "./components/ContextMenu";
import { OverviewDashboard } from "./components/OverviewDashboard";
import { Badge, Button, Card, Field, Input } from "./components/ui";
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
  startManagedGateway,
  stopManagedGateway,
} from "./lib/native";
import { type LocalPoint, groupNotchProviders, providerAtPoint } from "./lib/notch";
import type { AdminStats, AuthFileItem } from "./lib/schemas";
import {
  getGatewayBaseUrl,
  getRelayKey,
  getTheme,
  setTheme as persistTheme,
  setGatewayBaseUrl,
  setRelayKey,
  validateGatewayBaseUrl,
} from "./lib/storage";
import {
  type TelemetrySample,
  appendTelemetrySample,
  persistedTelemetrySamples,
} from "./lib/telemetry";

type Surface = "overview" | "accounts" | "logs" | "settings" | "notch";
type LoadState = "loading" | "online" | "starting" | "stopped" | "relay-locked";

const getInitialSurface = (): Surface => {
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("surface");
    if (param === "notch") return "notch";
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

const formatQuotaPercent = (percent: number): string => {
  if (percent > 0 && percent < 0.01) return "<0.01";
  if (percent < 1) return percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return Math.round(percent).toString();
};

type QuotaRow = {
  readonly name: string;
  /** Model pool the window meters, e.g. "Gemini Models". Null when the provider
   * reports one flat pool, so there is nothing to disambiguate. */
  readonly group: string | null;
  readonly usedPercent: number;
  readonly resetSeconds: number | null;
};

/** The group already names the pool, so "Weekly Limit Remaining" reduces to
 * "Weekly" beside a remaining percentage. */
const windowLabel = (raw: string): string =>
  raw
    .replace(/\s*limit(\s+remaining)?$/i, "")
    .replace(/\s*remaining$/i, "")
    .trim() || raw;

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
    glyph: "cursor",
    name: "Cursor",
    methods: [
      { id: "cursor", name: "Sign in with Cursor", hint: "Opens the Cursor consent page." },
    ],
  },
  {
    glyph: "kimi",
    name: "Kimi",
    methods: [{ id: "kimi", name: "Sign in with Moonshot", hint: "Opens the Kimi consent page." }],
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

const resetSeconds = (resetAtUnix?: number | null, after?: number | null): number | null => {
  if (typeof resetAtUnix === "number") {
    return Math.max(0, resetAtUnix - Math.floor(Date.now() / 1000));
  }
  return typeof after === "number" ? Math.max(0, after) : null;
};

const quotaRows = (account: NormalizedAccount): readonly QuotaRow[] => {
  const usage = account.usage;
  if (!usage) return [];
  const grouped =
    usage.groups?.flatMap((group) =>
      group.buckets.flatMap((bucket, index) =>
        typeof bucket.used_percent === "number"
          ? [
              {
                name: windowLabel(
                  bucket.display_name || group.display_name || group.models || `Quota ${index + 1}`,
                ),
                group: group.display_name || group.models || null,
                usedPercent: bucket.used_percent,
                resetSeconds: resetSeconds(bucket.reset_at_unix, bucket.reset_after_seconds),
              },
            ]
          : [],
      ),
    ) ?? [];
  if (grouped.length) return grouped;
  const flat: readonly (QuotaRow | null)[] = [
    usage.primary && typeof usage.primary.used_percent === "number"
      ? {
          name: usage.primary.limit_name || "Primary window",
          group: null,
          usedPercent: usage.primary.used_percent,
          resetSeconds: resetSeconds(
            usage.primary.reset_at_unix,
            usage.primary.reset_after_seconds,
          ),
        }
      : null,
    usage.secondary && typeof usage.secondary.used_percent === "number"
      ? {
          name: usage.secondary.limit_name || "Secondary window",
          group: null,
          usedPercent: usage.secondary.used_percent,
          resetSeconds: resetSeconds(
            usage.secondary.reset_at_unix,
            usage.secondary.reset_after_seconds,
          ),
        }
      : null,
  ];
  return flat.filter((row): row is QuotaRow => row !== null);
};

const providerLabel = (value: string): string =>
  value
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const providerLogos: Readonly<Record<string, string>> = {
  antigravity: antigravityLogo,
  claude: claudeLogo,
  codex: codexLogo,
  cursor: cursorLogo,
  kimi: kimiLogo,
  kiro: kiroLogo,
  xai: xaiLogo,
  zcode: zcodeLogo,
};

const providerRingColors: Readonly<Record<string, string>> = {
  claude: "#D97757",
  codex: "#10A37F",
  antigravity: "#3186FF",
  kiro: "#993FF5",
  cursor: "#8E8E93",
};

const providerRingColor = (provider: string): string =>
  providerRingColors[provider.trim().toLowerCase()] ?? "#8E8E93";

/** Logos shipped as a single dark fill, which needs inverting on dark themes. */
const MONOCHROME_LOGOS: ReadonlySet<string> = new Set(["cursor", "kimi", "xai", "zcode"]);

/** The notch paints one flat tint: brand plates and gradients turn to noise on
 * the black island, so the artwork is used as a mask instead of an image. */
const NotchGlyph = ({ provider }: { provider: string }) => {
  const normalized = provider.trim().toLowerCase();
  const logo = providerLogos[normalized];
  return logo ? (
    <span
      className="provider-logo"
      aria-hidden="true"
      data-testid={`provider-logo-${normalized}`}
      style={{ "--glyph": `url(${logo})` } as React.CSSProperties}
    />
  ) : (
    <TerminalSquare size={15} />
  );
};

const ProviderGlyph = ({ provider }: { provider: string }) => {
  const normalized = provider.trim().toLowerCase();
  const logo = providerLogos[normalized];
  return logo ? (
    <img
      src={logo}
      alt=""
      aria-hidden="true"
      data-testid={`provider-logo-${normalized}`}
      className={
        MONOCHROME_LOGOS.has(normalized)
          ? "provider-logo provider-logo-monochrome"
          : "provider-logo"
      }
    />
  ) : (
    <TerminalSquare size={15} />
  );
};

const HealthBadge = ({ account }: { account: NormalizedAccount }) => {
  const tone = account.health === "healthy" ? "ok" : account.health === "cooldown" ? "warn" : "bad";
  return <Badge tone={tone}>{account.health.replace("_", " ")}</Badge>;
};

const accountMenuItems = (account: NormalizedAccount): ContextMenuItem[] => {
  const identifier = account.runtimeId ?? account.credentialName;
  const items: ContextMenuItem[] = [
    { label: "Copy account name", run: () => navigator.clipboard.writeText(account.label) },
  ];
  if (identifier) {
    items.push({ label: "Copy account ID", run: () => navigator.clipboard.writeText(identifier) });
  }
  return items;
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
  const [notchOpen, setNotchOpen] = useState(false);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const [nativeCursor, setNativeCursor] = useState<LocalPoint | null>(null);
  const hoverCloseTimer = useRef<number | undefined>(undefined);
  const [theme, setTheme] = useState(getTheme);
  const [baseUrl, setBaseUrlState] = useState(getGatewayBaseUrl());
  const [relayKey, setRelayKeyState] = useState(getRelayKey());
  const [stats, setStats] = useState<AdminStats>(emptyStats);
  const [credentials, setCredentials] = useState<readonly AuthFileItem[]>([]);
  const [logs, setLogs] = useState<readonly string[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [gatewayLifecycle, setGatewayLifecycle] = useState<GatewayLifecycleStatus>("running");
  const [provider, setProvider] = useState(
    () => window.sessionStorage.getItem("mahoquot.provider") ?? "all",
  );
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState("");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState("");
  const [openMethods, setOpenMethods] = useState<(typeof ONBOARDING_PROVIDERS)[number] | null>(
    null,
  );
  const [dragging, setDragging] = useState("");
  const [zcodeForm, setZcodeForm] = useState<{ email: string; key: string } | null>(null);
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

  const clients = useMemo(() => createGatewayClients(baseUrl, relayKey), [baseUrl, relayKey]);

  const refresh = useCallback(async () => {
    if (firstLoad.current) setLoadState("loading");
    try {
      const nextStats = await clients.admin.stats();
      setStats(nextStats);
      setTelemetry((samples) => {
        const persisted = persistedTelemetrySamples(nextStats.history ?? []);
        return persisted.length ? persisted : appendTelemetrySample(samples, nextStats, Date.now());
      });
      setLoadState("online");
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
      setLogs(logResult.value.lines);
      setLogsError("");
    } else {
      setLogs([]);
      setLogsError(errorMessage(logResult.reason));
    }
  }, [clients, gatewayLifecycle]);

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
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (surface === "notch") {
      document.documentElement.dataset.surface = "notch";
      return () => {
        delete document.documentElement.dataset.surface;
      };
    }
  }, [surface]);

  useEffect(() => {
    if (surface !== "notch") return;
    const api = (
      window as {
        __TAURI__?: { core?: { invoke: (command: string) => void } };
      }
    ).__TAURI__;
    api?.core?.invoke(notchExpanded ? "expand_notch" : "collapse_notch");
  }, [notchExpanded, surface]);

  // The native window must already be large before the island grows into it,
  // and must stay large until the island has finished folding away.
  useEffect(() => {
    if (surface !== "notch") return;
    if (!notchExpanded) {
      setNotchOpen(false);
      return;
    }
    const frame = requestAnimationFrame(() => setNotchOpen(true));
    return () => cancelAnimationFrame(frame);
  }, [notchExpanded, surface]);

  // macOS delivers pointer events only to the active app, so an unfocused notch
  // never sees mouseenter. The native global monitor owns hover and tells us.
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
    if (!notchOpen) setActiveTooltip(null);
  }, [notchOpen]);

  // The webview gets no pointer events while another app is frontmost, so the
  // forwarded native cursor drives stage-two hover instead.
  useEffect(() => {
    if (surface !== "notch" || !notchOpen) return;
    if (!nativeCursor) {
      scheduleNotchTooltipClose();
      return;
    }
    const targets = [...document.querySelectorAll<HTMLElement>("[data-hover-provider]")].map(
      (element) => ({
        provider: element.dataset.hoverProvider as string,
        rect: element.getBoundingClientRect(),
      }),
    );
    const hit = providerAtPoint(nativeCursor, targets);
    if (hit) openNotchTooltip(hit);
    else scheduleNotchTooltipClose();
  }, [nativeCursor, notchOpen, surface, openNotchTooltip, scheduleNotchTooltipClose]);

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
      if (nextProvider === "zcode-key") {
        setZcodeForm({ email: "", key: "" });
        return;
      }
      const auth = await clients.management.beginProviderAuth(nextProvider);
      const refreshOnFocus = () => {
        window.removeEventListener("focus", refreshOnFocus);
        void refresh();
      };
      window.addEventListener("focus", refreshOnFocus, { once: true });
      window.open(auth.url, "_blank", "noopener,noreferrer");
      setAuthorization({ provider: nextProvider, state: auth.state, status: "pending" });
      setNotice("Authorization pending. Approve in the provider window; this updates itself.");
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
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const reauthenticate = async (account: NormalizedAccount) => {
    setOnboardingOpen(true);
    await beginOnboarding(account.provider);
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
    // `refresh` is intentionally excluded: it is rebuilt every render, and
    // depending on it would tear the interval down before it can ever fire.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [authPending, authProvider, authState, clients]);

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
              <div className="notch-tooltip-account-name">{entry.label}</div>
              {entry.rows.length ? (
                entry.rows.slice(0, 2).map((row, index) => (
                  <div className="notch-tooltip-row" key={`${row.name}-${index}`}>
                    <div className="notch-tooltip-label">{row.name}</div>
                    <div className="notch-tooltip-bar">
                      <i
                        style={{
                          width: `${Math.min(100, Math.max(0, row.usedPercent))}%`,
                          background: index === 0 ? providerRingColor(group.provider) : "var(--ok)",
                        }}
                      />
                    </div>
                    <div className="notch-tooltip-meta">
                      <span>{formatQuotaPercent(row.usedPercent)}% Used</span>
                      <small>
                        Resets{" "}
                        {row.resetSeconds === null ? "later" : formatResetTime(row.resetSeconds)}
                      </small>
                    </div>
                  </div>
                ))
              ) : (
                <div className="notch-tooltip-row">
                  <div className="notch-tooltip-label">No quota reported</div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
    return (
      <div
        className={`notch-shell${notchExpanded ? " expanded" : ""}${notchOpen ? " open" : ""}`}
        data-mahoquot-surface="notch"
        onMouseEnter={() => setNotchExpanded(true)}
        onMouseLeave={() => setNotchExpanded(false)}
      >
        <div
          className="notch-trigger-strip"
          data-testid="notch-trigger-strip"
          aria-label="Show provider quotas"
        />
        <div className={`notch-surface${notchOpen ? " expanded" : ""}`}>
          {notchExpanded &&
            (notchGroups.length ? (
              notchGroups.map((group) => (
                <div
                  className="notch-ring-item"
                  key={group.provider}
                  data-provider={group.provider}
                  data-testid={`notch-ring-${group.provider}`}
                  data-hover-provider={group.provider}
                  onMouseEnter={() => openNotchTooltip(group.provider)}
                  onMouseLeave={scheduleNotchTooltipClose}
                >
                  <div className="notch-ring-wrap">
                    <span className="notch-ring-logo">
                      <NotchGlyph provider={group.provider} />
                    </span>
                    {group.accountCount > 1 && (
                      <span className="notch-ring-count">{group.accountCount}</span>
                    )}
                  </div>
                  {activeTooltip === group.provider && renderNotchTooltip(group)}
                </div>
              ))
            ) : (
              <div
                className="notch-empty-ring"
                data-testid="notch-empty-ring"
                onMouseEnter={() => openNotchTooltip("__empty__")}
                onMouseLeave={scheduleNotchTooltipClose}
              >
                <div className="notch-ring-wrap">
                  <span className="notch-ring-logo">
                    <strong>Q</strong>
                  </span>
                </div>
                {activeTooltip === "__empty__" && (
                  <div className="notch-tooltip-anchor">
                    <div
                      className="notch-tooltip"
                      role="tooltip"
                      data-testid="notch-tooltip-empty"
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
                )}
              </div>
            ))}
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-mahoquot-app="operations-console">
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
              <Button aria-label="Refresh snapshot" onClick={() => void refresh()}>
                <RefreshCw size={15} /> Refresh
              </Button>
              <Button aria-label="Add account" onClick={() => setOnboardingOpen(true)}>
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
          <div className="content accounts">
            <div className="provider-tabs" aria-label="Providers">
              {providers.map((item) => (
                <label className="provider-tab" key={item}>
                  <input
                    type="radio"
                    name="provider"
                    value={item}
                    aria-label={`${item} ${accounts.filter((account) => account.provider === item).length} account${accounts.filter((account) => account.provider === item).length === 1 ? "" : "s"}`}
                    checked={selectedProvider === item}
                    onChange={(event) => setProvider(event.currentTarget.value)}
                  />
                  <span className="provider-tab-content">
                    <span className="provider-tab-icon">
                      <ProviderGlyph provider={item} />
                    </span>
                    <strong>{providerLabel(item)}</strong>
                    <span className="provider-count">
                      {accounts.filter((account) => account.provider === item).length}
                    </span>
                    <i
                      className={
                        accounts.some(
                          (account) => account.provider === item && account.health === "healthy",
                        )
                          ? "healthy"
                          : ""
                      }
                    />
                  </span>
                </label>
              ))}
            </div>
            {notice ? (
              <output className={notice.startsWith("Action failed") ? "notice danger" : "notice"}>
                {notice}
              </output>
            ) : null}
            {credentialsError ? (
              <div className="state-panel warning">
                <AlertTriangle /> Credential inventory unavailable, so adding, removing, and
                re-authenticating are disabled: {credentialsError}
              </div>
            ) : null}
            <div className="account-list">
              {visibleAccounts.map((account) => (
                <Card
                  key={account.id}
                  className="account-card"
                  draggable={Boolean(account.credentialName) && pending === ""}
                  data-dragging={dragging === account.credentialName ? "true" : undefined}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    setDragging(account.credentialName ?? "");
                  }}
                  onDragOver={(event) => {
                    if (dragging && account.credentialName) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    void dropCredentialOn(account);
                  }}
                  onDragEnd={() => setDragging("")}
                  onContextMenu={(event) => openMenu(event, accountMenuItems(account))}
                >
                  <div className="account-card-head">
                    <div className="account-title">
                      {account.credentialName ? (
                        <button
                          type="button"
                          className="account-drag-handle"
                          aria-label={`Reorder ${account.label}`}
                          disabled={pending !== ""}
                          onKeyDown={(event) => {
                            // Dragging is mouse-only, so the handle keeps a
                            // keyboard path to the same reordering.
                            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                              event.preventDefault();
                              void moveCredential(account, event.key === "ArrowUp" ? -1 : 1);
                            }
                          }}
                        >
                          <GripVertical size={14} />
                        </button>
                      ) : null}
                      <span className="account-provider-icon">
                        <ProviderGlyph provider={account.provider} />
                      </span>
                      {account.usage?.plan_type ? (
                        <span className="plan-badge">{account.usage.plan_type}</span>
                      ) : null}
                      <div className="account-id">
                        <div>
                          <strong>{account.label}</strong>
                          <HealthBadge account={account} />
                        </div>
                        {(() => {
                          const detail =
                            account.runtimeId ?? account.credentialName ?? "Credential only";
                          // The label is usually the account email, and repeating it verbatim
                          // on a second line just costs a row.
                          return detail === account.label ? null : (
                            <span title={detail}>{detail}</span>
                          );
                        })()}
                      </div>
                    </div>
                    <div className="account-actions">
                      <Button
                        disabled={!account.runtimeId || pending !== ""}
                        onClick={() => void runAccountAction("warm", account)}
                      >
                        <Sparkles size={14} />
                        {pending === `warm:${account.id}` ? "Warming…" : "Warm up"}
                      </Button>
                      <Button
                        aria-label="Refresh quota"
                        disabled={!account.runtimeId || pending !== ""}
                        onClick={() => void refresh()}
                      >
                        <RefreshCw size={14} /> Refresh
                      </Button>
                      {account.canReset ? (
                        <Button
                          disabled={!account.runtimeId || pending !== ""}
                          onClick={() => void runAccountAction("reset", account)}
                        >
                          <RotateCcw size={14} />
                          {pending === `reset:${account.id}` ? "Resetting…" : "Reset window"}
                        </Button>
                      ) : null}
                      {account.credentialName ? (
                        <>
                          <Button
                            aria-label={`Re-authenticate ${account.label}`}
                            disabled={pending !== ""}
                            onClick={() => void reauthenticate(account)}
                          >
                            {pending === `auth:${account.provider}` ? "Starting…" : "Re-auth"}
                          </Button>
                          {confirmRemove === account.id ? (
                            <>
                              <Button
                                aria-label={`Confirm removing ${account.label}`}
                                disabled={pending !== ""}
                                onClick={() => void removeCredential(account)}
                              >
                                <Trash2 size={14} />
                                {pending === `remove:${account.id}` ? "Removing…" : "Confirm"}
                              </Button>
                              <Button
                                aria-label={`Cancel removing ${account.label}`}
                                onClick={() => setConfirmRemove("")}
                              >
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <Button
                              aria-label={`Remove ${account.label}`}
                              disabled={pending !== ""}
                              onClick={() => setConfirmRemove(account.id)}
                            >
                              <Trash2 size={14} /> Remove
                            </Button>
                          )}
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="usage-section">
                    {quotaRows(account).length ? (
                      <div className="quota-list">
                        {quotaRows(account).map((row, index, list) => {
                          const remaining = Math.max(0, 100 - row.usedPercent);
                          const startsGroup =
                            row.group !== null && row.group !== list[index - 1]?.group;
                          return (
                            <Fragment key={`${row.group ?? ""}-${row.name}-${index}`}>
                              {startsGroup ? <div className="quota-group">{row.group}</div> : null}
                              <div className="quota-row">
                                <span className="quota-name">{row.name}</span>
                                <span className="quota-track">
                                  <i style={{ width: `${Math.min(100, remaining)}%` }} />
                                </span>
                                <span className="quota-meta">
                                  <strong>{formatQuotaPercent(remaining)}%</strong>
                                  {row.resetSeconds !== null ? (
                                    <small>{formatResetTime(row.resetSeconds)}</small>
                                  ) : null}
                                </span>
                              </div>
                            </Fragment>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="quota-empty">Not reported by provider</div>
                    )}
                  </div>
                  {account.lastError ? (
                    <div className="account-error">
                      <AlertTriangle size={14} />
                      {account.lastError.message || `HTTP ${account.lastError.status}`}
                    </div>
                  ) : null}
                  {!account.runtimeId ? (
                    <div className="restart-note">
                      Credential saved but the gateway could not load it into the runtime pool.
                    </div>
                  ) : null}
                </Card>
              ))}
            </div>
            {!visibleAccounts.length ? (
              <div className="state-panel">
                {accounts.length
                  ? "No accounts match this filter."
                  : "No accounts or credentials found."}
              </div>
            ) : null}
          </div>
        ) : null}

        {surface === "logs" ? (
          <div className="content logs-surface">
            <header className="logs-header">
              <div>
                <h2>Gateway logs</h2>
                <p>Raw server output, not a reconstructed request history.</p>
              </div>
            </header>
            {logsError ? <div className="state-panel warning">{logsError}</div> : null}
            <pre>{logs.length ? logs.join("\n") : "No log lines returned."}</pre>
          </div>
        ) : null}

        {surface === "settings" ? (
          <div className="content settings">
            {notice ? (
              <output className={notice.startsWith("Action failed") ? "notice danger" : "notice"}>
                {notice}
              </output>
            ) : null}
            <Card className="gateway-process-card">
              <div>
                <h2>Gateway process</h2>
                <p>Starts automatically with Mahoquot. Stop or restart it explicitly here.</p>
              </div>
              <div className="gateway-process-action">
                <Badge tone={gatewayLifecycle === "running" ? "ok" : "neutral"}>
                  {gatewayLifecycle === "running" ? "Running" : "Stopped"}
                </Badge>
                <Button disabled={pending !== ""} onClick={() => void toggleGateway()}>
                  {pending === "gateway:lifecycle"
                    ? "Working…"
                    : gatewayLifecycle === "running"
                      ? "Stop gateway"
                      : "Start gateway"}
                </Button>
              </div>
            </Card>
            <Card className="settings-card">
              <header className="settings-card-head">
                <div className={`connection-orb ${loadState}`}>
                  <Network size={18} />
                </div>
                <div>
                  <h2>Connection & access</h2>
                  <p>{baseUrl || "Same-origin gateway"}</p>
                </div>
              </header>
              <div className="connection-fields">
                <Field
                  label="Gateway URL"
                  hint="Blank uses the current origin. Desktop defaults to http://127.0.0.1:18801."
                >
                  <Input
                    aria-label="Gateway URL"
                    aria-invalid={gatewayUrlError !== null}
                    value={baseUrl}
                    placeholder="http://127.0.0.1:18801"
                    onChange={(event) => {
                      setBaseUrlState(event.target.value);
                      setGatewayUrlError(null);
                    }}
                  />
                  {gatewayUrlError ? (
                    <small className="field-error">{gatewayUrlError}</small>
                  ) : null}
                </Field>
                <Field
                  label="API key"
                  hint="Proxy access, telemetry, credentials, logs, and configuration."
                >
                  <div className="secret-input-row">
                    <Input
                      aria-label="API key"
                      type="password"
                      value={relayKey}
                      onChange={(event) => setRelayKeyState(event.target.value)}
                      onBlur={() => setRelayKey(relayKey)}
                    />
                    <Button
                      aria-label="Copy API key"
                      disabled={!relayKey}
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(relayKey)
                          .then(() => setNotice("API key copied."))
                          .catch(() => setNotice("Action failed: clipboard unavailable"));
                      }}
                    >
                      <Copy size={14} /> Copy
                    </Button>
                  </div>
                </Field>
              </div>
              <div className="connection-actions">
                <span>Connection changes apply to this console immediately.</span>
                <Button
                  onClick={() => {
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
                >
                  Save & reconnect
                </Button>
              </div>
            </Card>
            <Card className="settings-card">
              <header className="settings-card-head">
                <div className="settings-icon">
                  <Route size={17} />
                </div>
                <div>
                  <h2>Proxy behavior</h2>
                  <p>How requests route across accounts, retry, and log.</p>
                </div>
                <Badge tone="warn">Saved changes require restart</Badge>
              </header>
              <div className="proxy-settings-grid">
                <Field
                  label="Routing strategy"
                  hint="Failover only before the first response byte; cooldowns follow provider direction."
                >
                  <select
                    className="input"
                    aria-label="Routing strategy"
                    value={routingStrategy}
                    onChange={(event) => setRoutingStrategy(event.target.value)}
                  >
                    <option value="round-robin">Round robin</option>
                    <option value="weighted-round-robin">Weighted round robin</option>
                    <option value="fill-first">Fill first</option>
                  </select>
                </Field>
                <Field label="Request retry count" hint="Non-negative attempts before failure.">
                  <Input
                    aria-label="Request retry count"
                    type="number"
                    min="0"
                    step="1"
                    value={requestRetry}
                    onChange={(event) => setRequestRetry(event.target.value)}
                  />
                </Field>
                <Field label="Upstream proxy URL" hint="Leave blank to connect directly.">
                  <Input
                    aria-label="Upstream proxy URL"
                    value={proxyUrl}
                    placeholder="http://127.0.0.1:7890"
                    onChange={(event) => setProxyUrl(event.target.value)}
                  />
                </Field>
                <label className="toggle-field">
                  <input
                    aria-label="Write logs to file"
                    type="checkbox"
                    checked={loggingToFile}
                    onChange={(event) => setLoggingToFile(event.target.checked)}
                  />
                  <span>
                    <strong>Write logs to file</strong>
                    <small>Persist gateway diagnostics for the log viewer.</small>
                  </span>
                </label>
              </div>
              <div className="connection-actions">
                <span>Saved values persist immediately.</span>
                <Button disabled={pending !== ""} onClick={() => void saveProxySettings()}>
                  {pending === "settings:save" ? "Saving…" : "Save proxy settings"}
                </Button>
              </div>
            </Card>
            <Card className="settings-card">
              <header className="settings-card-head">
                <div className="settings-icon">
                  <Settings2 size={17} />
                </div>
                <div>
                  <h2>Appearance</h2>
                  <p>Choose the color scheme for this console.</p>
                </div>
              </header>
              <Field label="Theme" hint="Saved on this device and applied to the entire console.">
                <select
                  aria-label="Theme"
                  className="input"
                  value={theme}
                  onChange={(event) => {
                    const nextTheme = event.currentTarget.value === "light" ? "light" : "dark";
                    persistTheme(nextTheme);
                    setTheme(nextTheme);
                  }}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </Field>
            </Card>
            <Card className="settings-card advanced-card">
              <header className="settings-card-head">
                <div className="settings-icon">
                  <TerminalSquare size={17} />
                </div>
                <div>
                  <h2>Advanced YAML</h2>
                  <p>
                    Edit the complete persisted gateway configuration. The document may contain
                    secrets.
                  </p>
                </div>
                <Button disabled={pending !== ""} onClick={() => void openConfigEditor()}>
                  {pending === "config:load" ? "Loading…" : "Open YAML editor"}
                </Button>
              </header>
            </Card>
          </div>
        ) : null}
      </main>

      {onboardingOpen ? (
        <div className="drawer-backdrop">
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
            {zcodeForm ? (
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
                  <strong>{openMethods.name}</strong>
                </div>
                {openMethods.methods.map((method) => (
                  <button
                    type="button"
                    key={method.id}
                    className="provider-method"
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
              </div>
            ) : (
              <div className="provider-options">
                {ONBOARDING_PROVIDERS.map((provider) => {
                  const owned = accounts.filter(
                    (account) => account.provider === provider.glyph,
                  ).length;
                  const only = provider.methods.length === 1 ? provider.methods[0] : null;
                  return (
                    <button
                      type="button"
                      key={provider.glyph}
                      disabled={pending !== ""}
                      onClick={() =>
                        only ? void beginOnboarding(only.id) : setOpenMethods(provider)
                      }
                    >
                      <span className="provider-option-icon" aria-hidden="true">
                        <ProviderGlyph provider={provider.glyph} />
                        {owned ? <i className="provider-option-count">{owned}</i> : null}
                      </span>
                      <span className="provider-option-label">
                        {only && pending === `auth:${only.id}` ? "Starting…" : provider.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {authorization ? (
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
          </aside>
        </div>
      ) : null}
      {configOpen ? (
        <div className="drawer-backdrop">
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
        </div>
      ) : null}
      <ContextMenu menu={menu} onClose={closeMenu} />
    </div>
  );
}

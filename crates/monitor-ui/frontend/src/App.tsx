import {
  AlertTriangle,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleGauge,
  Copy,
  KeyRound,
  Moon,
  Network,
  RefreshCw,
  RotateCcw,
  Route,
  Settings2,
  Sparkles,
  Sun,
  TerminalSquare,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import antigravityLogo from "./assets/provider-logos/antigravity.svg";
import claudeLogo from "./assets/provider-logos/claude.svg";
import codexLogo from "./assets/provider-logos/codex.svg";
import cursorLogo from "./assets/provider-logos/cursor.svg";
import kiroLogo from "./assets/provider-logos/kiro.svg";
import { OverviewDashboard } from "./components/OverviewDashboard";
import { Badge, Button, Card, Field, Input } from "./components/ui";
import {
  type NormalizedAccount,
  formatResetTime,
  mergeAccountsAndCredentials,
} from "./lib/accounts";
import { GatewayError, createGatewayClients } from "./lib/api";
import type { ProviderAuthStatus } from "./lib/api";
import {
  type GatewayLifecycleStatus,
  getGatewayLifecycle,
  startManagedGateway,
  stopManagedGateway,
} from "./lib/native";
import type { AdminStats, AuthFileItem } from "./lib/schemas";
import {
  getGatewayBaseUrl,
  getRelayKey,
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
  readonly usedPercent: number;
  readonly resetSeconds: number | null;
};

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
                name:
                  bucket.display_name || group.display_name || group.models || `Quota ${index + 1}`,
                usedPercent: bucket.used_percent,
                resetSeconds: resetSeconds(bucket.reset_at_unix, bucket.reset_after_seconds),
              },
            ]
          : [],
      ),
    ) ?? [];
  if (grouped.length) return grouped;
  return [
    usage.primary && typeof usage.primary.used_percent === "number"
      ? {
          name: usage.primary.limit_name || "Primary window",
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
          usedPercent: usage.secondary.used_percent,
          resetSeconds: resetSeconds(
            usage.secondary.reset_at_unix,
            usage.secondary.reset_after_seconds,
          ),
        }
      : null,
  ].filter((row): row is QuotaRow => row !== null);
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
  kiro: kiroLogo,
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
        normalized === "cursor" ? "provider-logo provider-logo-monochrome" : "provider-logo"
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

export default function App() {
  const [surface, setSurface] = useState<Surface>(getInitialSurface);
  const [notchExpanded, setNotchExpanded] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
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
    try {
      const [nextCredentials, nextLogs] = await Promise.all([
        clients.management.credentials(),
        clients.management.logs(),
      ]);
      setCredentials(nextCredentials);
      setLogs(nextLogs.lines);
    } catch {
      setCredentials([]);
      setLogs([]);
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
      setNotice("Credential removed — restart required to rebuild the runtime pool.");
      await refresh();
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
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
    setPending(`order:${account.id}`);
    setNotice("");
    try {
      await clients.management.saveCredentialOrder(names);
      setCredentials(
        [...credentials].sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name)),
      );
      setNotice("Account order saved — restart required to update runtime routing order.");
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
        setNotice("Claude Code subscription imported — gateway restart required.");
        await refresh();
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
      setNotice("Authorization pending. Approve in the provider window, then check status here.");
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

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
        setNotice("Authorization pending. Complete approval, then check again.");
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
      setNotice("Proxy settings saved — restart required for runtime-affecting changes.");
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
      setNotice("Configuration saved — restart required for runtime-affecting changes.");
      setConfigOpen(false);
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  if (surface === "notch") {
    return (
      <div className="notch-shell" data-mahoquot-surface="notch">
        <div
          className={`notch-hover-zone${notchExpanded ? " expanded" : ""}`}
          onMouseEnter={() => setNotchExpanded(true)}
          data-testid="notch-hover-zone"
        />
        <div
          className={`notch-surface${notchExpanded ? " expanded" : ""}`}
          onMouseLeave={() => setNotchExpanded(false)}
        >
          {!notchExpanded ? (
            <div className="notch-compact-row">
              <span className={`status-dot ${loadState === "online" ? "online" : ""}`} />
              <strong>Quotio</strong>
              {accounts.length ? (
                <span className="notch-compact-count">{accounts.length}</span>
              ) : null}
            </div>
          ) : loadState === "online" && accounts.length ? (
            accounts.map((account) => {
              const rows = quotaRows(account);
              const usedPct = rows[0]?.usedPercent ?? null;
              const clamped = usedPct === null ? 0 : Math.min(100, Math.max(0, usedPct));
              const color = providerRingColor(account.provider);
              return (
                <div
                  className="notch-ring-item"
                  key={account.id}
                  data-provider={account.provider}
                  data-testid={`notch-ring-${account.provider}`}
                >
                  <div className="notch-ring-wrap">
                    <svg
                      className="notch-ring"
                      viewBox="0 0 56 56"
                      width="56"
                      height="56"
                      aria-hidden="true"
                    >
                      <circle className="notch-ring-track" cx="28" cy="28" r="24" />
                      <circle
                        className="notch-ring-fill"
                        cx="28"
                        cy="28"
                        r="24"
                        stroke={color}
                        strokeDasharray={163.36}
                        strokeDashoffset={163.36 * (1 - clamped / 100)}
                        transform="rotate(-90 28 28)"
                      />
                    </svg>
                    <span className="notch-ring-logo">
                      <ProviderGlyph provider={account.provider} />
                    </span>
                  </div>
                  <span className="notch-ring-pct">
                    {usedPct === null ? "—" : `${Math.round(usedPct)}%`}
                  </span>
                  <div
                    className="notch-tooltip"
                    role="tooltip"
                    data-testid={`notch-tooltip-${account.provider}`}
                  >
                    <div className="notch-tooltip-head">
                      <ProviderGlyph provider={account.provider} />
                      <strong className="capitalize">{account.provider}</strong>
                    </div>
                    {rows.slice(0, 2).map((row, index) => (
                      <div className="notch-tooltip-row" key={`${row.name}-${index}`}>
                        <div className="notch-tooltip-label">{row.name}</div>
                        <div className="notch-tooltip-bar">
                          <i
                            style={{
                              width: `${Math.min(100, Math.max(0, row.usedPercent))}%`,
                              background: index === 0 ? color : "var(--ok)",
                            }}
                          />
                        </div>
                        <div className="notch-tooltip-meta">
                          <span>{formatQuotaPercent(row.usedPercent)}% Used</span>
                          <small>
                            Resets{" "}
                            {row.resetSeconds === null
                              ? "later"
                              : formatResetTime(row.resetSeconds)}
                          </small>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="notch-empty-ring" data-testid="notch-empty-ring">
              <div className="notch-ring-wrap">
                <svg
                  className="notch-ring"
                  viewBox="0 0 56 56"
                  width="56"
                  height="56"
                  aria-hidden="true"
                >
                  <circle className="notch-ring-track" cx="28" cy="28" r="24" />
                </svg>
                <span className="notch-ring-logo">
                  <strong>Q</strong>
                </span>
              </div>
              <div className="notch-tooltip" role="tooltip" data-testid="notch-tooltip-empty">
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
      </div>
    );
  }

  return (
    <div className="app" data-mahoquot-app="operations-console">
      <aside className="sidebar">
        <div className="brand">
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
        <header className="topbar">
          <div>
            <h1>{surface.charAt(0).toUpperCase() + surface.slice(1)}</h1>
          </div>
          <div className="top-actions">
            <Button aria-label="Refresh snapshot" onClick={() => void refresh()}>
              <RefreshCw size={15} /> Refresh
            </Button>
            <Button
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </Button>
          </div>
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
            <div className="account-list">
              {visibleAccounts.map((account) => (
                <Card key={account.id} className="account-card">
                  <div className="account-card-head">
                    <div className="account-title">
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
                        <span title={account.runtimeId ?? account.credentialName ?? ""}>
                          {account.runtimeId ?? account.credentialName ?? "Credential only"}
                        </span>
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
                            aria-label={`Move ${account.label} up`}
                            disabled={
                              pending !== "" || credentials[0]?.name === account.credentialName
                            }
                            onClick={() => void moveCredential(account, -1)}
                          >
                            <ChevronUp size={14} />
                          </Button>
                          <Button
                            aria-label={`Move ${account.label} down`}
                            disabled={
                              pending !== "" || credentials.at(-1)?.name === account.credentialName
                            }
                            onClick={() => void moveCredential(account, 1)}
                          >
                            <ChevronDown size={14} />
                          </Button>
                          <Button disabled={pending !== ""} onClick={() => setOnboardingOpen(true)}>
                            Re-auth
                          </Button>
                          <Button
                            aria-label={`Remove ${account.label}`}
                            disabled={pending !== ""}
                            onClick={() => void removeCredential(account)}
                          >
                            <Trash2 size={14} />
                            {pending === `remove:${account.id}` ? "Removing…" : "Remove"}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="usage-section">
                    <span className="usage-label">USAGE</span>
                    {quotaRows(account).length ? (
                      <div className="quota-list">
                        {quotaRows(account).map((row, index) => {
                          const remaining = Math.max(0, 100 - row.usedPercent);
                          return (
                            <div className="quota-row" key={`${row.name}-${index}`}>
                              <div className="quota-row-head">
                                <span>
                                  <Sparkles size={13} /> {row.name}
                                </span>
                                <div>
                                  <strong>{formatQuotaPercent(remaining)}%</strong>
                                  {row.resetSeconds !== null ? (
                                    <small>{formatResetTime(row.resetSeconds)}</small>
                                  ) : null}
                                </div>
                              </div>
                              <div className="quota-track">
                                <i style={{ width: `${Math.min(100, remaining)}%` }} />
                              </div>
                            </div>
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
                      Credential saved but not in the runtime pool — restart required.
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
            <Card className="onboarding">
              <BookOpenText />
              <div>
                <h2>Provider onboarding</h2>
                <p>
                  Add or re-authenticate provider credentials here. Saved credential changes require
                  a gateway restart before they enter the runtime pool.
                </p>
              </div>
              <Button onClick={() => setOnboardingOpen(true)}>Start onboarding</Button>
            </Card>
          </div>
        ) : null}

        {surface === "logs" ? (
          <div className="content logs-surface">
            <header className="logs-header">
              <div>
                <h2>Gateway logs</h2>
                <p>Raw server output, not a reconstructed request history.</p>
              </div>
              <Button onClick={() => void refresh()}>
                <RefreshCw size={14} /> Refresh
              </Button>
            </header>
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
                <span className="kicker">CREDENTIAL LIFECYCLE</span>
                <h2>Add or re-authenticate</h2>
              </div>
              <Button aria-label="Close onboarding" onClick={() => setOnboardingOpen(false)}>
                <X />
              </Button>
            </div>
            <p>
              Select a provider to begin its gateway-managed authorization flow. This console will
              not claim success until the credential appears in the management inventory.
            </p>
            <div className="provider-options">
              {(
                [
                  ["codex", "Codex / OpenAI"],
                  ["antigravity", "Antigravity / Gemini"],
                  ["claude", "Claude OAuth"],
                  ["claude-local", "Import Claude Code subscription"],
                  ["kiro", "Kiro"],
                  ["cursor", "Cursor"],
                ] as const
              ).map(([id, name]) => (
                <button
                  type="button"
                  key={id}
                  disabled={pending !== ""}
                  onClick={() => void beginOnboarding(id)}
                >
                  <span className="provider-option-label">
                    <span className="provider-tab-icon">
                      <ProviderGlyph provider={id === "claude-local" ? "claude" : id} />
                    </span>
                    {pending === `auth:${id}` ? "Starting…" : name}
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
            {authorization ? (
              <div className="authorization-status">
                <div>
                  <strong>{providerLabel(authorization.provider)} authorization</strong>
                  <span>
                    {authorization.status === "ok"
                      ? "Completed"
                      : authorization.status === "error"
                        ? (authorization.error ?? "Failed")
                        : "Pending provider approval"}
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
            <div className="restart-note">
              New or changed credentials are saved immediately but require a gateway restart before
              joining the runtime pool.
            </div>
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
            <div className="restart-note">
              Saved configuration is persisted immediately; runtime-affecting changes require a
              gateway restart.
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

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

type Surface = "overview" | "accounts" | "settings" | "notch";
type LoadState = "loading" | "online" | "offline" | "relay-locked";

const getInitialSurface = (): Surface => {
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("surface");
    if (param === "notch") return "notch";
    if (param === "accounts" || param === "settings" || param === "overview") return param;
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

const latencyP50 = (stats: AdminStats): number | null => {
  if (typeof stats.ttft === "number") return stats.ttft;
  if (
    stats.ttft &&
    typeof stats.ttft === "object" &&
    typeof stats.ttft.p50_ms === "number" &&
    stats.ttft.p50_ms > 0
  ) {
    return stats.ttft.p50_ms;
  }
  return null;
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
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [baseUrl, setBaseUrlState] = useState(getGatewayBaseUrl());
  const [relayKey, setRelayKeyState] = useState(getRelayKey());
  const [stats, setStats] = useState<AdminStats>(emptyStats);
  const [credentials, setCredentials] = useState<readonly AuthFileItem[]>([]);
  const [logs, setLogs] = useState<readonly string[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [logsOpen, setLogsOpen] = useState(false);
  const [provider, setProvider] = useState(
    () => window.sessionStorage.getItem("quotio.provider") ?? "all",
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
        const restored = samples.length
          ? samples
          : persistedTelemetrySamples(nextStats.history ?? []);
        return appendTelemetrySample(restored, nextStats, Date.now());
      });
      setLoadState("online");
      firstLoad.current = false;
    } catch (error) {
      setLoadState(
        error instanceof GatewayError && error.status === 401 ? "relay-locked" : "offline",
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
  }, [clients]);

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
    window.sessionStorage.setItem("quotio.provider", provider);
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
      <div className="notch-shell" data-quotio-surface="notch">
        <div className="notch-surface">
          <header className="notch-summary" data-testid="notch-summary" data-component="summary">
            <div className="notch-summary-brand">
              <span className={`status-dot ${loadState === "online" ? "online" : ""}`} />
              <strong className="notch-summary-title">Quotio</strong>
              <Badge tone={loadState === "online" ? "ok" : "bad"}>
                {loadState === "online" ? "Online" : loadState.replace("-", " ")}
              </Badge>
            </div>
            {loadState === "online" ? (
              <div className="notch-summary-stats">
                <span>{stats.in_flight} active</span>
                <span>•</span>
                <span>{stats.served} served</span>
                {(() => {
                  const p50 = latencyP50(stats);
                  return p50 !== null ? (
                    <>
                      <span>•</span>
                      <span>{Math.round(p50)}ms</span>
                    </>
                  ) : null;
                })()}
              </div>
            ) : null}
          </header>

          {loadState === "online" ? (
            <div className="notch-accounts-list">
              {accounts.length ? (
                accounts.map((account) => {
                  const rows = quotaRows(account);
                  const primaryQuota = rows[0];
                  const usedPct = primaryQuota?.usedPercent ?? null;
                  const resetSec =
                    primaryQuota?.resetSeconds ?? account.cooldownRemainingSecs ?? null;
                  const isWarn = usedPct !== null && usedPct >= 70 && usedPct < 90;
                  const isBad =
                    account.health === "error" ||
                    account.health === "cooldown" ||
                    (usedPct !== null && usedPct >= 90);

                  return (
                    <div className="notch-account-row" key={account.id}>
                      <div className="notch-account-icon">
                        <ProviderGlyph provider={account.provider} />
                      </div>
                      <div className="notch-account-info">
                        <span className="notch-account-id" title={account.id}>
                          {account.id}
                        </span>
                        <div className="notch-account-meta">
                          <span className="capitalize">{account.provider}</span>
                          {resetSec !== null && resetSec > 0 ? (
                            <>
                              <span>•</span>
                              <span>reset {formatResetTime(resetSec)}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="notch-account-status">
                        {usedPct !== null ? (
                          <div className="notch-account-usage">
                            <span className="notch-account-usage-pct">
                              {formatQuotaPercent(usedPct)}%
                            </span>
                            <div className="notch-account-usage-track">
                              <i
                                className={`notch-account-usage-fill ${isBad ? "bad" : isWarn ? "warn" : ""}`}
                                style={{ width: `${Math.min(100, Math.max(0, usedPct))}%` }}
                              />
                            </div>
                          </div>
                        ) : null}
                        <HealthBadge account={account} />
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="notch-empty">No accounts connected</div>
              )}
            </div>
          ) : (
            <div className="notch-offline-state">
              <AlertTriangle size={18} />
              <span>
                {loadState === "relay-locked"
                  ? "Relay key required to access gateway telemetry"
                  : "Gateway offline — waiting for connection"}
              </span>
              <Button onClick={() => void refresh()} aria-label="Retry connection">
                <RefreshCw size={13} /> Reconnect
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-quotio-app="operations-console">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Q</span>
          <div>
            <strong>Quotio</strong>
            <small>Operations console</small>
          </div>
        </div>
        <nav aria-label="Primary navigation">
          {(
            [
              ["overview", CircleGauge, "Overview"],
              ["accounts", Users, "Accounts"],
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
        <div className="sidebar-foot">
          <span className={`status-dot ${loadState}`} />
          {loadState === "online" ? "Gateway connected" : loadState.replace("-", " ")}
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">LOCAL GATEWAY</p>
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
          {(["overview", "accounts", "settings"] as const).map((item) => (
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

        {loadState === "loading" ? (
          <div className="state-panel">Loading live gateway snapshot…</div>
        ) : null}
        {loadState === "offline" ? (
          <div className="state-panel danger">
            <AlertTriangle /> Gateway offline. Update the address in Settings, then reconnect.
          </div>
        ) : null}
        {loadState === "relay-locked" ? (
          <div className="state-panel warning">
            <KeyRound /> API key required to load gateway telemetry and management data.
          </div>
        ) : null}

        {surface === "overview" ? (
          <OverviewDashboard
            stats={stats}
            samples={telemetry}
            online={loadState === "online"}
            onOpenLogs={() => setLogsOpen(true)}
          />
        ) : null}

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

        {surface === "settings" ? (
          <div className="content settings">
            <div className="settings-header">
              <div>
                <span className="kicker">OPERATIONS</span>
                <h2>Connection & access</h2>
                <p>
                  Connect this console to the gateway with one API key for proxy and management
                  access.
                </p>
              </div>
              <Badge tone={loadState === "online" ? "ok" : "bad"}>
                {loadState === "online" ? "Connected" : "Disconnected"}
              </Badge>
            </div>
            <Card className="connection-card">
              <div className="connection-summary">
                <div className={`connection-orb ${loadState}`}>
                  <Network size={18} />
                </div>
                <div>
                  <strong>
                    {loadState === "online" ? "Gateway connected" : "Gateway unavailable"}
                  </strong>
                  <span>{baseUrl || "Same-origin gateway"}</span>
                </div>
                <Button onClick={() => void refresh()}>
                  <RefreshCw size={14} /> Test connection
                </Button>
              </div>
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
            <div className="settings-workbench">
              <Card className="settings-section">
                <div className="settings-section-title">
                  <div className="settings-icon">
                    <RotateCcw size={17} />
                  </div>
                  <div>
                    <h2>Routing policy</h2>
                    <p>How requests move across healthy accounts.</p>
                  </div>
                </div>
                <dl className="settings-facts">
                  <div>
                    <dt>Strategy</dt>
                    <dd>Strict round robin</dd>
                  </div>
                  <div>
                    <dt>Failover boundary</dt>
                    <dd>Before first response byte</dd>
                  </div>
                  <div>
                    <dt>Account cooldown</dt>
                    <dd>Provider-directed</dd>
                  </div>
                </dl>
                <Badge tone="warn">Saved changes require restart</Badge>
              </Card>
              <Card className="settings-section">
                <div className="settings-section-title">
                  <div className="settings-icon">
                    <TerminalSquare size={17} />
                  </div>
                  <div>
                    <h2>Runtime & logging</h2>
                    <p>Network listener and diagnostic output.</p>
                  </div>
                </div>
                <dl className="settings-facts">
                  <div>
                    <dt>Gateway port</dt>
                    <dd>18801</dd>
                  </div>
                  <div>
                    <dt>Logs</dt>
                    <dd>Available from Overview</dd>
                  </div>
                  <div>
                    <dt>Runtime config</dt>
                    <dd>Loaded at process start</dd>
                  </div>
                </dl>
                <Badge tone="warn">Saved changes require restart</Badge>
              </Card>
            </div>
            <Card className="proxy-settings-card">
              <div className="settings-section-title">
                <div className="settings-icon">
                  <Network size={17} />
                </div>
                <div>
                  <h2>Proxy behavior</h2>
                  <p>Edit common routing and diagnostic settings without raw YAML.</p>
                </div>
              </div>
              <div className="proxy-settings-grid">
                <Field label="Upstream proxy URL" hint="Leave blank to connect directly.">
                  <Input
                    aria-label="Upstream proxy URL"
                    value={proxyUrl}
                    placeholder="http://127.0.0.1:7890"
                    onChange={(event) => setProxyUrl(event.target.value)}
                  />
                </Field>
                <Field label="Routing strategy" hint="Applied to persisted gateway routing.">
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
                <span>
                  Saved values persist immediately; runtime-affecting changes require restart.
                </span>
                <Button disabled={pending !== ""} onClick={() => void saveProxySettings()}>
                  {pending === "settings:save" ? "Saving…" : "Save proxy settings"}
                </Button>
              </div>
            </Card>
            <Card className="advanced-row">
              <div>
                <span className="kicker">ADVANCED</span>
                <h2>Advanced YAML</h2>
                <p>
                  Edit the complete persisted gateway configuration. The document may contain
                  secrets.
                </p>
              </div>
              <Button disabled={pending !== ""} onClick={() => void openConfigEditor()}>
                {pending === "config:load" ? "Loading…" : "Open YAML editor"}
              </Button>
            </Card>
            {notice ? <output className="notice">{notice}</output> : null}
          </div>
        ) : null}
      </main>

      {logsOpen ? (
        <div className="drawer-backdrop">
          <aside className="drawer" aria-label="Gateway logs">
            <div className="section-head">
              <div>
                <span className="kicker">RAW LOG STREAM</span>
                <h2>Gateway logs</h2>
              </div>
              <Button aria-label="Close logs" onClick={() => setLogsOpen(false)}>
                <X />
              </Button>
            </div>
            <p className="drawer-caveat">Raw server output, not a reconstructed request history.</p>
            <pre>{logs.length ? logs.join("\n") : "No log lines returned."}</pre>
          </aside>
        </div>
      ) : null}
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

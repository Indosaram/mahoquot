import { ArrowDown, ArrowUp, Copy, ListOrdered, Network, Route, Settings2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSettingsScalarsStatus } from "../hooks/useConnectionSettings";
import type { HistoryStatsQuery } from "../lib/api";
import { UNAVAILABLE_LABEL, nonCachedInputTokens } from "../lib/cache-usage";
import { cn } from "../lib/cn";
import type {
  GatewayLifecycleStatus,
  NativeSettingsState,
  SecretStoreError,
  TunnelStatus,
  UpdateStatus,
} from "../lib/native";
import { blocks } from "../lib/pending";
import { normalizeToQuotioProviderId } from "../lib/provider-catalog";
import type {
  HistoryHealth,
  HistoryStatsResponse,
  ModelPrice,
  ModelRegistryStatus,
  SchedulerSettings,
  SchedulerStatus,
} from "../lib/schemas";
import type {
  GatewayModelEntry,
  ProviderProxyPolicy,
  ProxyProvidersMap,
  ScopedApiKey,
} from "../lib/schemas";
import {
  SETTINGS_CARD_SELECTOR,
  matchesSettingsQuery,
  settingsQueryTokens,
} from "../lib/settings-filter";
import { CLINE_QUOTA_DISPLAY_DEFAULT } from "../lib/storage";
import { SharedKeysCard } from "./SharedKeysCard";
import { TunnelCard } from "./TunnelCard";
import { OverlayLayer } from "./layout";
import { Badge, Button, Card, Field, Input } from "./ui";

const EMPTY_MODEL_PRICES: readonly ModelPrice[] = [];

/** Survives this surface unmounting when the console switches destination. */
let rememberedScrollTop: number | null = null;

/** A price draft is saveable only when it parses to a finite, non-negative rate. */
const parsePriceDraft = (text: string): number | null => {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

// Transient upstream conditions are operational, not actionable config errors.
const TRANSIENT_REJECTION =
  /\b(429|5\d\d)\b|rate.?limit|timed? ?out|timeout|network|connect|unavailable|temporar|unreachable/i;

const describeCatalogSource = (source: ModelRegistryStatus["source"]): string => {
  switch (source) {
    case "remote_signed":
      return "remote signed catalog";
    case "lkg_cache":
      return "cached catalog";
    case "embedded_fallback":
      return "bundled fallback catalog";
    case "discovered":
      return "discovered catalog";
    case "local_override":
      return "local override catalog";
    default:
      return "active catalog";
  }
};

function ModelPriceEstimate({ value }: { readonly value: number | null }) {
  return value === null ? (
    <strong className="unavailable">{UNAVAILABLE_LABEL}</strong>
  ) : (
    <strong>${value.toFixed(2)}</strong>
  );
}

export interface SettingsSurfaceProps {
  readonly gatewayLifecycle: GatewayLifecycleStatus;
  readonly pending: string;
  readonly loadState: "loading" | "online" | "starting" | "stopped" | "relay-locked";
  readonly baseUrl: string;
  readonly gatewayUrlError?: string | null | undefined;
  readonly relayKey: string;
  readonly secretStoreError: SecretStoreError | null;
  readonly routingStrategy: string;
  readonly requestRetry: string;
  readonly proxyUrl: string;
  readonly proxyProviders?: ProxyProvidersMap;
  readonly onUpdateProxyProviderPolicy?: (
    provider: string,
    patch: Partial<ProviderProxyPolicy>,
  ) => void;
  readonly loggingToFile: boolean;
  readonly codexFastMode: boolean;
  readonly theme: "dark" | "light";
  readonly showRemaining: boolean;
  readonly onShowRemainingChange: (value: boolean) => void;
  /** Bare slugs of Cline models whose daily bucket renders (App-owned pref). */
  readonly clineQuotaDisplay?: readonly string[] | undefined;
  readonly onClineQuotaDisplayChange?: (slugs: readonly string[]) => void;
  /** Renderable choices: Cline's live model list plus buckets this gateway served. */
  readonly clineQuotaCandidates?:
    | readonly { readonly slug: string; readonly label: string }[]
    | undefined;
  readonly onToggleGateway: () => void | Promise<void>;
  readonly nativeSettings?: NativeSettingsState | null;
  readonly nativeSettingsBusy?: boolean;
  readonly onLoginStartChange?: (enabled: boolean) => void | Promise<void>;
  readonly onRequestNotificationPermission?: () => void | Promise<void>;
  readonly updateStatus?: UpdateStatus | null;
  readonly updateBusy?: boolean;
  readonly onCheckUpdate?: () => void;
  readonly onInstallUpdate?: () => void;
  readonly onBaseUrlChange: (value: string) => void;
  readonly onRelayKeyChange: (value: string) => void;
  readonly onRelayKeyBlur: () => void;
  readonly onRetrySecretStore: () => void;
  readonly onCopyRelayKey: () => void;
  readonly onSaveConnection: () => void;
  readonly scopedKeys?: readonly ScopedApiKey[];
  readonly availableModels?: readonly GatewayModelEntry[];
  readonly availableAccounts?: readonly { id: string; provider: string }[];
  readonly onCreateScopedKey?: (payload: {
    readonly name: string;
    readonly allowed_providers?: readonly string[];
    readonly allowed_accounts?: readonly string[];
    readonly allowed_models?: readonly string[];
    readonly token_limit?: number;
    readonly expires_at_ms?: number | null;
  }) => Promise<{ api_key: string; key: ScopedApiKey }>;
  readonly onPatchScopedKey?: (
    id: string,
    payload: {
      readonly token_limit?: number;
      readonly is_active?: boolean;
      readonly name?: string;
    },
  ) => Promise<void>;
  readonly onDeleteScopedKey?: (id: string) => Promise<void>;
  readonly onRefreshScopedKeys?: () => Promise<void>;
  readonly onRoutingStrategyChange: (value: string) => void;
  readonly onRequestRetryChange: (value: string) => void;
  readonly onProxyUrlChange: (value: string) => void;
  readonly onLoggingToFileChange: (value: boolean) => void;
  readonly onCodexFastModeChange: (value: boolean) => void;
  readonly onSaveProxySettings: () => void | Promise<void>;
  readonly onSaveProviderProxySettings?: () => void | Promise<void>;
  readonly onThemeChange: (theme: "dark" | "light") => void;
  readonly onOpenConfigEditor: () => void | Promise<void>;
  readonly historyHealth: HistoryHealth | null;
  readonly historyStats: HistoryStatsResponse | null;
  readonly historyError?: string | undefined;
  readonly countHistory?: (query: HistoryStatsQuery) => Promise<number>;
  readonly clearHistory?: (query: HistoryStatsQuery) => Promise<number>;
  readonly exportHistory?: (
    format: "csv" | "json",
    query: HistoryStatsQuery,
    authorization: string,
  ) => Promise<Blob | undefined>;
  readonly onHistoryCleared?: (deleted: number) => void;
  readonly schedulerSettings?: SchedulerSettings | null;
  readonly schedulerStatus?: SchedulerStatus | null;
  readonly schedulerAccountLabels?: Readonly<Record<string, string>>;
  readonly schedulerError?: string | undefined;
  readonly schedulerPending?: boolean;
  readonly onSaveSchedulerSettings?: (patch: Partial<SchedulerSettings>) => void | Promise<void>;
  readonly onSaveSchedulerOrder?: (order: readonly string[]) => void | Promise<void>;
  readonly modelPrices?: readonly ModelPrice[];
  readonly onSaveModelPrice: (price: ModelPrice) => void | Promise<void>;
  readonly tunnelStatus: TunnelStatus;
  readonly tunnelBusy: boolean;
  readonly onDownloadCloudflared: () => void | Promise<void>;
  readonly onEnableTunnel: () => void | Promise<void>;
  readonly onDisableTunnel: () => void | Promise<void>;
  readonly onCopyTunnelUrl: () => void | Promise<void>;
  readonly modelRegistryStatus?: ModelRegistryStatus | null;
  readonly modelRegistryError?: string;
  readonly onRefreshModelRegistry?: () => void | Promise<void>;
  readonly agentsSlot?: ReactNode;
  readonly totpVaultSlot?: ReactNode;
}

export function SettingsSurface({
  gatewayLifecycle,
  pending,
  loadState,
  baseUrl,
  gatewayUrlError,
  relayKey,
  secretStoreError,
  routingStrategy,
  requestRetry,
  proxyUrl,
  proxyProviders = {},
  onUpdateProxyProviderPolicy,
  loggingToFile,
  codexFastMode,
  theme,
  onToggleGateway,
  nativeSettings = null,
  nativeSettingsBusy = false,
  onLoginStartChange = () => undefined,
  onRequestNotificationPermission = () => undefined,
  updateStatus = null,
  updateBusy = false,
  onCheckUpdate = () => undefined,
  onInstallUpdate = () => undefined,
  onBaseUrlChange,
  onRelayKeyChange,
  onRelayKeyBlur,
  onRetrySecretStore,
  onCopyRelayKey,
  onSaveConnection,
  scopedKeys = [],
  availableModels = [],
  availableAccounts = [],
  onCreateScopedKey,
  onPatchScopedKey,
  onDeleteScopedKey,
  onRefreshScopedKeys,
  onRoutingStrategyChange,
  onRequestRetryChange,
  onProxyUrlChange,
  onLoggingToFileChange,
  onCodexFastModeChange,
  onSaveProxySettings,
  onSaveProviderProxySettings,
  onThemeChange,
  onOpenConfigEditor,
  showRemaining,
  onShowRemainingChange,
  clineQuotaDisplay = CLINE_QUOTA_DISPLAY_DEFAULT,
  onClineQuotaDisplayChange,
  clineQuotaCandidates = [],
  historyHealth,
  historyStats,
  historyError,
  countHistory,
  clearHistory,
  exportHistory,
  onHistoryCleared = () => undefined,
  schedulerSettings = null,
  schedulerStatus = null,
  schedulerAccountLabels = {},
  schedulerError,
  schedulerPending = false,
  onSaveSchedulerSettings = () => undefined,
  onSaveSchedulerOrder = () => undefined,
  modelPrices = EMPTY_MODEL_PRICES,
  onSaveModelPrice,
  tunnelStatus,
  tunnelBusy,
  onDownloadCloudflared,
  onEnableTunnel,
  onDisableTunnel,
  onCopyTunnelUrl,
  modelRegistryStatus = null,
  modelRegistryError,
  onRefreshModelRegistry,
  agentsSlot,
  totpVaultSlot,
}: SettingsSurfaceProps) {
  // Only rows the user has edited carry a draft; every other row renders the
  // server value, so server updates merge into non-dirty rows automatically.
  const [priceDrafts, setPriceDrafts] = useState<Readonly<Record<string, string>>>({});
  const [exportSecret, setExportSecret] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearCount, setClearCount] = useState<number | null>(null);
  const [historyBusy, setHistoryBusy] = useState<"" | "csv" | "json" | "clear">("");
  const [historyActionError, setHistoryActionError] = useState("");
  const [activeSection, setActiveSection] = useState("settings-gateway");
  const [filterQuery, setFilterQuery] = useState("");
  const [filterState, setFilterState] = useState<{
    readonly matched: number;
    readonly total: number;
  } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  // H1: Save and the scalar fields stay gated until the hook's six-scalar read
  // succeeds; the status is exposed by the hook itself (no App.tsx wiring).
  const scalarsStatus = useSettingsScalarsStatus();
  const scalarsLoaded = scalarsStatus === "loaded";
  const clearDialogRef = useRef<HTMLDialogElement>(null);

  // M6: mount-only dialog focus management, mirroring WarmupDialog — capture
  // the trigger for focus restore, move focus in, and handle Escape once.
  useEffect(() => {
    if (!confirmClear) return;
    const previous = document.activeElement;
    clearDialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setConfirmClear(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [confirmClear]);

  // A draft that now matches the server value is no longer dirty; drop it.
  useEffect(() => {
    setPriceDrafts((current) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [model, text] of Object.entries(current)) {
        const saved = modelPrices.find((item) => item.model === model);
        if (!saved || parsePriceDraft(text) === saved["input-per-million"]) {
          changed = true;
        } else {
          next[model] = text;
        }
      }
      return changed ? next : current;
    });
  }, [modelPrices]);

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const runHistoryExport = async (format: "csv" | "json") => {
    if (!exportHistory || exportSecret === "") return;
    setHistoryBusy(format);
    setHistoryActionError("");
    try {
      const blob = await exportHistory(format, {}, exportSecret);
      if (blob) downloadBlob(blob, `mahoquot-request-history.${format}`);
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : "History export failed");
    } finally {
      setHistoryBusy("");
    }
  };

  const requestClearConfirmation = async () => {
    if (!countHistory) return;
    setHistoryActionError("");
    try {
      setClearCount(await countHistory({}));
      setConfirmClear(true);
    } catch (error) {
      setHistoryActionError(error instanceof Error ? error.message : "History count unavailable");
    }
  };

  const confirmHistoryClear = async () => {
    if (!clearHistory) return;
    setHistoryBusy("clear");
    setHistoryActionError("");
    try {
      const deleted = await clearHistory({});
      setConfirmClear(false);
      onHistoryCleared(deleted);
    } catch (error) {
      setHistoryActionError(
        error instanceof Error ? error.message : "History could not be cleared",
      );
    } finally {
      setHistoryBusy("");
    }
  };

  const moveSchedulerEntry = (index: number, direction: -1 | 1) => {
    const order = schedulerStatus?.order ?? [];
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target] as string, next[index] as string];
    void onSaveSchedulerOrder(next);
  };

  const estimatedSpend = (price: ModelPrice): number | null => {
    const totals = historyStats?.totals;
    const savedPrice = modelPrices.find((item) => item.model === price.model);
    if (!totals || !savedPrice) return null;
    const nonCached = nonCachedInputTokens(totals);
    if (nonCached.state !== "measured") return null;
    return (
      totals["estimated-cost-usd"] +
      (nonCached.tokens * (price["input-per-million"] - savedPrice["input-per-million"])) /
        1_000_000
    );
  };

  const jumpTargets = [
    { id: "settings-gateway", label: "Gateway & Connection" },
    { id: "settings-proxy", label: "Proxy & Routing" },
    ...(agentsSlot ? [{ id: "settings-agents", label: "Agents & Tools" }] : []),
    ...(totpVaultSlot ? [{ id: "settings-security", label: "Security & 2FA Vault" }] : []),
    { id: "settings-storage", label: "Storage & Appearance" },
  ];
  const jumpSignature = jumpTargets.map((target) => target.id).join("|");

  useEffect(() => {
    const sections = jumpSignature
      .split("|")
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => section !== null);
    if (sections.length === 0) return;
    const scroller = sections[0]?.closest("main");
    const sync = () => {
      const visible = sections.filter((section) => !section.hidden);
      if (visible.length === 0) return;
      const nav = document.querySelector(".settings-jump");
      const navClearance = nav ? nav.getBoundingClientRect().bottom + 32 : 0;
      const line = Math.max(window.innerHeight * 0.35, navClearance);
      let current = visible[0];
      for (const section of visible) {
        if (section.getBoundingClientRect().top <= line) current = section;
      }
      if (
        scroller &&
        scroller.scrollHeight > scroller.clientHeight &&
        Math.ceil(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight - 8
      ) {
        current = visible.at(-1) ?? current;
      }
      if (current) setActiveSection(current.id);
    };
    sync();
    scroller?.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync, { passive: true });
    const observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(sync, { threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] })
        : null;
    for (const section of sections) observer?.observe(section);
    return () => {
      scroller?.removeEventListener("scroll", sync);
      window.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      observer?.disconnect();
    };
  }, [jumpSignature]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const tokens = settingsQueryTokens(filterQuery);
    const apply = () => {
      const cards = Array.from(body.querySelectorAll<HTMLElement>(SETTINGS_CARD_SELECTOR));
      let matched = 0;
      for (const card of cards) {
        const match = matchesSettingsQuery(card.textContent ?? "", tokens);
        if (match) matched += 1;
        if (card.hidden === match) card.hidden = !match;
      }
      for (const section of body.querySelectorAll<HTMLElement>(".settings-section")) {
        const hasVisibleCard = Array.from(
          section.querySelectorAll<HTMLElement>(SETTINGS_CARD_SELECTOR),
        ).some((card) => !card.hidden);
        const shouldHide = tokens.length > 0 && !hasVisibleCard;
        if (section.hidden !== shouldHide) section.hidden = shouldHide;
      }
      const next = tokens.length === 0 ? null : { matched, total: cards.length };
      setFilterState((current) =>
        current === next ||
        (current !== null &&
          next !== null &&
          current.matched === next.matched &&
          current.total === next.total)
          ? current
          : next,
      );
    };
    const scroller = body.closest("main");
    // Only a real query re-anchors the surface: on mount the restore effect owns
    // scroll position, and resetting here would undo it for a frame.
    if (scroller && tokens.length > 0) scroller.scrollTop = 0;
    apply();
    if (tokens.length === 0) return;
    const observer = new MutationObserver(apply);
    observer.observe(body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [filterQuery]);

  useEffect(() => {
    const scroller = bodyRef.current?.closest("main");
    if (!scroller) return;
    const saved = rememberedScrollTop;
    if (saved !== null) {
      requestAnimationFrame(() => {
        scroller.scrollTop = saved;
      });
    }
    const save = () => {
      rememberedScrollTop = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", save, { passive: true });
    return () => {
      // No save() here: React removes these nodes before this cleanup runs, so
      // the scroller has already collapsed to 0 and would overwrite the real
      // position the scroll listener captured.
      scroller.removeEventListener("scroll", save);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      findInputRef.current?.focus();
      findInputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="settings">
      <nav className="settings-jump" aria-label="Settings sections">
        <label className="settings-find-field">
          <input
            ref={findInputRef}
            type="search"
            className="input"
            placeholder="Find a setting…"
            aria-label="Find a setting"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || filterQuery === "") return;
              event.preventDefault();
              setFilterQuery("");
            }}
          />
        </label>
        {filterState ? (
          <output className="settings-find-status">
            {filterState.matched === 0
              ? `No card matches “${filterQuery.trim()}”`
              : `${filterState.matched} of ${filterState.total} cards`}
            <button type="button" onClick={() => setFilterQuery("")}>
              Clear
            </button>
          </output>
        ) : null}
        <span className="settings-jump-title">On this page</span>
        <ul className="settings-jump-list">
          {jumpTargets.map((target) => (
            <li key={target.id}>
              <button
                type="button"
                className={cn("settings-jump-link", activeSection === target.id && "active")}
                aria-current={activeSection === target.id ? "location" : undefined}
                onClick={(event) => {
                  const section = document.getElementById(target.id);
                  if (!section) return;
                  setActiveSection(target.id);
                  const nav = event.currentTarget.closest("nav");
                  const scroller = section.closest("main");
                  if (nav && scroller && scroller.scrollHeight > scroller.clientHeight) {
                    const scrollerTop = scroller.getBoundingClientRect().top;
                    const clearance =
                      Math.ceil(nav.getBoundingClientRect().bottom - scrollerTop) + 8;
                    const targetTop =
                      scroller.scrollTop +
                      (section.getBoundingClientRect().top - scrollerTop) -
                      Math.max(84, clearance);
                    scroller.scrollTo({ top: Math.max(0, targetTop) });
                  } else {
                    section.scrollIntoView({ block: "start" });
                  }
                  const heading = section.querySelector<HTMLElement>("h2");
                  if (heading) {
                    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
                    heading.focus({ preventScroll: true });
                  }
                }}
              >
                {target.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-body" ref={bodyRef}>
        <section
          id="settings-gateway"
          className="settings-section"
          aria-label="Gateway and runtime"
        >
          <header className="settings-section-head">
            <h2>Gateway & Connection</h2>
            <p>Local inference proxy lifecycle, address binding, and desktop integration.</p>
          </header>
          <div className="settings-section-cards">
            <Card className="settings-row-card gateway-process-card">
              <div className="settings-row-copy">
                <h3>Gateway process</h3>
                <p>Starts automatically with Mahoquot; stop or restart the local proxy here.</p>
              </div>
              <div className="gateway-process-action">
                <Badge tone={gatewayLifecycle === "running" ? "ok" : "neutral"}>
                  {gatewayLifecycle === "running" ? "Running" : "Stopped"}
                </Badge>
                <Button
                  disabled={blocks(pending, "gateway")}
                  onClick={() => void onToggleGateway()}
                >
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
                  <h3>Connection & access</h3>
                  <p>{baseUrl || "Same-origin gateway"}</p>
                </div>
              </header>
              <div className="connection-fields connection-fields-grid">
                <Field
                  label="Gateway URL"
                  hint="Blank uses current origin (desktop default: http://127.0.0.1:18801)."
                >
                  <Input
                    aria-label="Gateway URL"
                    type="url"
                    inputMode="url"
                    aria-invalid={gatewayUrlError !== null && gatewayUrlError !== undefined}
                    value={baseUrl}
                    placeholder="http://127.0.0.1:18801"
                    onChange={(event) => onBaseUrlChange(event.target.value)}
                  />
                  {gatewayUrlError ? (
                    <small className="field-error">{gatewayUrlError}</small>
                  ) : null}
                </Field>
                <Field label="API key" hint="Authenticates proxy, telemetry, logs, and management.">
                  <div className="secret-input-row">
                    <Input
                      aria-label="API key"
                      type="password"
                      value={relayKey}
                      onChange={(event) => onRelayKeyChange(event.target.value)}
                      onBlur={onRelayKeyBlur}
                    />
                    <Button aria-label="Copy API key" disabled={!relayKey} onClick={onCopyRelayKey}>
                      <Copy size={14} /> Copy
                    </Button>
                  </div>
                  {secretStoreError ? (
                    <div role="alert" className="field-error">
                      {secretStoreError.message}{" "}
                      <button type="button" onClick={onRetrySecretStore}>
                        {secretStoreError.action === "retry"
                          ? "Retry secure storage"
                          : "Re-enter key"}
                      </button>
                    </div>
                  ) : null}
                </Field>
              </div>
              <div className="connection-actions">
                <span>Applies to this console immediately.</span>
                <Button className="button-primary" onClick={onSaveConnection}>
                  Save & reconnect
                </Button>
              </div>
            </Card>

            <Card className="settings-row-card">
              <div className="settings-row-copy">
                <h3>Desktop integration</h3>
                <p>Launch the gateway, tray, and compact notch automatically when you log in.</p>
              </div>
              <label className="settings-switch-chip">
                <input
                  aria-label="Start Mahoquot at login"
                  type="checkbox"
                  checked={nativeSettings?.login_start_enabled ?? false}
                  disabled={nativeSettingsBusy}
                  onChange={(event) => void onLoginStartChange(event.target.checked)}
                />
                <span>Start at login</span>
              </label>
            </Card>

            <Card className="settings-card settings-compact-card">
              <div className="settings-row-main">
                <div className="settings-row-copy">
                  <h3>Native notifications</h3>
                  <p>
                    Alert on account exhaustion, isolation, degraded history, or tunnel failure.
                  </p>
                </div>
                <div className="settings-row-controls">
                  <Badge tone={nativeSettings?.notifications === "available" ? "ok" : "warn"}>
                    {nativeSettings?.notifications === "available"
                      ? "Notifications ready"
                      : nativeSettings?.notifications === "permission_denied"
                        ? "Permission denied"
                        : "Service unavailable"}
                  </Badge>
                  {nativeSettings?.notifications !== "available" ? (
                    <Button
                      disabled={nativeSettingsBusy}
                      onClick={() => void onRequestNotificationPermission()}
                    >
                      {nativeSettingsBusy ? "Checking…" : "Enable notifications"}
                    </Button>
                  ) : null}
                </div>
              </div>
              {nativeSettings?.action ? (
                <p role="alert" className="settings-inline-alert">
                  {nativeSettings.action}
                </p>
              ) : null}
            </Card>

            <Card className="settings-row-card">
              <div className="settings-row-copy">
                <h3>Signed updates</h3>
                <p>Update the desktop app and bundled gateway as one verified release unit.</p>
              </div>
              <div className="settings-row-controls">
                <Badge tone={updateStatus?.available ? "warn" : "neutral"}>
                  {updateStatus?.available
                    ? updateStatus.version
                    : updateStatus
                      ? "Current"
                      : "Verified"}
                </Badge>
                <Button disabled={updateBusy} onClick={onCheckUpdate}>
                  {updateBusy && !updateStatus?.available ? "Checking…" : "Check for updates"}
                </Button>
                {updateStatus?.available ? (
                  <Button disabled={updateBusy} onClick={onInstallUpdate}>
                    {updateBusy ? "Installing…" : "Install signed update"}
                  </Button>
                ) : null}
              </div>
            </Card>
          </div>
        </section>

        <section id="settings-proxy" className="settings-section" aria-label="Proxy and routing">
          <header className="settings-section-head">
            <h2>Proxy & Routing</h2>
            <p>Routing strategy, runtime flags, failover scheduling, and remote access.</p>
          </header>
          <div className="settings-section-cards">
            <Card className="settings-card">
              <header className="settings-card-head">
                <div className="settings-icon">
                  <Route size={17} />
                </div>
                <div>
                  <h3>Proxy behavior</h3>
                  <p>Account rotation strategy, retry count, and global outbound proxy.</p>
                </div>
                <Badge tone="warn">Saved changes require restart</Badge>
              </header>
              <div className="proxy-scalars-grid">
                <Field label="Routing strategy" hint="Failover before first response byte.">
                  <select
                    className="input"
                    aria-label="Routing strategy"
                    value={routingStrategy}
                    disabled={!scalarsLoaded}
                    onChange={(event) => onRoutingStrategyChange(event.target.value)}
                  >
                    <option value="round-robin">Round robin</option>
                    <option value="weighted-round-robin">Weighted round robin</option>
                    <option value="fill-first">Fill first</option>
                  </select>
                </Field>
                <Field label="Request retry count" hint="Attempts before returning an error.">
                  <Input
                    aria-label="Request retry count"
                    type="number"
                    min="0"
                    step="1"
                    value={requestRetry}
                    disabled={!scalarsLoaded}
                    onChange={(event) => onRequestRetryChange(event.target.value)}
                  />
                </Field>
                <Field label="Upstream proxy URL" hint="Blank connects directly.">
                  <Input
                    aria-label="Upstream proxy URL"
                    type="url"
                    inputMode="url"
                    value={proxyUrl}
                    placeholder="http://127.0.0.1:7890"
                    disabled={!scalarsLoaded}
                    onChange={(event) => onProxyUrlChange(event.target.value)}
                  />
                </Field>
              </div>
              <div className="connection-actions">
                <span role={scalarsStatus === "error" ? "alert" : undefined}>
                  {scalarsLoaded
                    ? "Saved values persist immediately."
                    : scalarsStatus === "error"
                      ? "Gateway settings failed to load; saving is blocked so defaults cannot overwrite live values."
                      : "Waiting for gateway settings to load before saving."}
                </span>
                <Button
                  disabled={blocks(pending, "settings") || !scalarsLoaded}
                  onClick={() => void onSaveProxySettings()}
                >
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
                  <h3>Runtime & logging flags</h3>
                  <p>File log persistence and Codex priority service tier override.</p>
                </div>
              </header>
              <div className="settings-toggle-list settings-toggle-list-clean">
                <label className="toggle-field">
                  <span>
                    <strong>Write logs to file</strong>
                    <small>Persist gateway diagnostics to disk for the log viewer.</small>
                  </span>
                  <input
                    aria-label="Write logs to file"
                    type="checkbox"
                    checked={loggingToFile}
                    disabled={!scalarsLoaded}
                    onChange={(event) => onLoggingToFileChange(event.target.checked)}
                  />
                </label>
                <label className="toggle-field">
                  <span>
                    <strong>ChatGPT fast mode</strong>
                    <small>Send priority service tier on every Codex request.</small>
                  </span>
                  <input
                    aria-label="ChatGPT fast mode"
                    type="checkbox"
                    checked={codexFastMode}
                    disabled={!scalarsLoaded}
                    onChange={(event) => onCodexFastModeChange(event.target.checked)}
                  />
                </label>
              </div>
              <div className="connection-actions">
                <span>Saved with gateway runtime configuration.</span>
                <Button
                  disabled={blocks(pending, "settings") || !scalarsLoaded}
                  onClick={() => void onSaveProxySettings()}
                >
                  {pending === "settings:save" ? "Saving…" : "Save runtime flags"}
                </Button>
              </div>
            </Card>

            <Card className="settings-card" aria-label="Per-provider proxy routing">
              <header className="settings-card-head">
                <div className="settings-icon">
                  <Network size={17} />
                </div>
                <div>
                  <h3>Per-provider proxy routing</h3>
                  <p>Route individual providers through rotating or sticky upstream proxies.</p>
                </div>
              </header>
              <div className="provider-proxy-list">
                {(() => {
                  const allProviders = Array.from(
                    new Set(
                      [...Object.keys(proxyProviders), ...availableAccounts.map((a) => a.provider)]
                        .map(normalizeToQuotioProviderId)
                        .filter((provider) => provider !== ""),
                    ),
                  ).sort();

                  return allProviders.map((canonical) => {
                    const provider =
                      Object.keys(proxyProviders).find(
                        (key) => normalizeToQuotioProviderId(key) === canonical,
                      ) ?? canonical;
                    const policy = proxyProviders[provider] ?? {
                      enabled: false,
                      sticky: true,
                      "ttl-secs": 0,
                      url: "",
                    };
                    return (
                      <div key={canonical} className="provider-proxy-item">
                        <label className="toggle-field provider-proxy-toggle">
                          <span className="provider-proxy-row-label">
                            <strong className="provider-proxy-name">{canonical}</strong>
                            <Badge tone={policy.enabled ? "ok" : "neutral"}>
                              {policy.enabled ? "Proxied" : "Direct"}
                            </Badge>
                          </span>
                          <input
                            aria-label={`Enable proxy for ${canonical}`}
                            type="checkbox"
                            checked={policy.enabled}
                            onChange={(e) =>
                              onUpdateProxyProviderPolicy?.(provider, { enabled: e.target.checked })
                            }
                          />
                        </label>
                        {policy.enabled ? (
                          <div className="provider-proxy-details">
                            <label className="toggle-field provider-proxy-toggle">
                              <span>
                                <strong>Sticky session (per account)</strong>
                                <small>Pin each account to a stable exit IP session.</small>
                              </span>
                              <input
                                aria-label={`Sticky session for ${canonical}`}
                                type="checkbox"
                                checked={policy.sticky}
                                onChange={(e) =>
                                  onUpdateProxyProviderPolicy?.(provider, {
                                    sticky: e.target.checked,
                                  })
                                }
                              />
                            </label>
                            <div className="provider-proxy-fields">
                              <Field
                                label="Session TTL (seconds)"
                                hint="0 uses pool default; positive rotates exit IP."
                              >
                                <Input
                                  aria-label={`Session TTL for ${canonical}`}
                                  type="number"
                                  min="0"
                                  step="60"
                                  value={String(policy["ttl-secs"] ?? 0)}
                                  onChange={(e) =>
                                    onUpdateProxyProviderPolicy?.(provider, {
                                      "ttl-secs": Math.max(
                                        0,
                                        Number.parseInt(e.target.value, 10) || 0,
                                      ),
                                    })
                                  }
                                />
                              </Field>
                              <Field
                                label="Proxy URL override"
                                hint="Blank inherits global upstream proxy URL."
                              >
                                <Input
                                  aria-label={`Proxy URL override for ${canonical}`}
                                  type="url"
                                  inputMode="url"
                                  placeholder="http://127.0.0.1:3128"
                                  value={policy.url ?? ""}
                                  onChange={(e) =>
                                    onUpdateProxyProviderPolicy?.(provider, { url: e.target.value })
                                  }
                                />
                              </Field>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  });
                })()}
              </div>
              <div className="connection-actions">
                <span>Applies live without restarting the gateway.</span>
                <Button
                  disabled={blocks(pending, "settings") || !scalarsLoaded}
                  onClick={() =>
                    void (onSaveProviderProxySettings
                      ? onSaveProviderProxySettings()
                      : onSaveProxySettings())
                  }
                >
                  {pending === "settings:save" ? "Saving…" : "Save provider proxy routing"}
                </Button>
              </div>
            </Card>

            {modelRegistryStatus || modelRegistryError ? (
              <Card className="settings-card settings-compact-card" aria-label="Model registry">
                <div className="settings-row-main">
                  <div className="settings-row-copy">
                    <h3>Model registry</h3>
                    <p>
                      {modelRegistryStatus
                        ? `Catalog v${modelRegistryStatus["catalog-version"]} · ${describeCatalogSource(modelRegistryStatus.source)} · ${modelRegistryStatus["model-count"]} models`
                        : "Active catalog and model resolution status."}
                    </p>
                  </div>
                  <div className="settings-row-controls">
                    {modelRegistryStatus ? (
                      <output
                        className={cn(
                          "badge",
                          modelRegistryStatus.stale ||
                            modelRegistryStatus["last-refresh"].outcome === "error"
                            ? "badge-warn"
                            : "badge-ok",
                        )}
                        aria-label={
                          modelRegistryStatus.stale
                            ? "Model catalog is stale"
                            : modelRegistryStatus["last-refresh"].outcome === "error"
                              ? "Model catalog refresh error"
                              : "Model catalog is current"
                        }
                      >
                        {modelRegistryStatus.stale
                          ? "Catalog stale"
                          : modelRegistryStatus["last-refresh"].outcome === "error"
                            ? "Refresh error"
                            : "Current"}
                      </output>
                    ) : modelRegistryError ? (
                      <output
                        className="badge badge-warn"
                        aria-label="Model catalog status unavailable"
                      >
                        Catalog error
                      </output>
                    ) : null}
                    {onRefreshModelRegistry ? (
                      <Button
                        disabled={
                          blocks(pending, "registry") || modelRegistryStatus?.["refresh-in-flight"]
                        }
                        onClick={() => void onRefreshModelRegistry()}
                      >
                        {pending === "registry:refresh" ||
                        modelRegistryStatus?.["refresh-in-flight"]
                          ? "Refreshing…"
                          : "Refresh catalog"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {modelRegistryStatus?.["last-refresh"].outcome === "error" &&
                modelRegistryStatus["last-refresh"]["rejection-reason"] ? (
                  TRANSIENT_REJECTION.test(
                    modelRegistryStatus["last-refresh"]["rejection-reason"],
                  ) ? (
                    <p className="settings-registry-note">
                      Last refresh failed: {modelRegistryStatus["last-refresh"]["rejection-reason"]}
                    </p>
                  ) : (
                    <div className="state-panel warning" role="alert">
                      Refresh failure: {modelRegistryStatus["last-refresh"]["rejection-reason"]}
                    </div>
                  )
                ) : null}
                {modelRegistryError ? (
                  <div className="state-panel warning" role="alert">
                    {modelRegistryError}
                  </div>
                ) : null}
              </Card>
            ) : null}

            <Card className="settings-card" aria-label="Account scheduling">
              <header className="settings-card-head">
                <div className="settings-icon">
                  <ListOrdered size={17} />
                </div>
                <div>
                  <h3>Account scheduling</h3>
                  <p>Gateway-owned rotation with a manual priority order override.</p>
                </div>
                {schedulerStatus ? (
                  <Badge
                    tone={
                      schedulerStatus.fail_open
                        ? "warn"
                        : schedulerStatus.enabled
                          ? "ok"
                          : "neutral"
                    }
                  >
                    {schedulerStatus.fail_open
                      ? "Fail open"
                      : schedulerStatus.enabled
                        ? "Active"
                        : "Off"}
                  </Badge>
                ) : null}
              </header>
              {schedulerError ? (
                <div className="state-panel warning">Scheduler unavailable: {schedulerError}</div>
              ) : schedulerSettings && schedulerStatus ? (
                <label className="toggle-field">
                  <span>
                    <strong>Enable scheduler</strong>
                    <small>Ranks eligible accounts by active quota reset time.</small>
                  </span>
                  <input
                    aria-label="Enable scheduler"
                    type="checkbox"
                    checked={schedulerSettings.enabled}
                    disabled={schedulerPending}
                    onChange={(event) =>
                      void onSaveSchedulerSettings({ enabled: event.target.checked })
                    }
                  />
                </label>
              ) : null}
              {!schedulerError && schedulerStatus ? (
                schedulerStatus.order.length ? (
                  <div className="scheduler-order" aria-label="Scheduler order">
                    {schedulerStatus.order.map((id, index) => {
                      const account = schedulerStatus.accounts.find((item) => item.id === id);
                      const label = schedulerAccountLabels[id] ?? id;
                      return (
                        <div className="scheduler-order-row" key={id}>
                          <span className="scheduler-rank">{index + 1}</span>
                          <div className="scheduler-order-name">
                            <strong>{label}</strong>
                            <small>{id}</small>
                          </div>
                          <span className="scheduler-remaining">
                            {account === undefined ? (
                              <small>Unavailable</small>
                            ) : account.remaining_percent === null ? (
                              <small>Quota unknown</small>
                            ) : (
                              `${account.remaining_percent}% remaining`
                            )}
                            {account?.parked ? <small>Parked</small> : null}
                          </span>
                          <div className="scheduler-order-actions">
                            <Button
                              aria-label={`Move ${label} up`}
                              disabled={schedulerPending || index === 0}
                              onClick={() => moveSchedulerEntry(index, -1)}
                            >
                              <ArrowUp size={13} />
                            </Button>
                            <Button
                              aria-label={`Move ${label} down`}
                              disabled={
                                schedulerPending || index === schedulerStatus.order.length - 1
                              }
                              onClick={() => moveSchedulerEntry(index, 1)}
                            >
                              <ArrowDown size={13} />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="state-panel">
                    No accounts are currently ordered by the scheduler.
                  </div>
                )
              ) : null}
            </Card>

            <TunnelCard
              status={tunnelStatus}
              busy={tunnelBusy}
              onDownload={onDownloadCloudflared}
              onEnable={onEnableTunnel}
              onDisable={onDisableTunnel}
              onCopyUrl={onCopyTunnelUrl}
            />
            {onCreateScopedKey && onPatchScopedKey && onDeleteScopedKey ? (
              <SharedKeysCard
                scopedKeys={scopedKeys}
                availableModels={availableModels}
                availableAccounts={availableAccounts}
                tunnelUrl={tunnelStatus.public_url}
                baseUrl={baseUrl}
                onCreateKey={onCreateScopedKey}
                onPatchKey={onPatchScopedKey}
                onDeleteKey={onDeleteScopedKey}
                onRefresh={onRefreshScopedKeys}
              />
            ) : null}
          </div>
        </section>

        {agentsSlot ? (
          <section id="settings-agents" className="settings-section" aria-label="Developer tools">
            <header className="settings-section-head">
              <h2>Agents & Tools</h2>
              <p>Local coding agent configuration and isolated Codex sessions.</p>
            </header>
            <div className="settings-section-cards">{agentsSlot}</div>
          </section>
        ) : null}

        {totpVaultSlot ? (
          <section
            id="settings-security"
            className="settings-section"
            aria-label="Security and credentials"
          >
            <header className="settings-section-head">
              <h2>Security & 2FA Vault</h2>
              <p>Encrypted desktop keyring store for two-factor authentication codes.</p>
            </header>
            <div className="settings-section-cards">{totpVaultSlot}</div>
          </section>
        ) : null}

        <section
          id="settings-storage"
          className="settings-section"
          aria-label="Storage and appearance"
        >
          <header className="settings-section-head">
            <h2>Storage & Appearance</h2>
            <p>Console theme, quota display preferences, request history, and model pricing.</p>
          </header>
          <div className="settings-section-cards">
            <Card className="settings-row-card">
              <div className="settings-row-copy">
                <h3>Appearance</h3>
                <p>Color scheme saved on this device and applied across the console.</p>
              </div>
              <div className="settings-inline-select">
                <select
                  aria-label="Theme"
                  className="input"
                  value={theme}
                  onChange={(event) => {
                    const nextTheme = event.currentTarget.value === "light" ? "light" : "dark";
                    onThemeChange(nextTheme);
                  }}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </div>
            </Card>

            <Card className="settings-card">
              <header className="settings-card-head">
                <div className="settings-icon">
                  <Settings2 size={17} />
                </div>
                <div>
                  <h3>Quota display</h3>
                  <p>Choose meter direction and which Cline daily quota buckets appear.</p>
                </div>
              </header>
              <div className="settings-toggle-list settings-toggle-list-clean">
                <label className="toggle-field">
                  <span>
                    <strong>Show remaining quota</strong>
                    <small>Show how much quota is left instead of how much was used.</small>
                  </span>
                  <input
                    aria-label="Show remaining quota"
                    type="checkbox"
                    checked={showRemaining}
                    onChange={(event) => onShowRemainingChange(event.target.checked)}
                  />
                </label>
              </div>
              <Field
                label="Cline daily quota display"
                hint="Select which Cline free models render a daily limit row."
              >
                {clineQuotaCandidates.length === 0 ? (
                  <small>Loading Cline model list...</small>
                ) : (
                  <div className="scope-options">
                    {clineQuotaCandidates.map(({ slug, label }) => {
                      const checked = clineQuotaDisplay.includes(slug);
                      return (
                        <label className="scope-chip" data-checked={checked} key={slug}>
                          <input
                            aria-label={`Show daily quota for ${label}`}
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              const next = event.target.checked
                                ? [...clineQuotaDisplay, slug]
                                : clineQuotaDisplay.filter((entry) => entry !== slug);
                              onClineQuotaDisplayChange?.(next);
                            }}
                          />
                          <span>{label}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </Field>
            </Card>

            {historyHealth || modelPrices.length > 0 ? (
              <section aria-label="History and pricing" className="settings-section-cards">
                <Card className="settings-card">
                  <header className="settings-card-head">
                    <div className="settings-icon">
                      <Settings2 size={17} />
                    </div>
                    <div>
                      <h3>Request history</h3>
                      <p>
                        {historyHealth
                          ? `${historyHealth["written-events"].toLocaleString("en-US")} events written · queue ${historyHealth["queue-depth"]}/${historyHealth["queue-capacity"]}${
                              historyHealth["dropped-events"] > 0
                                ? ` · ${historyHealth["dropped-events"]} dropped`
                                : ""
                            }`
                          : "Export or clear durable request history records."}
                      </p>
                    </div>
                    {historyHealth ? (
                      <Badge tone={historyHealth.degraded ? "warn" : "ok"}>
                        {historyHealth.degraded ? "Degraded" : "Ready"}
                      </Badge>
                    ) : null}
                  </header>
                  {historyError ? <div className="state-panel warning">{historyError}</div> : null}
                  {historyActionError ? (
                    <div className="state-panel warning">{historyActionError}</div>
                  ) : null}
                  <div className="history-export-bar">
                    <Field
                      label="Export authorization secret"
                      hint="Required to download CSV or JSON history exports."
                    >
                      <Input
                        aria-label="Export authorization secret"
                        autoComplete="off"
                        placeholder="Management secret for export"
                        type="password"
                        value={exportSecret}
                        onChange={(event) => setExportSecret(event.currentTarget.value)}
                      />
                    </Field>
                    <div className="settings-actions">
                      <Button
                        disabled={!exportHistory || exportSecret === "" || historyBusy !== ""}
                        onClick={() => void runHistoryExport("csv")}
                      >
                        {historyBusy === "csv" ? "Exporting…" : "Export CSV"}
                      </Button>
                      <Button
                        disabled={!exportHistory || exportSecret === "" || historyBusy !== ""}
                        onClick={() => void runHistoryExport("json")}
                      >
                        {historyBusy === "json" ? "Exporting…" : "Export JSON"}
                      </Button>
                    </div>
                  </div>
                  <div className="connection-actions">
                    <span>Permanently delete stored dashboard history records.</span>
                    <Button
                      className="danger"
                      disabled={!clearHistory || historyBusy !== ""}
                      onClick={() => void requestClearConfirmation()}
                    >
                      {historyBusy === "clear" ? "Clearing…" : "Clear history"}
                    </Button>
                  </div>
                </Card>

                {modelPrices.length > 0 ? (
                  <Card className="settings-card">
                    <header className="settings-card-head">
                      <div className="settings-icon">
                        <Settings2 size={17} />
                      </div>
                      <div>
                        <h3>Model pricing</h3>
                        <p>Input token rates (USD per 1M tokens) used to estimate spend.</p>
                      </div>
                    </header>
                    <div className="model-prices-list model-prices-table">
                      {modelPrices.map((saved) => {
                        const draftText = priceDrafts[saved.model];
                        const parsed =
                          draftText === undefined
                            ? saved["input-per-million"]
                            : parsePriceDraft(draftText);
                        const price: ModelPrice =
                          parsed === null ? saved : { ...saved, "input-per-million": parsed };
                        return (
                          <div className="model-price-table-row" key={saved.model}>
                            <div className="model-price-model">
                              <strong>{saved.model}</strong>
                              <small>USD / 1M input tokens</small>
                              {parsed === null ? (
                                <small className="field-error">
                                  Enter a finite price of 0 or more.
                                </small>
                              ) : null}
                            </div>
                            <div className="model-price-input-cell">
                              <Input
                                aria-label={`Input price for ${saved.model}`}
                                aria-invalid={parsed === null}
                                type="number"
                                step="0.01"
                                min="0"
                                value={draftText ?? String(saved["input-per-million"])}
                                onChange={(event) => {
                                  const text = event.target.value;
                                  setPriceDrafts((current) => ({
                                    ...current,
                                    [saved.model]: text,
                                  }));
                                }}
                              />
                            </div>
                            <div className="model-price-estimate">
                              <small>Estimated spend</small>
                              <ModelPriceEstimate
                                value={parsed === null ? null : estimatedSpend(price)}
                              />
                            </div>
                            <Button
                              aria-label={`Save ${saved.model} price`}
                              disabled={parsed === null}
                              onClick={() => void onSaveModelPrice(price)}
                            >
                              Save
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                ) : null}
              </section>
            ) : null}

            <Card className="settings-row-card">
              <div className="settings-row-copy">
                <h3>Advanced YAML</h3>
                <p>Edit the complete persisted gateway configuration (may contain secrets).</p>
              </div>
              <Button
                disabled={blocks(pending, "config")}
                onClick={() => void onOpenConfigEditor()}
              >
                {pending === "config:load" ? "Loading…" : "Open YAML editor"}
              </Button>
            </Card>
          </div>
        </section>

        {confirmClear ? (
          <OverlayLayer
            className="history-dialog-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget) setConfirmClear(false);
            }}
          >
            <dialog
              ref={clearDialogRef}
              open
              className="history-dialog"
              aria-modal="true"
              aria-label="Clear request history"
              onKeyDown={(event) => {
                if (event.key === "Tab") {
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLElement>(
                      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
                    ),
                  );
                  const first = items[0];
                  const last = items.at(-1);
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                  }
                }
              }}
            >
              <h2>Clear request history</h2>
              <p>
                This permanently removes {clearCount?.toLocaleString("en-US") ?? "all stored"}{" "}
                request records and their dashboard history. It cannot be undone. Proxy file logs
                are not affected.
              </p>
              {historyActionError ? (
                <div role="alert" className="field-error">
                  {historyActionError}
                </div>
              ) : null}
              <div className="settings-actions">
                <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
                <Button
                  className="danger"
                  disabled={historyBusy !== ""}
                  onClick={() => void confirmHistoryClear()}
                >
                  Clear history
                </Button>
              </div>
            </dialog>
          </OverlayLayer>
        ) : null}
      </div>
    </div>
  );
}

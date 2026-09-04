import {
  ArrowDown,
  ArrowUp,
  Copy,
  ListOrdered,
  Network,
  Route,
  Settings2,
  TerminalSquare,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { HistoryStatsQuery } from "../lib/api";
import { cn } from "../lib/cn";
import type {
  GatewayLifecycleStatus,
  NativeSettingsState,
  SecretStoreError,
  TunnelStatus,
  UpdateStatus,
} from "../lib/native";
import { blocks } from "../lib/pending";
import type {
  HistoryHealth,
  HistoryStatsResponse,
  ModelPrice,
  ModelRegistryStatus,
  SchedulerSettings,
  SchedulerStatus,
} from "../lib/schemas";
import type { GatewayModelEntry, ScopedApiKey } from "../lib/schemas";
import { SharedKeysCard } from "./SharedKeysCard";
import { TunnelCard } from "./TunnelCard";
import { Badge, Button, Card, Field, Input } from "./ui";

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
  readonly loggingToFile: boolean;
  readonly theme: "dark" | "light";
  readonly showRemaining: boolean;
  readonly onShowRemainingChange: (value: boolean) => void;
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
  readonly onSaveProxySettings: () => void | Promise<void>;
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
  loggingToFile,
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
  onSaveProxySettings,
  onThemeChange,
  onOpenConfigEditor,
  showRemaining,
  onShowRemainingChange,
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
  modelPrices = [],
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
  const [draftPrices, setDraftPrices] = useState<readonly ModelPrice[]>(modelPrices);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearCount, setClearCount] = useState<number | null>(null);
  const [historyBusy, setHistoryBusy] = useState<"" | "csv" | "json" | "clear">("");
  const [historyActionError, setHistoryActionError] = useState("");

  useEffect(() => setDraftPrices(modelPrices), [modelPrices]);

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const runHistoryExport = async (format: "csv" | "json") => {
    if (!exportHistory) return;
    setHistoryBusy(format);
    setHistoryActionError("");
    try {
      const blob = await exportHistory(format, {});
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

  const estimatedSpend = (price: ModelPrice): number => {
    const totals = historyStats?.totals;
    const savedPrice = modelPrices.find((item) => item.model === price.model);
    if (!totals || !savedPrice) return 0;
    return (
      totals["estimated-cost-usd"] +
      (((totals["input-tokens"] ?? 0) - (totals["cached-input-tokens"] ?? 0)) *
        (price["input-per-million"] - savedPrice["input-per-million"])) /
        1_000_000
    );
  };

  return (
    <div className="settings">
      <section className="settings-section" aria-label="Gateway and runtime">
        <header className="settings-section-head">
          <span className="kicker">CORE RUNTIME</span>
          <h2>Gateway & Connection</h2>
          <p>Local inference proxy lifecycle, address binding, and access credentials.</p>
        </header>
        <div className="settings-section-cards">
          <Card className="gateway-process-card">
            <div>
              <h2>Gateway process</h2>
              <p>Starts automatically with Mahoquot. Stop or restart it explicitly here.</p>
            </div>
            <div className="gateway-process-action">
              <Badge tone={gatewayLifecycle === "running" ? "ok" : "neutral"}>
                {gatewayLifecycle === "running" ? "Running" : "Stopped"}
              </Badge>
              <Button disabled={blocks(pending, "gateway")} onClick={() => void onToggleGateway()}>
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
                  aria-invalid={gatewayUrlError !== null && gatewayUrlError !== undefined}
                  value={baseUrl}
                  placeholder="http://127.0.0.1:18801"
                  onChange={(event) => onBaseUrlChange(event.target.value)}
                />
                {gatewayUrlError ? <small className="field-error">{gatewayUrlError}</small> : null}
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
              <span>Connection changes apply to this console immediately.</span>
              <Button onClick={onSaveConnection}>Save & reconnect</Button>
            </div>
          </Card>
          <Card className="settings-card">
            <header className="settings-card-head">
              <div className="settings-icon">
                <Settings2 size={17} />
              </div>
              <div>
                <h2>Desktop integration</h2>
                <p>Native login startup and observed-state notifications.</p>
              </div>
              <Badge tone={nativeSettings?.notifications === "available" ? "ok" : "warn"}>
                {nativeSettings?.notifications === "available"
                  ? "Notifications ready"
                  : nativeSettings?.notifications === "permission_denied"
                    ? "Permission denied"
                    : "Service unavailable"}
              </Badge>
            </header>
            <div className="proxy-settings-grid">
              <label className="toggle-field">
                <input
                  aria-label="Start Mahoquot at login"
                  type="checkbox"
                  checked={nativeSettings?.login_start_enabled ?? false}
                  disabled={nativeSettingsBusy}
                  onChange={(event) => void onLoginStartChange(event.target.checked)}
                />
                <span>
                  <strong>Start Mahoquot at login</strong>
                  <small>
                    Starts the owned gateway, tray, and compact notch while leaving the console
                    hidden and unfocused.
                  </small>
                </span>
              </label>
              <div>
                <strong>Native notifications</strong>
                <p>
                  Account isolation, all-account exhaustion, degraded history, update readiness or
                  failure, and tunnel failure are observed by Rust without hidden-webview polling.
                </p>
                {nativeSettings?.action ? <p role="alert">{nativeSettings.action}</p> : null}
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
          </Card>
          <Card className="settings-card">
            <div className="settings-header">
              <div>
                <h2>Signed updates</h2>
                <p>Desktop and bundled gateway update as one verified release unit.</p>
              </div>
              <Badge tone={updateStatus?.available ? "warn" : "neutral"}>
                {updateStatus?.available ? updateStatus.version : "Current"}
              </Badge>
            </div>
            <div className="settings-actions">
              <Button disabled={updateBusy} onClick={onCheckUpdate}>
                Check for updates
              </Button>
              {updateStatus?.available ? (
                <Button disabled={updateBusy} onClick={onInstallUpdate}>
                  Install signed update
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      </section>

      <section className="settings-section" aria-label="Proxy and routing">
        <header className="settings-section-head">
          <span className="kicker">TRAFFIC & DISCOVERY</span>
          <h2>Proxy & Routing</h2>
          <p>Routing strategy, upstream catalogs, failover scheduling, and ingress tunnel.</p>
        </header>
        <div className="settings-section-cards">
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
                  onChange={(event) => onRoutingStrategyChange(event.target.value)}
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
                  onChange={(event) => onRequestRetryChange(event.target.value)}
                />
              </Field>
              <Field label="Upstream proxy URL" hint="Leave blank to connect directly.">
                <Input
                  aria-label="Upstream proxy URL"
                  value={proxyUrl}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(event) => onProxyUrlChange(event.target.value)}
                />
              </Field>
              <label className="toggle-field">
                <input
                  aria-label="Show remaining quota"
                  type="checkbox"
                  checked={showRemaining}
                  onChange={(event) => onShowRemainingChange(event.target.checked)}
                />
                <span>
                  <strong>Show remaining quota</strong>
                  <small>Show how much quota is left instead of how much was used.</small>
                </span>
              </label>
              <label className="toggle-field">
                <input
                  aria-label="Write logs to file"
                  type="checkbox"
                  checked={loggingToFile}
                  onChange={(event) => onLoggingToFileChange(event.target.checked)}
                />
                <span>
                  <strong>Write logs to file</strong>
                  <small>Persist gateway diagnostics for the log viewer.</small>
                </span>
              </label>
            </div>
            <div className="connection-actions">
              <span>Saved values persist immediately.</span>
              <Button
                disabled={blocks(pending, "settings")}
                onClick={() => void onSaveProxySettings()}
              >
                {pending === "settings:save" ? "Saving…" : "Save proxy settings"}
              </Button>
            </div>
          </Card>
          {modelRegistryStatus || modelRegistryError ? (
            <Card className="settings-card" aria-label="Model registry">
              <header className="settings-card-head">
                <div className="settings-icon">
                  <Route size={17} />
                </div>
                <div>
                  <h2>Model registry</h2>
                  <p>
                    {modelRegistryStatus
                      ? `Catalog v${modelRegistryStatus["catalog-version"]} · source ${modelRegistryStatus.source} · ${modelRegistryStatus["model-count"]} models`
                      : "Active catalog and model resolution status."}
                  </p>
                </div>
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
              </header>
              {modelRegistryStatus?.["last-refresh"].outcome === "error" &&
              modelRegistryStatus["last-refresh"]["rejection-reason"] ? (
                <div className="state-panel warning" role="alert">
                  Refresh failure: {modelRegistryStatus["last-refresh"]["rejection-reason"]}
                </div>
              ) : null}
              {modelRegistryError ? (
                <div className="state-panel warning" role="alert">
                  {modelRegistryError}
                </div>
              ) : null}
              {onRefreshModelRegistry ? (
                <div className="settings-actions">
                  <Button
                    disabled={
                      blocks(pending, "registry") || modelRegistryStatus?.["refresh-in-flight"]
                    }
                    onClick={() => void onRefreshModelRegistry()}
                  >
                    {pending === "registry:refresh" || modelRegistryStatus?.["refresh-in-flight"]
                      ? "Refreshing…"
                      : "Refresh catalog"}
                  </Button>
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
                <h2>Account scheduling</h2>
                <p>Gateway-owned rotation with a manual order override.</p>
              </div>
              {schedulerStatus ? (
                <Badge
                  tone={
                    schedulerStatus.fail_open ? "warn" : schedulerStatus.enabled ? "ok" : "neutral"
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
                <input
                  aria-label="Enable scheduler"
                  type="checkbox"
                  checked={schedulerSettings.enabled}
                  disabled={schedulerPending}
                  onChange={(event) =>
                    void onSaveSchedulerSettings({ enabled: event.target.checked })
                  }
                />
                <span>
                  <strong>Enable scheduler</strong>
                  <small>
                    Ranks eligible quota by active reset time; default account priority follows the order set in the Accounts view.
                  </small>
                </span>
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
        <section className="settings-section" aria-label="Developer tools">
          <header className="settings-section-head">
            <span className="kicker">DEVELOPER WORKSPACES</span>
            <h2>Agents & Tools</h2>
            <p>Local coding agent environment configuration and isolated Codex sessions.</p>
          </header>
          <div className="settings-section-cards">{agentsSlot}</div>
        </section>
      ) : null}

      {totpVaultSlot ? (
        <section className="settings-section" aria-label="Security and credentials">
          <header className="settings-section-head">
            <span className="kicker">KEYRING CREDENTIALS</span>
            <h2>Security & 2FA Vault</h2>
            <p>Encrypted local credential store for two-factor authentication codes.</p>
          </header>
          <div className="settings-section-cards">{totpVaultSlot}</div>
        </section>
      ) : null}

      <section className="settings-section" aria-label="Storage and appearance">
        <header className="settings-section-head">
          <span className="kicker">DATA & PREFERENCES</span>
          <h2>Storage & Appearance</h2>
          <p>Durable request history records, model pricing ledger, and console appearance.</p>
        </header>
        <div className="settings-section-cards">
          {historyHealth || draftPrices.length > 0 ? (
            <Card className="settings-card" aria-label="History and pricing">
              <header className="settings-card-head">
                <div className="settings-icon">
                  <Settings2 size={17} />
                </div>
                <div>
                  <h2>History and pricing</h2>
                  <p>Durable request history health, retention policy, and current model prices.</p>
                </div>
                {historyHealth ? (
                  <Badge tone={historyHealth.degraded ? "warn" : "ok"}>
                    {historyHealth.degraded ? "Degraded" : "Ready"}
                  </Badge>
                ) : null}
              </header>
              {historyHealth ? (
                <p>
                  {historyHealth["written-events"].toLocaleString("en-US")} events written · queue{" "}
                  {historyHealth["queue-depth"]}/{historyHealth["queue-capacity"]}
                  {historyHealth["dropped-events"] > 0
                    ? ` · ${historyHealth["dropped-events"]} dropped`
                    : ""}
                </p>
              ) : null}
              {historyError ? <div className="state-panel warning">{historyError}</div> : null}
              {historyActionError ? (
                <div className="state-panel warning">{historyActionError}</div>
              ) : null}
              <div className="settings-actions">
                <Button
                  disabled={!exportHistory || historyBusy !== ""}
                  onClick={() => void runHistoryExport("csv")}
                >
                  {historyBusy === "csv" ? "Exporting…" : "Export CSV"}
                </Button>
                <Button
                  disabled={!exportHistory || historyBusy !== ""}
                  onClick={() => void runHistoryExport("json")}
                >
                  {historyBusy === "json" ? "Exporting…" : "Export JSON"}
                </Button>
                <Button
                  className="danger"
                  disabled={!clearHistory || historyBusy !== ""}
                  onClick={() => void requestClearConfirmation()}
                >
                  {historyBusy === "clear" ? "Clearing…" : "Clear history"}
                </Button>
              </div>
              {draftPrices.map((price, index) => (
                <div className="proxy-settings-grid" key={price.model}>
                  <Field
                    label={`Input price for ${price.model}`}
                    hint="USD per million input tokens."
                  >
                    <Input
                      aria-label={`Input price for ${price.model}`}
                      type="number"
                      step="0.01"
                      value={price["input-per-million"]}
                      onChange={(event) => {
                        const next = [...draftPrices];
                        next[index] = { ...price, "input-per-million": Number(event.target.value) };
                        setDraftPrices(next);
                      }}
                    />
                  </Field>
                  <strong>${estimatedSpend(price).toFixed(2)}</strong>
                  <Button onClick={() => void onSaveModelPrice(price)}>
                    Save {price.model} price
                  </Button>
                </div>
              ))}
            </Card>
          ) : null}
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
                  onThemeChange(nextTheme);
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
              <Button
                disabled={blocks(pending, "config")}
                onClick={() => void onOpenConfigEditor()}
              >
                {pending === "config:load" ? "Loading…" : "Open YAML editor"}
              </Button>
            </header>
          </Card>
        </div>
      </section>

      {confirmClear ? (
        <div className="history-dialog-backdrop">
          <dialog open className="history-dialog" aria-label="Clear request history">
            <h2>Clear request history</h2>
            <p>
              This permanently removes {clearCount?.toLocaleString("en-US") ?? "all stored"} request
              records and their dashboard history. It cannot be undone. Proxy file logs are not
              affected.
            </p>
            <div className="settings-actions">
              <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
              <Button className="danger" onClick={() => void confirmHistoryClear()}>
                Clear history
              </Button>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  );
}

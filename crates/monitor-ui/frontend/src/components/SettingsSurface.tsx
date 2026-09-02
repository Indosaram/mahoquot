import { Copy, Network, Route, Settings2, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  GatewayLifecycleStatus,
  NativeSettingsState,
  SecretStoreError,
  TunnelStatus,
  UpdateStatus,
} from "../lib/native";
import { blocks } from "../lib/pending";
import type { HistoryHealth, HistoryStatsResponse, ModelPrice } from "../lib/schemas";
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
  readonly onRoutingStrategyChange: (value: string) => void;
  readonly onRequestRetryChange: (value: string) => void;
  readonly onProxyUrlChange: (value: string) => void;
  readonly onLoggingToFileChange: (value: boolean) => void;
  readonly onSaveProxySettings: () => void | Promise<void>;
  readonly onThemeChange: (theme: "dark" | "light") => void;
  readonly onOpenConfigEditor: () => void | Promise<void>;
  readonly historyHealth: HistoryHealth | null;
  readonly historyStats: HistoryStatsResponse | null;
  readonly modelPrices?: readonly ModelPrice[];
  readonly onSaveModelPrice: (price: ModelPrice) => void | Promise<void>;
  readonly tunnelStatus: TunnelStatus;
  readonly tunnelBusy: boolean;
  readonly onDownloadCloudflared: () => void | Promise<void>;
  readonly onEnableTunnel: () => void | Promise<void>;
  readonly onDisableTunnel: () => void | Promise<void>;
  readonly onCopyTunnelUrl: () => void | Promise<void>;
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
  modelPrices = [],
  onSaveModelPrice,
  tunnelStatus,
  tunnelBusy,
  onDownloadCloudflared,
  onEnableTunnel,
  onDisableTunnel,
  onCopyTunnelUrl,
}: SettingsSurfaceProps) {
  const [draftPrices, setDraftPrices] = useState<readonly ModelPrice[]>(modelPrices);

  useEffect(() => setDraftPrices(modelPrices), [modelPrices]);

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
    <div className="content settings">
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
                Starts the owned gateway, tray, and compact notch while leaving the console hidden
                and unfocused.
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
                  {secretStoreError.action === "retry" ? "Retry secure storage" : "Re-enter key"}
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
      <TunnelCard
        status={tunnelStatus}
        busy={tunnelBusy}
        onDownload={onDownloadCloudflared}
        onEnable={onEnableTunnel}
        onDisable={onDisableTunnel}
        onCopyUrl={onCopyTunnelUrl}
      />
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
          <Button disabled={blocks(pending, "settings")} onClick={() => void onSaveProxySettings()}>
            {pending === "settings:save" ? "Saving…" : "Save proxy settings"}
          </Button>
        </div>
      </Card>
      {historyHealth && draftPrices.length > 0 ? (
        <Card
          className="settings-card"
          role={draftPrices.length ? "region" : undefined}
          aria-label={draftPrices.length ? "History and pricing" : undefined}
        >
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
              {30} days · {512} MB gateway policy
            </p>
          ) : null}
          {draftPrices.map((price, index) => (
            <div className="proxy-settings-grid" key={price.model}>
              <Field label={`Input price for ${price.model}`} hint="USD per million input tokens.">
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
              <Button onClick={() => void onSaveModelPrice(price)}>Save {price.model} price</Button>
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
              Edit the complete persisted gateway configuration. The document may contain secrets.
            </p>
          </div>
          <Button disabled={blocks(pending, "config")} onClick={() => void onOpenConfigEditor()}>
            {pending === "config:load" ? "Loading…" : "Open YAML editor"}
          </Button>
        </header>
      </Card>
    </div>
  );
}

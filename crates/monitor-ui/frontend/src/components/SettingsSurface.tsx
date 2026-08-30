import { Copy, Network, Route, Settings2, TerminalSquare } from "lucide-react";
import type { GatewayLifecycleStatus } from "../lib/native";
import { Badge, Button, Card, Field, Input } from "./ui";

export interface SettingsSurfaceProps {
  readonly notice?: string | undefined;
  readonly gatewayLifecycle: GatewayLifecycleStatus;
  readonly pending: string;
  readonly loadState: "loading" | "online" | "starting" | "stopped" | "relay-locked";
  readonly baseUrl: string;
  readonly gatewayUrlError?: string | null | undefined;
  readonly relayKey: string;
  readonly routingStrategy: string;
  readonly requestRetry: string;
  readonly proxyUrl: string;
  readonly loggingToFile: boolean;
  readonly theme: "dark" | "light";
  readonly onToggleGateway: () => void | Promise<void>;
  readonly onBaseUrlChange: (value: string) => void;
  readonly onRelayKeyChange: (value: string) => void;
  readonly onRelayKeyBlur: () => void;
  readonly onCopyRelayKey: () => void;
  readonly onSaveConnection: () => void;
  readonly onRoutingStrategyChange: (value: string) => void;
  readonly onRequestRetryChange: (value: string) => void;
  readonly onProxyUrlChange: (value: string) => void;
  readonly onLoggingToFileChange: (value: boolean) => void;
  readonly onSaveProxySettings: () => void | Promise<void>;
  readonly onThemeChange: (theme: "dark" | "light") => void;
  readonly onOpenConfigEditor: () => void | Promise<void>;
}

export function SettingsSurface({
  notice,
  gatewayLifecycle,
  pending,
  loadState,
  baseUrl,
  gatewayUrlError,
  relayKey,
  routingStrategy,
  requestRetry,
  proxyUrl,
  loggingToFile,
  theme,
  onToggleGateway,
  onBaseUrlChange,
  onRelayKeyChange,
  onRelayKeyBlur,
  onCopyRelayKey,
  onSaveConnection,
  onRoutingStrategyChange,
  onRequestRetryChange,
  onProxyUrlChange,
  onLoggingToFileChange,
  onSaveProxySettings,
  onThemeChange,
  onOpenConfigEditor,
}: SettingsSurfaceProps) {
  return (
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
          <Button disabled={pending !== ""} onClick={() => void onToggleGateway()}>
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
          <Button disabled={pending !== ""} onClick={() => void onSaveProxySettings()}>
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
          <Button disabled={pending !== ""} onClick={() => void onOpenConfigEditor()}>
            {pending === "config:load" ? "Loading…" : "Open YAML editor"}
          </Button>
        </header>
      </Card>
    </div>
  );
}

import { Cloud, Copy } from "lucide-react";
import type { TunnelStatus } from "../lib/native";
import { Badge, Button, Card } from "./ui";

export interface TunnelCardProps {
  readonly status: TunnelStatus;
  readonly busy: boolean;
  readonly onDownload: () => void | Promise<void>;
  readonly onEnable: () => void | Promise<void>;
  readonly onDisable: () => void | Promise<void>;
  readonly onCopyUrl: () => void | Promise<void>;
}

export function TunnelCard({
  status,
  busy,
  onDownload,
  onEnable,
  onDisable,
  onCopyUrl,
}: TunnelCardProps) {
  return (
    <Card className="settings-card tunnel-card">
      <header className="settings-card-head">
        <div className="settings-icon">
          <Cloud size={17} />
        </div>
        <div>
          <h2>Public tunnel</h2>
          <p>Optional cloudflared quick tunnel for this device's local gateway.</p>
        </div>
        <Badge tone={status.running ? "warn" : "neutral"}>
          {status.running ? "Public" : "Disabled"}
        </Badge>
      </header>
      <div className="tunnel-warning" role="note">
        <strong>Enabling this exposes your local gateway to the public internet.</strong>
        <span>
          Anyone with the URL can reach the gateway. Existing gateway authentication still applies,
          but the network boundary is no longer local. No provider credentials are stored in the
          tunnel configuration.
        </span>
      </div>
      {status.public_url ? (
        <div className="tunnel-url-row">
          <code>{status.public_url}</code>
          <Button aria-label="Copy public tunnel URL" onClick={() => void onCopyUrl()}>
            <Copy size={14} /> Copy URL
          </Button>
        </div>
      ) : null}
      <div className="connection-actions">
        <span>
          Disabled by default. Available only while the desktop owns a loopback HTTP gateway.
        </span>
        {!status.has_binary ? (
          <Button disabled={busy} onClick={() => void onDownload()}>
            {busy ? "Downloading…" : "Download verified cloudflared"}
          </Button>
        ) : status.running ? (
          <Button disabled={busy} onClick={() => void onDisable()}>
            {busy ? "Stopping…" : "Disable public tunnel"}
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => void onEnable()}>
            {busy ? "Starting…" : "Enable public tunnel"}
          </Button>
        )}
      </div>
    </Card>
  );
}

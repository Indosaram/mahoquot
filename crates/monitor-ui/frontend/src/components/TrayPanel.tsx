import {
  Ban,
  Copy,
  LayoutGrid,
  Play,
  RefreshCw,
  Square,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useMemo, useState } from "react";
import { type NormalizedAccount, formatResetTime } from "../lib/accounts";
import type { GatewayLifecycleStatus } from "../lib/native";
import type { TotpEntry } from "../lib/totp-vault";
import { quotaRows } from "./AccountsSurface";
import { ProviderGlyph } from "./ProviderGlyph";
import { TotpQuickAccess } from "./TotpVaultSurface";

interface TrayTile {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetIn: string | null;
}

interface TrayCard {
  readonly account: NormalizedAccount;
  readonly tiles: readonly TrayTile[];
}

const planBadge = (plan: string | null | undefined): string | null => {
  const normalized = plan?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "prolite") return "Pro 5x";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const tilesOf = (account: NormalizedAccount): readonly TrayTile[] =>
  quotaRows(account).map((row) => ({
    label: row.name,
    usedPercent: row.usedPercent,
    resetIn: row.resetSeconds !== null ? formatResetTime(row.resetSeconds) : null,
  }));

const formatCompact = (value: number): string =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);

const formatUsd = (value: number): string =>
  `$${value.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const providerChipLabel = (provider: string): string =>
  provider.charAt(0).toUpperCase() + provider.slice(1);

interface TrayPanelProps {
  readonly accounts: readonly NormalizedAccount[];
  readonly proxyUrl: string;
  readonly online: boolean;
  readonly gatewayLifecycle: GatewayLifecycleStatus;
  readonly fetchedAgoSecs: number | null;
  readonly refreshing: boolean;
  readonly showRemaining: boolean;
  readonly onRefresh: () => void;
  readonly onOpenConsole: () => void;
  readonly onQuit: () => void;
  readonly onStartGateway: () => void;
  readonly onStopGateway: () => void;
  readonly totpEntries?: readonly TotpEntry[];
  readonly totpCodes?: Readonly<Record<string, string>>;
  readonly totpRemaining?: number;
  readonly onCopyTotpCode?: (entry: TotpEntry, code: string) => void;
}

export const TrayPanel = ({
  accounts,
  proxyUrl,
  online,
  gatewayLifecycle,
  fetchedAgoSecs,
  refreshing,
  showRemaining,
  onRefresh,
  onOpenConsole,
  onQuit,
  onStartGateway,
  onStopGateway,
  totpEntries = [],
  totpCodes = {},
  totpRemaining = 0,
  onCopyTotpCode = () => undefined,
}: TrayPanelProps) => {
  const [filter, setFilter] = useState<string>("all");

  const providers = useMemo(
    () => [...new Set(accounts.map((account) => account.provider))],
    [accounts],
  );

  const visible = useMemo(
    () => (filter === "all" ? accounts : accounts.filter((account) => account.provider === filter)),
    [accounts, filter],
  );

  const cards: readonly TrayCard[] = visible.map((account) => ({
    account,
    tiles: tilesOf(account),
  }));

  return (
    <div className="tray-shell" data-mahoquot-surface="tray">
      <header className="tray-header">
        <strong>mahoquot</strong>
      </header>

      <div className="tray-totp-access">
        <TotpQuickAccess
          entries={totpEntries}
          codes={totpCodes}
          remaining={totpRemaining}
          onCopyCode={onCopyTotpCode}
          compact
        />
      </div>

      <div className={`tray-proxy ${online ? "online" : "offline"}`}>
        <span className="tray-proxy-dot" aria-hidden />
        <span className="tray-proxy-label">Proxy</span>
        <span className="tray-proxy-url">{proxyUrl}</span>
        <button
          type="button"
          className="tray-icon-button"
          aria-label="Copy proxy URL"
          onClick={() => void navigator.clipboard?.writeText(proxyUrl)}
        >
          <Copy size={13} />
        </button>
        {gatewayLifecycle === "running" && (
          <button
            type="button"
            className="tray-stop"
            aria-label="Stop gateway"
            onClick={onStopGateway}
          >
            <Square size={9} fill="currentColor" />
          </button>
        )}
      </div>

      {gatewayLifecycle !== "running" && (
        <button type="button" className="tray-start" onClick={onStartGateway}>
          <span className="tray-start-label">Start Gateway</span>
          <Play size={13} />
        </button>
      )}

      <div className="tray-chips" role="tablist" aria-label="Provider filter">
        <button
          type="button"
          role="tab"
          aria-selected={filter === "all"}
          className={`tray-chip${filter === "all" ? " active" : ""}`}
          onClick={() => setFilter("all")}
        >
          <LayoutGrid size={12} />
          All
        </button>
        {providers.map((provider) => (
          <button
            key={provider}
            type="button"
            role="tab"
            aria-selected={filter === provider}
            className={`tray-chip${filter === provider ? " active" : ""}`}
            data-provider={provider}
            onClick={() => setFilter(provider)}
          >
            <ProviderGlyph provider={provider} />
            {providerChipLabel(provider)}
          </button>
        ))}
      </div>

      <div className="tray-cards">
        {cards.map(({ account, tiles }) => (
          <article className="tray-card" key={account.id} data-provider={account.provider}>
            <div className="tray-card-head">
              <ProviderGlyph provider={account.provider} />
              <strong className="tray-card-name">{account.email || account.label}</strong>
              <button
                type="button"
                className="tray-icon-button"
                aria-label={`Refresh ${account.email || account.label}`}
                onClick={onRefresh}
              >
                <RefreshCw size={12} className={refreshing ? "tray-spin" : undefined} />
              </button>
              {planBadge(account.usage?.plan_type) && (
                <span className="tray-plan">{planBadge(account.usage?.plan_type)}</span>
              )}
            </div>
            {account.usage?.totals && (
              <div className="tray-totals" data-testid="tray-totals">
                <span>{account.usage.totals.requests.toLocaleString("en")} req</span>
                <span>{formatCompact(account.usage.totals.tokens)} tok</span>
                {account.usage.totals.total_cost_usd != null ? (
                  <span>{formatUsd(account.usage.totals.total_cost_usd)}</span>
                ) : null}
              </div>
            )}
            {account.usage?.windows?.length ? (
              <div className="tray-windows" data-testid="tray-windows">
                {account.usage.windows.map((window) => (
                  <span key={window.label}>
                    {window.label}: {window.requests.toLocaleString("en")} req
                    {window.cost_usd != null ? <> · {formatUsd(window.cost_usd)}</> : null}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="tray-tiles">
              {tiles.map((tile) => {
                const display = Math.round(
                  showRemaining ? Math.max(0, 100 - tile.usedPercent) : tile.usedPercent,
                );
                return (
                  <div className="tray-tile" key={tile.label}>
                    <div className="tray-tile-row">
                      <span className="tray-tile-name">{tile.label}</span>
                      {tile.resetIn && <span className="tray-tile-reset">{tile.resetIn}</span>}
                      <span
                        className={`tray-tile-percent${tile.usedPercent >= 100 ? " full" : ""}`}
                      >
                        {display}% {showRemaining ? "left" : "used"}
                      </span>
                    </div>
                    <div className={tileTone(tile.usedPercent)}>
                      <i style={{ width: `${display}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="tray-card-foot">
              {fetchedAgoSecs === null ? "" : `${fetchedAgoSecs} seconds ago`}
            </div>
          </article>
        ))}
        {!cards.length && (
          <div className="tray-empty" data-testid="tray-empty">
            {accounts.length
              ? "No accounts match this filter."
              : "No accounts or credentials found."}
          </div>
        )}
      </div>

      <footer className="tray-footer">
        <button type="button" onClick={onRefresh}>
          <RefreshCw size={14} className={refreshing ? "tray-spin" : undefined} /> Refresh
        </button>
        <button type="button" onClick={onOpenConsole}>
          <SquareArrowOutUpRight size={14} /> Open mahoquot
        </button>
        <button type="button" onClick={onQuit}>
          <Ban size={14} /> Quit mahoquot
        </button>
      </footer>
    </div>
  );
};

function tileTone(usedPercent: number): string {
  if (usedPercent >= 100) return "tray-bar full";
  if (usedPercent >= 80) return "tray-bar amber";
  return "tray-bar";
}

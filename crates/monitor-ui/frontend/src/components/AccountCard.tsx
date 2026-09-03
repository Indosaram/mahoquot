import {
  AlertTriangle,
  ChevronDown,
  GripVertical,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, type MouseEvent, useState } from "react";
import { type NormalizedAccount, formatResetTime } from "../lib/accounts";
import { blocks } from "../lib/pending";
import { getPlanTierColor } from "../lib/plan-tier";
import { relayPlanLabel } from "../lib/relay-plans";
import { formatQuotaPercent, quotaRows } from "./AccountsSurface";
import { ProviderGlyph } from "./ProviderGlyph";
import { Badge, Button, Card } from "./ui";

export const HealthBadge = ({ account }: { readonly account: NormalizedAccount }) => {
  const tone = account.health === "healthy" ? "ok" : account.health === "cooldown" ? "warn" : "bad";
  return <Badge tone={tone}>{account.health.replace("_", " ")}</Badge>;
};

export interface AccountCardProps {
  readonly account: NormalizedAccount;
  readonly pending: string;
  readonly dragging?: string | undefined;
  readonly confirmRemove?: string | undefined;
  readonly onRunAccountAction: (
    action: "warm" | "reset",
    account: NormalizedAccount,
  ) => void | Promise<void>;
  readonly onRefresh: () => void | Promise<void>;
  readonly onSetCredentialDisabled: (
    account: NormalizedAccount,
    disabled: boolean,
  ) => void | Promise<void>;
  readonly onReauthenticate: (account: NormalizedAccount) => void | Promise<void>;
  readonly onRemoveCredential: (account: NormalizedAccount) => void | Promise<void>;
  readonly onSetConfirmRemove: (accountId: string) => void;
  readonly onMoveCredential: (
    account: NormalizedAccount,
    direction: -1 | 1,
  ) => void | Promise<void>;
  readonly onDropCredential: (target: NormalizedAccount) => void | Promise<void>;
  readonly onSetDragging: (credentialName: string) => void;
  readonly onContextMenu: (event: MouseEvent, account: NormalizedAccount) => void;
}

const formatTokenCount = (tokens: number): string =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(tokens);

export const AccountCard = ({
  account,
  pending,
  dragging,
  confirmRemove,
  onRunAccountAction,
  onRefresh,
  onSetCredentialDisabled,
  onReauthenticate,
  onRemoveCredential,
  onSetConfirmRemove,
  onMoveCredential,
  onDropCredential,
  onSetDragging,
  onContextMenu,
}: AccountCardProps) => {
  // Only work targeting this account disables this card; a mutation on a
  // sibling card, or a settings save, leaves it interactive.
  const isPending = blocks(pending, "account", account.id);
  const rows = quotaRows(account);
  const [tokensOpen, setTokensOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissedErrorKey, setDismissedErrorKey] = useState<string | null>(null);

  const errorKey = account.lastError
    ? `${account.lastError.unix_ms}_${account.lastError.status}_${account.lastError.message}`
    : null;

  const handleRefresh = async () => {
    setRefreshing(true);
    if (errorKey) setDismissedErrorKey(errorKey);
    try {
      await onRefresh();
    } finally {
      // Keep spinning briefly so the user clearly sees the feedback
      setTimeout(() => setRefreshing(false), 400);
    }
  };

  const cleanDetail = (raw: string): string => {
    let d = raw;
    if (d.startsWith("codex-")) d = d.slice("codex-".length);
    const at = d.lastIndexOf("@");
    if (at > 0) {
      const p = d.slice(0, at).replace(/^[0-9a-fA-F]{8,}-/, "");
      const s = d.slice(at + 1).replace(/-(plus|prolite|pro|team|free|enterprise)(\.json)?$/i, "");
      return `${p}@${s}`;
    }
    return d;
  };

  const rawDetail = account.runtimeId ?? account.credentialName ?? "Credential only";
  const detail = cleanDetail(rawDetail);
  const detailRedundant =
    detail === account.label ||
    detail.toLowerCase().includes(account.label.toLowerCase()) ||
    account.label.toLowerCase().includes(detail.toLowerCase());

  return (
    <Card
      className="account-card"
      draggable={Boolean(account.credentialName) && !isPending}
      data-dragging={dragging === account.credentialName ? "true" : undefined}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onSetDragging(account.credentialName ?? "");
      }}
      onDragOver={(event) => {
        if (dragging && account.credentialName) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void onDropCredential(account);
      }}
      onDragEnd={() => onSetDragging("")}
      onContextMenu={(event) => onContextMenu(event, account)}
    >
      <div className="account-card-head">
        <div className="account-title">
          {account.credentialName ? (
            <button
              type="button"
              className="account-drag-handle"
              aria-label={`Reorder ${account.label}`}
              disabled={isPending}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  void onMoveCredential(account, event.key === "ArrowUp" ? -1 : 1);
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
            <span
              className={`plan-badge plan-badge-${getPlanTierColor(
                account.usage.plan_type,
                account.provider,
              )}`}
            >
              {account.usage.plan_type}
            </span>
          ) : null}
          <div className="account-id">
            <div>
              <strong title={account.label}>{account.label}</strong>
              <HealthBadge account={account} />
            </div>
            {detailRedundant ? null : <span title={detail}>{detail}</span>}
          </div>
        </div>
        <div className="account-actions">
          <Button
            disabled={!account.runtimeId || isPending}
            onClick={() => void onRunAccountAction("warm", account)}
          >
            <Sparkles size={14} />
            {pending === `warm:${account.id}` ? "Warming…" : "Warm up"}
          </Button>
          <Button
            aria-label="Refresh quota"
            disabled={!account.runtimeId || isPending || refreshing}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : ""} /> Refresh
          </Button>
          {account.canReset ? (
            <Button
              disabled={!account.runtimeId || isPending}
              onClick={() => void onRunAccountAction("reset", account)}
            >
              <RotateCcw size={14} />
              {pending === `reset:${account.id}` ? "Resetting…" : "Reset window"}
            </Button>
          ) : null}
          {account.credentialName ? (
            <>
              <Button
                aria-label={`${account.disabled ? "Enable" : "Disable"} ${account.label}`}
                disabled={isPending}
                onClick={() => void onSetCredentialDisabled(account, !account.disabled)}
              >
                {pending === `status:${account.id}`
                  ? "Saving…"
                  : account.disabled
                    ? "Enable"
                    : "Disable"}
              </Button>
              <Button
                aria-label={`Re-authenticate ${account.label}`}
                disabled={isPending || blocks(pending, "onboarding")}
                onClick={() => void onReauthenticate(account)}
              >
                {pending === `auth:${account.provider}` ? "Starting…" : "Re-auth"}
              </Button>
              {confirmRemove === account.id ? (
                <>
                  <Button
                    aria-label={`Confirm removing ${account.label}`}
                    disabled={isPending}
                    onClick={() => void onRemoveCredential(account)}
                  >
                    <Trash2 size={14} />
                    {pending === `remove:${account.id}` ? "Removing…" : "Confirm"}
                  </Button>
                  <Button
                    aria-label={`Cancel removing ${account.label}`}
                    onClick={() => onSetConfirmRemove("")}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  aria-label={`Remove ${account.label}`}
                  disabled={isPending}
                  onClick={() => onSetConfirmRemove(account.id)}
                >
                  <Trash2 size={14} /> Remove
                </Button>
              )}
            </>
          ) : null}
        </div>
      </div>
      <div className="token-usage" aria-label="Token usage">
        <button
          type="button"
          className="token-usage-toggle"
          aria-expanded={tokensOpen}
          onClick={() => setTokensOpen((open) => !open)}
        >
          <ChevronDown size={13} aria-hidden="true" />
          <span>Tokens</span>
          <strong title={account.totalTokens.toLocaleString()}>
            {formatTokenCount(account.totalTokens)}
          </strong>
        </button>
        {tokensOpen ? (
          <div className="token-usage-summary">
            <div>
              <span>Input</span>
              <strong title={account.inputTokens.toLocaleString()}>
                {formatTokenCount(account.inputTokens)}
              </strong>
            </div>
            <div>
              <span>Output</span>
              <strong title={account.outputTokens.toLocaleString()}>
                {formatTokenCount(account.outputTokens)}
              </strong>
            </div>
            <div>
              <span>Total tokens</span>
              <strong title={account.totalTokens.toLocaleString()}>
                {formatTokenCount(account.totalTokens)}
              </strong>
            </div>
          </div>
        ) : null}
      </div>
      <div className="usage-section">
        {account.usage?.totals ? (
          <div className="usage-totals" data-testid="account-usage-totals">
            {account.plan ? (
              <>
                <strong data-testid="account-plan">{relayPlanLabel(account.plan)}</strong>
                <span>·</span>
              </>
            ) : null}
            <strong>{account.usage.totals.requests.toLocaleString("en")}</strong> req
            <span>·</span>
            <strong>
              {new Intl.NumberFormat("en", {
                notation: "compact",
                maximumFractionDigits: 2,
              }).format(account.usage.totals.tokens)}
            </strong>{" "}
            tok
            {account.usage.totals.total_cost_usd != null ? (
              <>
                <span>·</span>
                <strong>${account.usage.totals.total_cost_usd.toFixed(2)}</strong>
              </>
            ) : null}
          </div>
        ) : null}
        {account.usage?.windows?.length ? (
          <div className="usage-windows" data-testid="account-usage-windows">
            {account.usage.windows.map((window) => (
              <span key={window.label}>
                {window.label}{" "}
                <strong>
                  {window.cost_usd != null
                    ? `$${window.cost_usd.toFixed(2)}`
                    : `${window.tokens.toLocaleString("en")} tok`}
                </strong>
              </span>
            ))}
          </div>
        ) : null}
        {rows.length ? (
          <div className="quota-list">
            {rows.map((row, index, list) => {
              const remaining = Math.max(0, 100 - row.usedPercent);
              const startsGroup = row.group !== null && row.group !== list[index - 1]?.group;
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
      {account.lastError && dismissedErrorKey !== errorKey ? (
        <div className="account-error">
          <AlertTriangle size={14} />
          <span className="account-error-message">
            {account.lastError.message || `HTTP ${account.lastError.status}`}
          </span>
          <button
            type="button"
            className="account-error-dismiss"
            aria-label="Dismiss error"
            onClick={() => setDismissedErrorKey(errorKey)}
          >
            <X size={12} />
          </button>
        </div>
      ) : null}
      {!account.runtimeId ? (
        <div className="restart-note">
          {account.disabled
            ? "Disabled — enable this account to load it into the runtime pool."
            : "Credential saved but the gateway could not load it into the runtime pool."}
        </div>
      ) : null}
    </Card>
  );
};

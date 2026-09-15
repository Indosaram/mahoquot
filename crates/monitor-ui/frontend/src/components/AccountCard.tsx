import {
  AlertTriangle,
  GripVertical,
  KeyRound,
  MoreHorizontal,
  Power,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { type NormalizedAccount, formatResetTime } from "../lib/accounts";
import { blocks } from "../lib/pending";
import { getPlanTierColor } from "../lib/plan-tier";
import { relayPlanLabel } from "../lib/relay-plans";
import { AccountResetCredits } from "./AccountResetCredits";
import { formatQuotaPercent, quotaRows } from "./AccountsSurface";
import { ProviderGlyph } from "./ProviderGlyph";
import { Badge, Button, Card } from "./ui";
import { type WarmupControlsState } from "./WarmupControls";
import type { WarmupAccountStatus } from "../lib/schemas";

export const HealthBadge = ({ account }: { readonly account: NormalizedAccount }) => {
  const tone =
    account.health === "healthy"
      ? "ok"
      : account.health === "cooldown" || account.health === "auth_required"
        ? "warn"
        : account.health === "disabled"
          ? "neutral"
          : "bad";
  return (
    <Badge tone={tone}>
      {account.health === "auth_required" ? "auth required" : account.health.replace("_", " ")}
    </Badge>
  );
};

export const WarmupBadge = ({
  status,
  health,
}: {
  readonly status: WarmupAccountStatus | undefined;
  readonly health?: string;
}) => {
  // Only show Warmed badge if quota window is active AND account is in healthy status
  if (!status?.window_active || health !== "healthy") return null;
  const resetTimeStr = status.window_reset_at
    ? new Date(status.window_reset_at * 1000).toLocaleTimeString()
    : null;
  const title = resetTimeStr
    ? `Warmed: quota window active (resets at ${resetTimeStr})`
    : "Warmed: quota window active";

  return (
    <Badge tone="ok" title={title}>
      <Sparkles size={11} style={{ marginRight: 3, verticalAlign: "-1px" }} />
      Warmed
    </Badge>
  );
};

export interface AccountCardProps {
  readonly warmup?: WarmupControlsState | undefined;
  readonly account: NormalizedAccount;
  readonly pending: string;
  readonly showRemaining?: boolean;
  readonly dragging?: string | undefined;
  readonly confirmRemove?: string | undefined;
  readonly devinModels?: readonly string[] | undefined;
  readonly discoveryState?:
    | "never_loaded"
    | "stale"
    | "error"
    | "available"
    | "empty"
    | "unknown"
    | undefined;
  readonly onRunAccountAction: (
    action: "warm" | "reset",
    account: NormalizedAccount,
  ) => void | Promise<void>;
  readonly onRefresh: (account?: NormalizedAccount) => void | Promise<void>;
  readonly onSetCredentialDisabled: (
    account: NormalizedAccount,
    disabled: boolean,
  ) => void | Promise<void>;
  readonly onReauthenticate: (account: NormalizedAccount) => void | Promise<void>;
  readonly onReimportCredential?: (account: NormalizedAccount) => void | Promise<void>;
  readonly onRefreshDiscovery?: (account: NormalizedAccount) => void | Promise<void>;
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

interface OverflowAction {
  readonly key: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly icon: ReactNode;
  readonly disabled: boolean;
  readonly danger?: boolean;
  readonly title?: string;
  readonly run: () => void;
}

/**
 * The lifecycle actions a card offers outnumber the width its header can spend
 * on labels, so the rare ones live behind one trigger. Keeping them in a menu
 * rather than shrinking every button is what stops the title from being
 * squeezed into an unreadable stub.
 */
const AccountOverflowMenu = ({
  label,
  actions,
}: { readonly label: string; readonly actions: readonly OverflowAction[] }) => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <span className="account-overflow">
      <Button
        size="sm"
        className="button-icon"
        aria-label={`More actions for ${label}`}
        aria-expanded={open}
        aria-haspopup="menu"
        // The window dismiss handler would otherwise close on pointerdown and
        // let the click immediately reopen the menu.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={14} />
      </Button>
      {open ? (
        <div
          className="account-overflow-menu"
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className="account-overflow-item"
              data-danger={action.danger ? "true" : undefined}
              aria-label={action.ariaLabel}
              title={action.title}
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                action.run();
              }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
};

export const AccountCard = ({
  warmup,
  account,
  pending,
  showRemaining = true,
  dragging,
  confirmRemove,
  devinModels,
  discoveryState,
  onRunAccountAction,
  onRefresh,
  onSetCredentialDisabled,
  onReauthenticate,
  onReimportCredential,
  onRefreshDiscovery,
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
    if (d.startsWith("cline-")) d = d.slice("cline-".length);
    if (d.endsWith(".json")) d = d.slice(0, -5);
    if (d.startsWith("generic-cline-oauth-")) return account.email || "Cline OAuth";
    const at = d.lastIndexOf("@");
    if (at > 0) {
      const p = d.slice(0, at).replace(/^[0-9a-fA-F]{8,}-/, "");
      const s = d.slice(at + 1).replace(/-(plus|prolite|pro|team|free|enterprise)(\.json)?$/i, "");
      return `${p}@${s}`;
    }
    return d;
  };

  const isDevin = account.provider === "devin";
  const warmupStatus = account.runtimeId
    ? warmup?.status?.accounts[account.runtimeId]
    : account.id
      ? warmup?.status?.accounts[account.id]
      : undefined;
  const resolvedModels = devinModels ?? (isDevin ? account.models : undefined);
  const resolvedDiscoveryState =
    discoveryState ??
    (isDevin
      ? account.lastError && /model|discover/i.test(account.lastError.message)
        ? ("error" as const)
        : resolvedModels === undefined
          ? ("unknown" as const)
          : resolvedModels.length === 0
            ? ("empty" as const)
            : ("available" as const)
      : undefined);

  // Warm up and Refresh stay in the row because they are the routine actions;
  // everything below is rare or destructive and does not deserve permanent
  // header width.
  const overflowActions: OverflowAction[] = [];
  if (warmup) overflowActions.push({
    key: "warmup-settings", label: "Warmup settings", ariaLabel: `Warmup settings for ${account.label}`,
    icon: <Sparkles size={13} />, disabled: false, run: () => warmup.onOpen("account", account.id),
  });
  if (account.supportsReset) {
    // The label names the price, not just the outcome: "Reset window" left it
    // ambiguous whether the item reported banked credits or spent one.
    const canSpendReset = account.canReset;
    overflowActions.push({
      key: "reset",
      label: canSpendReset ? "Spend 1 banked reset" : "No banked resets",
      ariaLabel: canSpendReset
        ? `Spend 1 banked reset for ${account.label}`
        : `No banked resets for ${account.label}`,
      icon: <RotateCcw size={13} />,
      title: canSpendReset
        ? `Spends one of ${account.resetCreditsAvailable} banked resets to start a fresh quota window`
        : "No banked resets available",
      disabled: !account.runtimeId || isPending || !canSpendReset,
      run: () => void onRunAccountAction("reset", account),
    });
  }
  if (account.credentialName) {
    overflowActions.push(
      {
        key: "status",
        label:
          pending === `status:${account.id}`
            ? "Saving…"
            : account.disabled
              ? "Enable account"
              : "Disable account",
        ariaLabel: `${account.disabled ? "Enable" : "Disable"} ${account.label}`,
        icon: <Power size={13} />,
        disabled: isPending,
        run: () => void onSetCredentialDisabled(account, !account.disabled),
      },
      {
        key: "auth",
        label:
          account.provider === "devin"
            ? pending === `auth:${account.provider}`
              ? "Starting…"
              : "Re-authenticate / Update token"
            : pending === `auth:${account.provider}`
              ? "Starting…"
              : "Re-authenticate",
        ariaLabel: `Re-authenticate ${account.label}`,
        icon: <KeyRound size={13} />,
        disabled: isPending || blocks(pending, "onboarding"),
        run: () => void onReauthenticate(account),
      },
    );
    if (account.provider === "devin" && onReimportCredential) {
      overflowActions.push({
        key: "reimport-cli",
        label: pending === `reimport:${account.id}` ? "Importing…" : "Re-import from host CLI",
        ariaLabel: `Re-import ${account.label} from host CLI`,
        icon: <RefreshCw size={13} />,
        disabled: isPending,
        run: () => void onReimportCredential(account),
      });
    }
    if (account.provider === "devin" && onRefreshDiscovery) {
      overflowActions.push({
        key: "refresh-discovery",
        label: pending === `discovery:${account.id}` ? "Refreshing…" : "Refresh model discovery",
        ariaLabel: `Refresh model discovery for ${account.label}`,
        icon: <RefreshCw size={13} />,
        disabled: isPending,
        run: () => void onRefreshDiscovery(account),
      });
    }
    overflowActions.push({
      key: "remove",
      label: "Remove account",
      ariaLabel: `Remove ${account.label}`,
      icon: <Trash2 size={13} />,
      danger: true,
      disabled: isPending,
      run: () => onSetConfirmRemove(account.id),
    });
  }

  const rawDetail = account.runtimeId ?? account.credentialName ?? "Credential only";
  const detail = cleanDetail(rawDetail);
  const detailRedundant =
    detail === account.label ||
    detail.toLowerCase().includes(account.label.toLowerCase()) ||
    account.label.toLowerCase().includes(detail.toLowerCase());

  return (
    <Card
      className="account-card"
      data-disabled={account.disabled ? "true" : undefined}
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
              <WarmupBadge status={warmupStatus} health={account.health} />
              <AccountResetCredits account={account} />
            </div>
            {detailRedundant ? null : <span title={detail}>{detail}</span>}
          </div>
        </div>
        <div className="account-actions">
          <Button
            size="sm"
            data-warm-account={account.id}
            aria-label={warmup ? `Warm settings for ${account.label}` : undefined}
            disabled={warmup ? false : !account.runtimeId || isPending}
            onClick={() => warmup ? warmup.onOpen("account", account.id) : void onRunAccountAction("warm", account)}
          >
            <Sparkles size={12} />
            {warmup ? "Warm settings" : pending === `warm:${account.id}` ? "Warming…" : "Warm up"}
          </Button>
          <Button
            size="sm"
            aria-label="Refresh quota"
            disabled={(!account.runtimeId && !account.credentialName) || isPending || refreshing}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={12} className={refreshing ? "spin" : ""} /> Refresh
          </Button>
          {confirmRemove === account.id ? (
            <>
              <Button
                size="sm"
                variant="danger"
                aria-label={`Confirm removing ${account.label}`}
                disabled={isPending}
                onClick={() => void onRemoveCredential(account)}
              >
                <Trash2 size={12} />
                {pending === `remove:${account.id}` ? "Removing…" : "Confirm"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Cancel removing ${account.label}`}
                onClick={() => onSetConfirmRemove("")}
              >
                <X size={12} /> Cancel
              </Button>
            </>
          ) : pending === `reset:${account.id}` ? (
            <Button size="sm" disabled>
              <RotateCcw size={12} className="spin" /> Resetting…
            </Button>
          ) : (
            <AccountOverflowMenu label={account.label} actions={overflowActions} />
          )}
        </div>
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
              const percent = showRemaining ? Math.max(0, 100 - row.usedPercent) : row.usedPercent;
              const startsGroup = row.group !== null && row.group !== list[index - 1]?.group;
              return (
                <Fragment key={`${row.group ?? ""}-${row.name}-${index}`}>
                  {startsGroup ? <div className="quota-group">{row.group}</div> : null}
                  <div className="quota-row">
                    <span className="quota-name">{row.name}</span>
                    <span
                      className="quota-track"
                      role="meter"
                      aria-label={`${row.name} ${showRemaining ? "remaining" : "used"}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.min(100, percent)}
                    >
                      <i style={{ width: `${Math.min(100, percent)}%` }} />
                    </span>
                    <span className="quota-meta">
                      <strong>{formatQuotaPercent(percent)}%</strong>
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
      {isDevin && resolvedDiscoveryState ? (
        <div className="account-discovery" data-testid="devin-discovery">
          <small className="account-discovery-label">Models:</small>{" "}
          {resolvedDiscoveryState === "error" ? (
            <Badge tone="bad">Discovery error</Badge>
          ) : resolvedDiscoveryState === "stale" ? (
            <Badge tone="warn">Stale models</Badge>
          ) : resolvedDiscoveryState === "never_loaded" ? (
            <Badge tone="neutral">Never loaded</Badge>
          ) : resolvedDiscoveryState === "unknown" ? (
            <Badge tone="neutral">Unknown</Badge>
          ) : resolvedDiscoveryState === "empty" ? (
            <Badge tone="neutral">No models</Badge>
          ) : (
            <span className="account-discovery-list">
              {resolvedModels && resolvedModels.length > 0
                ? resolvedModels.join(", ")
                : "Available"}
            </span>
          )}
        </div>
      ) : null}
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
      {!account.runtimeId && !account.disabled ? (
        <div className="restart-note">
          Credential saved but the gateway could not load it into the runtime pool.
        </div>
      ) : null}
    </Card>
  );
};

import { AlertTriangle } from "lucide-react";
import type { MouseEvent } from "react";
import type { NormalizedAccount } from "../lib/accounts";
import { extractDevinSlug } from "../lib/accounts";
import { blocks } from "../lib/pending";
import { CLINE_QUOTA_DISPLAY_DEFAULT, clineQuotaSlug } from "../lib/storage";
import type { DevinAccountStatus, GatewayModelEntry, ModelRegistryStatus, QuotaWindow } from "../lib/schemas";
import { AccountCard, HealthBadge } from "./AccountCard";
import type { ContextMenuItem } from "./ContextMenu";
import { ProviderGlyph, providerLabel } from "./ProviderGlyph";
import {
  AccountWarmupControls,
  ProviderWarmupControls,
  type WarmupControlsState,
  WarmupDialog,
} from "./WarmupControls";
import { Stack } from "./layout";
import { Button } from "./ui";

export { HealthBadge, ProviderGlyph, providerLabel };

export type QuotaRow = {
  readonly name: string;
  readonly group: string | null;
  /**
   * `null` = the provider reported no number (unmeasured). Deliberately not
   * `0`: printing "0% used" for an unmeasured window claims the quota is
   * untouched when nobody measured it, which is the ambiguity that makes a
   * card showing one lane confusing next to a summary counting it as unmeasured.
   */
  readonly usedPercent: number | null;
  readonly resetSeconds: number | null;
};

/** Remaining-vs-used conversion; `null` in stays `null` out. */
export const quotaDisplay = (
  usedPercent: number | null,
  showRemaining: boolean,
): number | null => {
  if (usedPercent === null) return null;
  return showRemaining ? Math.max(0, 100 - usedPercent) : usedPercent;
};

export const formatQuotaPercent = (percent: number): string => {
  if (percent > 0 && percent < 0.01) return "<0.01";
  if (percent < 1) return percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return Math.round(percent).toString();
};

export const windowLabel = (raw: string): string =>
  raw
    .replace(/\s*limit(\s+remaining)?$/i, "")
    .replace(/\s*remaining$/i, "")
    .trim() || raw;

export const resetSeconds = (resetAtUnix?: number | null, after?: number | null): number | null => {
  if (typeof resetAtUnix === "number") {
    return Math.max(0, resetAtUnix - Math.floor(Date.now() / 1000));
  }
  return typeof after === "number" ? Math.max(0, after) : null;
};

/**
 * Cline CLI OAuth does not report live quota windows; a 100% bucket is inferred
 * only while a 429 daily cap cooldown is active under "Cline Free Limits".
 * Once that explicit deadline lapses, the inferred 100% quota has expired and
 * becomes unknown (not a fabricated 0%).
 * Unknown-deadline reported 100 is preserved unless explicit evidence expires it.
 * Non-Cline providers and other group labels are strictly preserved.
 */
export const isClineInferredQuotaExpired = (
  account: NormalizedAccount,
  groupDisplayName: string | null | undefined,
  resetAtUnix?: number | null,
  resetAfterSeconds?: number | null,
  nowMs = Date.now(),
): boolean => {
  if (account.provider !== "cline") {
    return false;
  }
  if (groupDisplayName !== "Cline Free Limits") {
    return false;
  }

  const nowSecs = Math.floor(nowMs / 1000);
  if (typeof resetAtUnix === "number") {
    return resetAtUnix <= nowSecs;
  }
  if (typeof resetAfterSeconds === "number") {
    if (typeof account.usage?.observed_at_unix === "number") {
      return account.usage.observed_at_unix + resetAfterSeconds <= nowSecs;
    }
    return resetAfterSeconds <= 0;
  }

  return false;
};

/**
 * Format explicit window duration matching Codex / AI quota window conventions.
 * Derived strictly from actual window_minutes or explicit bucket window contract string (e.g. "5h", "300m", "week", "10080m").
 * NEVER falls back to reset_after_seconds (which is a remaining countdown, NOT window duration).
 */
export const formatQuotaDuration = (
  minutes?: number | null,
  windowContract?: string | null,
): string | null => {
  let m: number | null =
    typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : null;

  if (m === null && typeof windowContract === "string") {
    const trimmed = windowContract.trim().toLowerCase();
    if (trimmed === "5h") return "5h";
    if (trimmed === "weekly" || trimmed === "week" || trimmed === "7d") return "week";
    if (trimmed.endsWith("m")) {
      const parsed = Number.parseInt(trimmed.slice(0, -1), 10);
      if (Number.isFinite(parsed) && parsed > 0) m = parsed;
    } else if (trimmed.endsWith("h")) {
      const parsed = Number.parseInt(trimmed.slice(0, -1), 10);
      if (Number.isFinite(parsed) && parsed > 0) m = parsed * 60;
    } else if (trimmed.endsWith("d")) {
      const parsed = Number.parseInt(trimmed.slice(0, -1), 10);
      if (Number.isFinite(parsed) && parsed > 0) m = parsed * 24 * 60;
    } else if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed) && parsed > 0) m = parsed;
    } else if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (m === null || m <= 0) return null;

  if (m === 300) return "5h";
  if (m === 10080) return "week";
  if (m % (24 * 60) === 0) {
    const days = m / (24 * 60);
    return days === 7 ? "week" : `${days}d`;
  }
  if (m % 60 === 0) {
    const hours = m / 60;
    return `${hours}h`;
  }
  return `${m}m`;
};

export const isGenericQuotaWindowName = (name?: string | null): boolean => {
  if (!name) return true;
  return /^(primary|secondary)(\s*(window|limit))?$/i.test(name.trim());
};

const alreadyHasDuration = (name: string, duration: string): boolean => {
  const lower = name.toLowerCase();
  if (lower.includes(duration.toLowerCase())) return true;
  if (duration === "5h" && /5\s*h(our)?/i.test(lower)) return true;
  if (duration === "5h" && lower === "session") return true;
  if (duration === "week" && /week/i.test(lower)) return true;
  if (/(\d+)\s*(h|hour|m|min|d|day|week|month)/i.test(lower)) return true;
  return false;
};

export const formatQuotaWindowName = (
  window: QuotaWindow | null | undefined,
  fallbackSlotName: "Primary window" | "Secondary window",
): string => {
  if (!window) return fallbackSlotName;
  const duration = formatQuotaDuration(window.window_minutes);
  const rawName = window.limit_name?.trim();

  // If a meaningful limit name is provided (not generic Primary/Secondary):
  if (rawName && !isGenericQuotaWindowName(rawName)) {
    // If duration is also known and not already contained in rawName, qualify with duration:
    if (duration && !alreadyHasDuration(rawName, duration)) {
      return `${rawName} (${duration})`;
    }
    return rawName;
  }

  // Generic or missing limit_name: label with actual duration if known
  if (duration) {
    return duration;
  }

  return rawName || fallbackSlotName;
};

export const quotaRows = (
  account: NormalizedAccount,
  clineQuotaDisplay: readonly string[] = CLINE_QUOTA_DISPLAY_DEFAULT,
): readonly QuotaRow[] => {
  const usage = account.usage;
  if (!usage) return [];

  const isWindowActive = (w?: QuotaWindow | null): boolean => {
    if (!w) return false;
    return (
      typeof w.used_percent === "number" ||
      (typeof w.window_minutes === "number" && w.window_minutes > 0) ||
      (typeof w.reset_after_seconds === "number" && w.reset_after_seconds > 0) ||
      typeof w.reset_at_unix === "number" ||
      (typeof w.limit_name === "string" && w.limit_name.trim().length > 0)
    );
  };

  const flatRows: QuotaRow[] = [];
  const flatResetSeconds = (window: QuotaWindow | null | undefined): number | null => {
    if (
      account.provider === "codex" &&
      window?.used_percent === 0 &&
      typeof window.window_minutes === "number" &&
      window.reset_after_seconds === window.window_minutes * 60
    ) return null;
    return resetSeconds(window?.reset_at_unix, window?.reset_after_seconds);
  };
  if (isWindowActive(usage.primary)) {
    const raw = usage.primary?.used_percent;
    flatRows.push({
      name: formatQuotaWindowName(usage.primary, "Primary window"),
      group: null,
      usedPercent: typeof raw === "number" ? raw : null,
      resetSeconds: flatResetSeconds(usage.primary),
    });
  }
  if (isWindowActive(usage.secondary)) {
    const raw = usage.secondary?.used_percent;
    flatRows.push({
      name: formatQuotaWindowName(usage.secondary, "Secondary window"),
      group: null,
      usedPercent: typeof raw === "number" ? raw : null,
      resetSeconds: flatResetSeconds(usage.secondary),
    });
  }

  const groupRows: QuotaRow[] = [];
  usage.groups?.forEach((group) => {
    group.buckets.forEach((bucket, index) => {
      // Display selection: the gateway records a daily bucket for every Cline
      // model it serves; only the slugs picked in Settings render. A bucket
      // without an id stays visible rather than vanish by accident.
      if (
        account.provider === "cline" &&
        group.display_name === "Cline Free Limits" &&
        bucket.bucket_id &&
        !clineQuotaDisplay.includes(clineQuotaSlug(bucket.bucket_id))
      ) {
        return;
      }
      if (
        isClineInferredQuotaExpired(
          account,
          group.display_name,
          bucket.reset_at_unix,
          bucket.reset_after_seconds,
        )
      ) {
        return;
      }
      const raw = bucket.used_percent;
      const measured = typeof raw === "number";
      const bucketDuration = formatQuotaDuration(
        bucket.window_minutes,
        bucket.window,
      );
      const rawBucketName =
        bucket.display_name ||
        bucket.bucket_id ||
        (bucket.window ? `${bucket.window}` : null) ||
        `Quota ${index + 1}`;
      const bucketName = windowLabel(rawBucketName);
      const displayName =
        bucketDuration &&
        !alreadyHasDuration(bucketName, bucketDuration) &&
        !isGenericQuotaWindowName(bucketName)
          ? `${bucketName} (${bucketDuration})`
          : bucketDuration && isGenericQuotaWindowName(bucketName)
            ? bucketDuration
            : bucketName;

      groupRows.push({
        name: displayName,
        group: group.display_name || group.models || null,
        usedPercent: measured ? raw : null,
        resetSeconds: resetSeconds(bucket.reset_at_unix, bucket.reset_after_seconds),
      });
    });
  });

  // Documented aggregate projection suppression:
  // Antigravity synthesizes primary/secondary flat windows from the worst bucket
  // across groups for legacy rotation logic. If groups are present on Antigravity,
  // suppress the synthetic flat projections so only the true model groups appear.
  if (account.provider === "antigravity" && groupRows.length > 0) {
    return groupRows;
  }

  // For Codex and all other providers: preserve both basic flat limits and additional
  // group limits regardless of coincident values. Do not dedup across group identities.
  return [...flatRows, ...groupRows];
};

export type ClinePoolModelSummary = {
  readonly model: string;
  readonly total: number;
  readonly available: number;
  readonly unmeasured: number;
  readonly exhausted: number;
  readonly remainingSumPercent: number;
  readonly nextResetAtUnix: number | null;
};

// The pooled Cline free models summarized across every account — one row per
// slug the operator chose to display (Settings → Cline daily quota display).
// Buckets match on the bare model name so both vendor-prefixed labels
// ("deepseek/..." from upstream cap errors and "cline-free/..." from live
// requests) fold into one figure. Quota percentages are gateway estimates.
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const clinePoolQuotaSummary = (
  accounts: readonly NormalizedAccount[],
  nowMs = Date.now(),
  clineQuotaDisplay: readonly string[] = CLINE_QUOTA_DISPLAY_DEFAULT,
): readonly ClinePoolModelSummary[] => {
  const clineAccounts = accounts.filter((account) => account.provider === "cline");
  if (clineAccounts.length === 0) return [];
  const nowSecs = Math.floor(nowMs / 1000);

  return clineQuotaDisplay.map((slug) => {
    const model = `cline-free/${slug}`;
    const pattern = new RegExp(escapeRegExp(slug), "i");
    let available = 0;
    let unmeasured = 0;
    let exhausted = 0;
    let remainingSumPercent = 0;
    let nextResetAtUnix: number | null = null;

    for (const account of clineAccounts) {
      const clineGroup = account.usage?.groups?.find(
        (group) =>
          group.display_name === "Cline Free Limits" ||
          group.display_name?.toLowerCase() === "cline free limits",
      );
      let measured = false;
      let accountRemaining: number | null = null;
      let accountResetAtUnix: number | null = null;

      for (const bucket of clineGroup?.buckets ?? []) {
        const label = bucket.display_name || bucket.bucket_id || bucket.window || "";
        if (!pattern.test(label)) continue;
        if (typeof bucket.used_percent !== "number") continue;
        if (
          isClineInferredQuotaExpired(
            account,
            clineGroup?.display_name,
            bucket.reset_at_unix,
            bucket.reset_after_seconds,
            nowMs,
          )
        ) {
          continue;
        }
        measured = true;
        const remaining = Math.max(0, 100 - bucket.used_percent);
        accountRemaining =
          accountRemaining === null ? remaining : Math.min(accountRemaining, remaining);
        if (bucket.used_percent >= 100) {
          let deadline: number | null = null;
          if (typeof bucket.reset_at_unix === "number" && bucket.reset_at_unix > nowSecs) {
            deadline = bucket.reset_at_unix;
          } else if (
            typeof bucket.reset_after_seconds === "number" &&
            bucket.reset_after_seconds > 0 &&
            typeof account.usage?.observed_at_unix === "number" &&
            account.usage.observed_at_unix + bucket.reset_after_seconds > nowSecs
          ) {
            deadline = account.usage.observed_at_unix + bucket.reset_after_seconds;
          }
          if (deadline !== null) {
            accountResetAtUnix =
              accountResetAtUnix === null ? deadline : Math.min(accountResetAtUnix, deadline);
          }
        }
      }

      if (measured) remainingSumPercent += accountRemaining ?? 100;
      if (account.modelRoutability?.[model] === false) {
        exhausted += 1;
        if (accountResetAtUnix !== null) {
          nextResetAtUnix =
            nextResetAtUnix === null
              ? accountResetAtUnix
              : Math.min(nextResetAtUnix, accountResetAtUnix);
        }
      } else if (account.modelRoutability?.[model] === true) {
        available += 1;
      } else {
        unmeasured += 1;
      }
    }

    return {
      model,
      total: clineAccounts.length,
      available,
      unmeasured,
      exhausted,
      remainingSumPercent,
      nextResetAtUnix,
    };
  });
};

const resetClockLabel = (unixSecs: number): string =>
  new Date(unixSecs * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Opt-in credit-spend policy state owned by App.tsx. `credits` stays optional
 * so surfaces render unchanged when the gateway does not expose the policy;
 * absent flags read as off (the default).
 */
export interface CreditSpendProps {
  readonly flags: Readonly<Record<string, boolean | undefined>>;
  /** Active mutation key: `credits:<accountId>` while one card's write is in flight. */
  readonly pending: string;
  readonly onToggleAccount: (account: NormalizedAccount, enabled: boolean) => void | Promise<void>;
}

export const accountMenuItems = (account: NormalizedAccount): ContextMenuItem[] => {
  const identifier = account.runtimeId ?? account.credentialName;
  const items: ContextMenuItem[] = [
    { label: "Copy account name", run: () => navigator.clipboard.writeText(account.label) },
  ];
  if (identifier) {
    items.push({ label: "Copy account ID", run: () => navigator.clipboard.writeText(identifier) });
  }
  return items;
};

export interface AccountsSurfaceProps {
  readonly credits?: CreditSpendProps | undefined;
  readonly warmup?: WarmupControlsState | undefined;
  readonly accounts: readonly NormalizedAccount[];
  readonly providers: readonly string[];
  readonly selectedProvider?: string | undefined;
  readonly visibleAccounts: readonly NormalizedAccount[];
  readonly pending: string;
  readonly showRemaining?: boolean;
  /** Bare slugs of Cline models whose daily bucket renders (Settings). */
  readonly clineQuotaDisplay?: readonly string[] | undefined;
  readonly credentialsError?: string | undefined;
  readonly dragging?: string | undefined;
  readonly confirmRemove?: string | undefined;
  readonly gatewayModels?: readonly GatewayModelEntry[] | undefined;
  readonly modelRegistryStatus?: ModelRegistryStatus | null | undefined;
  readonly devinStatusBySlug?: Readonly<Record<string, DevinAccountStatus>> | undefined;
  readonly onSelectProvider: (provider: string) => void;
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
  readonly onProviderContextMenu?: (event: MouseEvent, provider: string) => void;
}

export const AccountsSurface = ({
  credits,
  warmup,
  accounts,
  providers,
  selectedProvider,
  visibleAccounts,
  pending,
  showRemaining = true,
  clineQuotaDisplay = CLINE_QUOTA_DISPLAY_DEFAULT,
  credentialsError,
  dragging,
  confirmRemove,
  devinStatusBySlug,
  onSelectProvider,
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
  onProviderContextMenu,
}: AccountsSurfaceProps) => {
  const popupAccount =
    warmup?.selection?.type === "account"
      ? accounts.find((account) => account.id === warmup.selection?.id)
      : undefined;
  const popupProvider = warmup?.selection?.type === "provider" ? warmup.selection.id : undefined;
  const poolSummary = clinePoolQuotaSummary(accounts, Date.now(), clineQuotaDisplay);
  // One pass over the inventory feeds every tab's count, health dot, and
  // accessible name; re-filtering per attribute scanned the whole list three
  // times per tab on every render.
  const providerTabStats = new Map<string, { total: number; healthy: number }>();
  for (const account of accounts) {
    const stats = providerTabStats.get(account.provider) ?? { total: 0, healthy: 0 };
    stats.total += 1;
    if (account.health === "healthy") stats.healthy += 1;
    providerTabStats.set(account.provider, stats);
  }
  return (
    <Stack className="content accounts">
      <div className="provider-tabs" aria-label="Providers">
        {providers.map((item) => {
          const stats = providerTabStats.get(item) ?? { total: 0, healthy: 0 };
          return (
            <label
              className="provider-tab"
              key={item}
              onContextMenu={(event) => onProviderContextMenu?.(event, item)}
            >
              <input
                type="radio"
                name="provider"
                value={item}
                aria-label={`${item} ${stats.total} account${stats.total === 1 ? "" : "s"}`}
                checked={selectedProvider === item}
                onChange={(event) => onSelectProvider(event.currentTarget.value)}
              />
              <span className="provider-tab-content">
                <span className="provider-tab-icon">
                  <ProviderGlyph provider={item} />
                </span>
                <strong>{providerLabel(item)}</strong>
                <span className="provider-count">{stats.total}</span>
                <i className={stats.healthy > 0 ? "healthy" : ""} />
              </span>
            </label>
          );
        })}
      </div>
      {credentialsError ? (
        <div className="state-panel warning">
          <AlertTriangle /> Credential inventory unavailable, so adding, removing, and
          re-authenticating are disabled: {credentialsError}
        </div>
      ) : null}
      {warmup ? (
        <>
          {selectedProvider ? (
            <Button
              size="sm"
              aria-label={`Warm settings for provider ${selectedProvider}`}
              onClick={() => warmup.onOpen("provider", selectedProvider)}
            >
              Warm settings · {providerLabel(selectedProvider)}
            </Button>
          ) : null}
          {popupProvider || popupAccount ? (
            <WarmupDialog
              title={`Warm settings for ${popupProvider ? `provider ${providerLabel(popupProvider)}` : popupAccount?.label}`}
              onClose={warmup.onClose}
              returnFocus={warmup.returnFocus}
              footer={
                popupProvider ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={warmup.onClose}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={warmup.pending}
                      onClick={() => warmup.onSaveProvider(popupProvider)}
                    >
                      Save
                    </Button>
                  </>
                ) : popupAccount ? (
                  <>
                    <Button
                      size="sm"
                      disabled={
                        !popupAccount.runtimeId ||
                        blocks(pending, "account", popupAccount.id) ||
                        popupAccount.health !== "healthy" ||
                        warmup.status?.accounts[popupAccount.runtimeId]?.capability !== "supported"
                      }
                      title={
                        popupAccount.health !== "healthy"
                          ? `Cannot warm up account in ${popupAccount.health} status. It will warm up automatically when healthy.`
                          : undefined
                      }
                      onClick={() => void onRunAccountAction("warm", popupAccount)}
                    >
                      Run warmup now
                    </Button>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <Button size="sm" variant="ghost" onClick={warmup.onClose}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={!popupAccount.runtimeId || warmup.pending}
                        onClick={() =>
                          popupAccount.runtimeId && warmup.onSaveAccount(popupAccount.runtimeId)
                        }
                      >
                        Save
                      </Button>
                    </div>
                  </>
                ) : null
              }
            >
              <div className="warmup-dialog-body-inner">
                {warmup.error ? (
                  <div className="state-panel warning" role="alert">
                    Warmup unavailable: {warmup.error}
                  </div>
                ) : null}
                {popupProvider ? (
                  <ProviderWarmupControls
                    provider={popupProvider}
                    warmup={warmup}
                    models={[
                      ...new Set(
                        accounts
                          .filter((account) => account.provider === popupProvider)
                          .flatMap((account) =>
                            account.runtimeId
                              ? (warmup.status?.accounts[account.runtimeId]?.available_models ?? [])
                              : [],
                          ),
                      ),
                    ]}
                  />
                ) : null}
                {popupAccount ? (
                  <AccountWarmupControls
                    id={popupAccount.runtimeId}
                    label={popupAccount.label}
                    provider={popupAccount.provider}
                    warmup={warmup}
                  />
                ) : null}
              </div>
            </WarmupDialog>
          ) : null}
        </>
      ) : null}

      {selectedProvider === "cline" && poolSummary.length > 0 && (
        <div
          className="state-panel pool-quota"
          data-testid="cline-pool-quota-summary"
          aria-label="Cline pool quota summary"
        >
          <div>Cline pool · all {poolSummary[0]?.total ?? 0} accounts · quota estimated</div>
          {poolSummary.map((summary) => {
            const total = Math.max(1, summary.total);
            const segment = (count: number) => `${(count / total) * 100}%`;
            return (
              <div
                key={summary.model}
                className="quota-row pool-quota-row"
                title={`measured sum ${formatQuotaPercent(summary.remainingSumPercent)}%`}
              >
                <span className="quota-name">{summary.model}</span>
                <span className="quota-track pool-quota-track" aria-hidden="true">
                  <i data-tone="ok" style={{ width: segment(summary.available) }} />
                  <i data-tone="idle" style={{ width: segment(summary.unmeasured) }} />
                  <i data-tone="bad" style={{ width: segment(summary.exhausted) }} />
                </span>
                <span className="quota-meta">
                  <strong>{summary.available} available</strong>
                  <small>
                    {summary.unmeasured} unknown · {summary.exhausted} unavailable
                  </small>
                  {summary.nextResetAtUnix !== null ? (
                    <small>resets {resetClockLabel(summary.nextResetAtUnix)}</small>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="account-list">
        {visibleAccounts.map((account) => {
          const isDevin = account.provider === "devin";
          const devinSlug = isDevin ? account.identitySlug || extractDevinSlug(account) : "";
          const statusEntry =
            isDevin && devinStatusBySlug ? devinStatusBySlug[devinSlug] : undefined;
          const hasDiscoveryError = Boolean(
            statusEntry?.error ||
              (account.lastError && /model|discover/i.test(account.lastError.message)),
          );
          const devinModels = isDevin ? (statusEntry?.models ?? account.models) : undefined;
          const discoveryState = isDevin
            ? hasDiscoveryError
              ? ("error" as const)
              : statusEntry?.status === "stale" || statusEntry?.stale
                ? ("stale" as const)
                : statusEntry?.status === "uninitialized"
                  ? ("never_loaded" as const)
                  : devinModels === undefined
                    ? ("unknown" as const)
                    : devinModels.length === 0
                      ? ("empty" as const)
                      : ("available" as const)
            : undefined;

          return (
            <AccountCard
              key={account.id}
              account={account}
              clineQuotaDisplay={clineQuotaDisplay}
              credits={
                credits && account.provider === "codex"
                  ? {
                      enabled: credits.flags[account.id] === true,
                      pending: credits.pending === `credits:${account.id}`,
                      onToggle: (enabled) => credits.onToggleAccount(account, enabled),
                    }
                  : undefined
              }
              warmup={warmup}
              pending={pending}
              showRemaining={showRemaining}
              dragging={dragging}
              confirmRemove={confirmRemove}
              devinModels={devinModels}
              discoveryState={discoveryState}
              onRunAccountAction={onRunAccountAction}
              onRefresh={onRefresh}
              onSetCredentialDisabled={onSetCredentialDisabled}
              onReauthenticate={onReauthenticate}
              onReimportCredential={onReimportCredential}
              onRefreshDiscovery={onRefreshDiscovery}
              onRemoveCredential={onRemoveCredential}
              onSetConfirmRemove={onSetConfirmRemove}
              onMoveCredential={onMoveCredential}
              onDropCredential={onDropCredential}
              onSetDragging={onSetDragging}
              onContextMenu={onContextMenu}
            />
          );
        })}
      </div>
      {!visibleAccounts.length ? (
        <div className="state-panel">
          {accounts.length ? "No accounts match this filter." : "No accounts or credentials found."}
        </div>
      ) : null}
    </Stack>
  );
};

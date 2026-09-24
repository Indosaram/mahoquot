import { AlertTriangle } from "lucide-react";
import type { MouseEvent } from "react";
import type { NormalizedAccount } from "../lib/accounts";
import { extractDevinSlug } from "../lib/accounts";
import type { DevinAccountStatus, GatewayModelEntry, ModelRegistryStatus } from "../lib/schemas";
import { AccountCard, HealthBadge } from "./AccountCard";
import type { ContextMenuItem } from "./ContextMenu";
import { ProviderGlyph, providerLabel } from "./ProviderGlyph";
import { Stack } from "./layout";
import { ProviderWarmupControls, AccountWarmupControls, WarmupDialog, type WarmupControlsState } from "./WarmupControls";
import { Button } from "./ui";
import { blocks } from "../lib/pending";

export { HealthBadge, ProviderGlyph, providerLabel };

export type QuotaRow = {
  readonly name: string;
  readonly group: string | null;
  readonly usedPercent: number;
  readonly resetSeconds: number | null;
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

export const quotaRows = (account: NormalizedAccount): readonly QuotaRow[] => {
  const usage = account.usage;
  if (!usage) return [];
  const grouped =
    usage.groups?.flatMap((group) =>
      group.buckets.flatMap((bucket, index) => {
        if (typeof bucket.used_percent !== "number") return [];
        if (
          isClineInferredQuotaExpired(
            account,
            group.display_name,
            bucket.reset_at_unix,
            bucket.reset_after_seconds,
          )
        ) {
          return [];
        }
        return [
          {
            name: windowLabel(
              bucket.display_name ||
                bucket.bucket_id ||
                group.display_name ||
                group.models ||
                `Quota ${index + 1}`,
            ),
            group: group.display_name || group.models || null,
            usedPercent: bucket.used_percent,
            resetSeconds: resetSeconds(bucket.reset_at_unix, bucket.reset_after_seconds),
          },
        ];
      }),
    ) ?? [];
  if (grouped.length) return grouped;
  const flat: readonly (QuotaRow | null)[] = [
    usage.primary && typeof usage.primary.used_percent === "number"
      ? {
          name: usage.primary.limit_name || "Primary window",
          group: null,
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
          group: null,
          usedPercent: usage.secondary.used_percent,
          resetSeconds: resetSeconds(
            usage.secondary.reset_at_unix,
            usage.secondary.reset_after_seconds,
          ),
        }
      : null,
  ];
  return flat.filter((row): row is QuotaRow => row !== null);
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

// The pooled Cline free models summarized across every account. Buckets match
// on the bare model name so both vendor-prefixed labels ("deepseek/..." from
// upstream cap errors and "cline-free/..." from live requests) fold into one
// figure. Accounts with no live bucket in the window are reported as
// unmeasured instead of being padded into the sum.
const POOL_QUOTA_MODELS: readonly { model: string; pattern: RegExp }[] = [
  { model: "z-ai/glm-5.3-flash", pattern: /glm-5\.3-flash/i },
  { model: "cline-free/deepseek-v4.1-flash", pattern: /deepseek-v4\.1-flash/i },
];

export const clinePoolQuotaSummary = (
  accounts: readonly NormalizedAccount[],
  nowMs = Date.now(),
): readonly ClinePoolModelSummary[] => {
  const clineAccounts = accounts.filter((account) => account.provider === "cline");
  if (clineAccounts.length === 0) return [];
  const nowSecs = Math.floor(nowMs / 1000);

  return POOL_QUOTA_MODELS.map(({ model, pattern }) => {
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

      if (!measured) {
        unmeasured += 1;
        continue;
      }
      const remaining = accountRemaining ?? 100;
      remainingSumPercent += remaining;
      if (remaining <= 0) {
        exhausted += 1;
        if (accountResetAtUnix !== null) {
          nextResetAtUnix =
            nextResetAtUnix === null
              ? accountResetAtUnix
              : Math.min(nextResetAtUnix, accountResetAtUnix);
        }
      } else {
        available += 1;
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
  readonly warmup?: WarmupControlsState | undefined;
  readonly accounts: readonly NormalizedAccount[];
  readonly providers: readonly string[];
  readonly selectedProvider?: string | undefined;
  readonly visibleAccounts: readonly NormalizedAccount[];
  readonly pending: string;
  readonly showRemaining?: boolean;
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
}

export const AccountsSurface = ({
  warmup,
  accounts,
  providers,
  selectedProvider,
  visibleAccounts,
  pending,
  showRemaining = true,
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
}: AccountsSurfaceProps) => {
  const popupAccount = warmup?.selection?.type === "account" ? accounts.find((account) => account.id === warmup.selection?.id) : undefined;
  const popupProvider = warmup?.selection?.type === "provider" ? warmup.selection.id : undefined;
  const poolSummary = clinePoolQuotaSummary(accounts);
  return (
    <Stack className="content accounts">
      <div className="provider-tabs" aria-label="Providers">
        {providers.map((item) => (
          <label className="provider-tab" key={item}>
            <input
              type="radio"
              name="provider"
              value={item}
              aria-label={`${item} ${accounts.filter((account) => account.provider === item).length} account${accounts.filter((account) => account.provider === item).length === 1 ? "" : "s"}`}
              checked={selectedProvider === item}
              onChange={(event) => onSelectProvider(event.currentTarget.value)}
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
      {credentialsError ? (
        <div className="state-panel warning">
          <AlertTriangle /> Credential inventory unavailable, so adding, removing, and
          re-authenticating are disabled: {credentialsError}
        </div>
      ) : null}
      {warmup ? <>
        {selectedProvider ? <Button size="sm" aria-label={`Warm settings for provider ${selectedProvider}`} onClick={() => warmup.onOpen("provider", selectedProvider)}>Warm settings · {providerLabel(selectedProvider)}</Button> : null}
        {popupProvider || popupAccount ? <WarmupDialog
          title={`Warm settings for ${popupProvider ? `provider ${popupProvider}` : popupAccount?.label}`}
          onClose={warmup.onClose}
          returnFocus={warmup.returnFocus}
          footer={
            popupProvider ? (
              <>
                <Button size="sm" variant="ghost" onClick={warmup.onClose}>Cancel</Button>
                <Button size="sm" disabled={warmup.pending} onClick={() => warmup.onSaveProvider(popupProvider)}>Save</Button>
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
                  <Button size="sm" variant="ghost" onClick={warmup.onClose}>Cancel</Button>
                  <Button size="sm" disabled={!popupAccount.runtimeId || warmup.pending} onClick={() => popupAccount.runtimeId && warmup.onSaveAccount(popupAccount.runtimeId)}>Save</Button>
                </div>
              </>
            ) : null
          }
        >
          <div className="warmup-dialog-body-inner">
            {warmup.error ? <div className="state-panel warning" role="alert">Warmup unavailable: {warmup.error}</div> : null}
            {popupProvider ? <ProviderWarmupControls provider={popupProvider} warmup={warmup} models={[...new Set(accounts.filter((account) => account.provider === popupProvider).flatMap((account) => account.runtimeId ? warmup.status?.accounts[account.runtimeId]?.available_models ?? [] : []))]} /> : null}
            {popupAccount ? <AccountWarmupControls id={popupAccount.runtimeId} label={popupAccount.label} provider={popupAccount.provider} warmup={warmup} /> : null}
          </div>
        </WarmupDialog> : null}
      </> : null}

      {selectedProvider === "cline" && poolSummary.length > 0 && (
        <div
          className="state-panel pool-quota"
          data-testid="cline-pool-quota-summary"
          aria-label="Cline pool quota summary"
        >
          <div>Pooled quota · all {poolSummary[0]?.total ?? 0} cline accounts · estimated</div>
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
                    {summary.unmeasured} unmeasured · {summary.exhausted} exhausted
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

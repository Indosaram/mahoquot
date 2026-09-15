import { AlertTriangle } from "lucide-react";
import type { MouseEvent } from "react";
import type { NormalizedAccount } from "../lib/accounts";
import { extractDevinSlug } from "../lib/accounts";
import type { DevinAccountStatus, GatewayModelEntry, ModelRegistryStatus } from "../lib/schemas";
import { AccountCard, HealthBadge } from "./AccountCard";
import type { ContextMenuItem } from "./ContextMenu";
import { ProviderGlyph, providerLabel } from "./ProviderGlyph";
import { Stack } from "./layout";

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
              bucket.display_name || group.display_name || group.models || `Quota ${index + 1}`,
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

import { normalizeToQuotioProviderId } from "./provider-catalog";
import {
  type AccountStats,
  type AuthFileItem,
  type LastError,
  type ResetCredit,
  type Usage,
  devinCredentialFileName,
} from "./schemas";

/** One banked reset credit, with the dates the gateway could resolve. */
export interface ResetCreditView {
  readonly grantedAtUnix: number | null;
  readonly expiresAtUnix: number | null;
}

export type AccountHealth =
  | "healthy"
  | "cooldown"
  | "degraded"
  | "error"
  | "auth_required"
  | "not_loaded"
  | "disabled";
export type QuotaCapability = "supported" | "unsupported";

export interface NormalizedAccount {
  readonly id: string; // Unique key for lists
  readonly runtimeId: string | null;
  readonly credentialName: string | null;
  readonly disabled: boolean;
  readonly authIndex: string | null;
  readonly provider: string;
  readonly plan: string | null;
  readonly email: string;
  readonly label: string;
  readonly health: AccountHealth;
  readonly healthRaw: string;
  readonly cooldownUntilUnixMs: number | null;
  readonly cooldownRemainingSecs: number | null;
  readonly ok: number;
  readonly fails: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly failureRate: number;
  readonly p50Ms: number | null;
  readonly lastError: LastError | null;
  readonly usage: Usage | null;
  readonly quotaCapability: QuotaCapability;
  readonly isCredentialOnly: boolean;
  readonly canReset: boolean;
  readonly resetCreditsAvailable: number;
  /**
   * Whether this account's provider reports banked resets at all, which is
   * not the same as having one to spend. Derived from the presence of the
   * count rather than from the provider id, so a provider that gains reset
   * support needs no change here.
   */
  readonly supportsReset: boolean;
  readonly resetCredits: readonly ResetCreditView[];
  readonly identitySlug?: string | null;
  readonly models?: readonly string[] | undefined;
  readonly credentialMeta?:
    | {
        readonly size: number;
        readonly path: string;
        readonly modtime?: number | undefined;
        readonly projectId?: string | undefined;
      }
    | undefined;
}

const KNOWN_PROVIDER_PREFIXES = [
  "generic-cline-oauth-",
  "cline-",
  "antigravity-",
  "claude-",
  "codex-",
  "zcode-",
  "generic-",
];

export const extractEmail = (idOrEmail: string): string => {
  let clean = idOrEmail.trim();
  for (const p of KNOWN_PROVIDER_PREFIXES) {
    if (clean.toLowerCase().startsWith(p)) {
      clean = clean.slice(p.length);
      break;
    }
  }
  let atIndex = clean.lastIndexOf("@");
  if (atIndex < 0) {
    const match = clean.match(/^([a-zA-Z0-9._%+-]+)_([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:-.*)?$/);
    if (match?.[1] && match[2]) {
      clean = `${match[1]}@${match[2]}`;
      atIndex = clean.lastIndexOf("@");
    }
  }
  if (atIndex > 0) {
    let prefix = clean.slice(0, atIndex);
    let domain = clean.slice(atIndex + 1);
    domain = domain
      .replace(/-(?:plus|prolite|pro|team|free|enterprise)(?:\.json)?$/i, "")
      .replace(/\.json$/i, "");
    const hashMatch = prefix.match(/^[a-f0-9]{8,64}-(.+)$/i);
    if (hashMatch) {
      prefix = hashMatch[1];
    }
    return `${prefix}@${domain}`.toLowerCase();
  }
  return clean.toLowerCase();
};

// Providers whose upstream reports a usable quota window on every account.
// The catalog already folds `openai`->`codex` and `anthropic`->`claude`, so
// matching canonical ids exactly beats substring tests that would also fire
// on unrelated names such as an "openai-compatible" generic endpoint.
const ALWAYS_QUOTA_PROVIDERS: ReadonlySet<string> = new Set(["codex", "claude"]);

// Antigravity only reports quota once the gateway has observed its per-model
// buckets; without them the account is unknown, never 0%. ClinePass likewise
// reports its 5-hour / weekly / monthly windows as groups from usage-limits.
const GROUPED_QUOTA_PROVIDERS: ReadonlySet<string> = new Set(["antigravity", "cline-pass"]);

export const getQuotaCapability = (
  provider: string,
  usage: Usage | null | undefined,
): QuotaCapability => {
  const id = providerOf(provider);
  if (ALWAYS_QUOTA_PROVIDERS.has(id)) {
    return "supported";
  }
  if (GROUPED_QUOTA_PROVIDERS.has(id)) {
    return usage && (usage.groups?.length ?? 0) > 0 ? "supported" : "unsupported";
  }
  return "unsupported";
};

export const deriveAccountHealth = (
  healthRaw: unknown,
  resetAtUnixMs: number | null | undefined,
  ok: number,
  fails: number,
): AccountHealth => {
  const statusStr =
    typeof healthRaw === "string"
      ? healthRaw.toLowerCase()
      : healthRaw && typeof healthRaw === "object"
        ? String(
            (healthRaw as Record<string, unknown>).status ??
              Object.values(healthRaw as Record<string, unknown>)[0] ??
              "unknown",
          ).toLowerCase()
        : "unknown";

  const now = Date.now();
  if (statusStr.includes("disabled")) {
    return "disabled";
  }
  if (
    statusStr.includes("auth") ||
    statusStr.includes("unauthenticated") ||
    statusStr.includes("unauth") ||
    statusStr.includes("token_expired") ||
    statusStr.includes("reauth")
  ) {
    return "auth_required";
  }
  if (resetAtUnixMs && resetAtUnixMs > now) {
    return "cooldown";
  }
  if (resetAtUnixMs && statusStr.includes("cooldown")) {
    // The gateway never flips Health::Cooldown back to Available; expiry is
    // evaluated at routing time via Health::is_available. Mirror that here so
    // an expired deadline does not pin the Cooldown badge forever.
    return "healthy";
  }
  if (statusStr.includes("cooldown")) {
    return "cooldown";
  }
  if (statusStr.includes("fail") || statusStr.includes("error") || statusStr.includes("bad")) {
    return "error";
  }
  const total = ok + fails;
  if (total >= 2 && fails / total > 0.5) {
    return "degraded";
  }
  if (statusStr.includes("degraded") || statusStr.includes("warn")) {
    return "degraded";
  }
  if (statusStr.includes("avail") || statusStr.includes("ok") || statusStr.includes("healthy")) {
    return "healthy";
  }
  return "healthy";
};

export const formatResetTime = (sec: number | null | undefined): string => {
  if (sec == null) return "-";
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);

  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
};

/**
 * Order banked reset credits by how soon they lapse.
 *
 * The nearest expiry is what decides whether to spend a credit today, so it
 * leads regardless of the order the gateway sent. A credit with no expiry is
 * unknown rather than urgent, so it sorts last instead of first.
 */
const normalizeResetCredits = (
  raw: readonly ResetCredit[] | undefined,
): readonly ResetCreditView[] =>
  (raw ?? [])
    .map((credit) => ({
      grantedAtUnix: credit.granted_at_unix ?? null,
      expiresAtUnix: credit.expires_at_unix ?? null,
    }))
    .sort(
      (left, right) =>
        (left.expiresAtUnix ?? Number.POSITIVE_INFINITY) -
        (right.expiresAtUnix ?? Number.POSITIVE_INFINITY),
    );

const providerOf = (value: string | undefined): string => normalizeToQuotioProviderId(value || "");

const credentialProvider = (credential: AuthFileItem): string =>
  providerOf(
    credential.type === "generic" && credential.provider
      ? credential.provider
      : credential.type || credential.provider,
  );

// Both sides are already canonical Quotio ids, so equality is the whole test.
// Substring matching here used to pair a "claude" runtime account with a
// "claude-code" credential (and vice versa) purely because one id is a prefix
// of the other.
const sharesProvider = (accountProvider: string, credential: AuthFileItem): boolean => {
  const credProvider = credentialProvider(credential);
  if (!credProvider || !accountProvider) return true;
  return credProvider === accountProvider;
};

const matchesCredentialName = (credName: string, accountId: string): boolean => {
  if (credName === accountId) return true;
  const stem = credName.replace(/\.json$/i, "");
  if (stem === accountId) return true;
  const withoutPlan = stem.replace(/-(?:plus|prolite|pro|team|free|enterprise)$/i, "");
  if (withoutPlan === accountId) return true;
  const withoutPrefix = withoutPlan.replace(/^[a-zA-Z0-9]+-/, "");
  if (withoutPrefix === accountId) return true;
  return false;
};

/**
 * Bind each runtime pool member to the credential file it was loaded from.
 *
 * Most providers expose the account email as the runtime id, so identity matching
 * covers them. Subscription imports such as Claude Code report an opaque runtime id
 * (`claude-code`) that shares neither email nor filename with its credential file,
 * which used to split one account into an unmanageable runtime card plus a phantom
 * "not loaded" credential card. When a provider has exactly one unbound account and
 * one unbound credential left, that pairing is unambiguous, so bind it.
 */
const pairAccountsWithCredentials = (
  runtimeAccounts: readonly AccountStats[],
  credentialFiles: readonly AuthFileItem[],
  matched: Set<string>,
): Map<string, AuthFileItem> => {
  const pairing = new Map<string, AuthFileItem>();

  for (const account of runtimeAccounts) {
    const accountEmail = extractEmail(account.id);
    const accountProvider = providerOf(account.provider || "unknown");
    const isDevin = accountProvider === "devin";
    const credential = credentialFiles.find((c) => {
      if (matched.has(c.name)) return false;
      if (!sharesProvider(accountProvider, c)) return false;
      if (isDevin) {
        const credSlug =
          c.identity_slug || ((c as Record<string, unknown>).identity as string | undefined);
        if (credSlug) {
          return credSlug === account.id;
        }
        if (c.name === devinCredentialFileName(account.id)) {
          return true;
        }
        return matchesCredentialName(c.name, account.id);
      }
      const credEmail = extractEmail(c.email || c.account || c.name);
      return credEmail === accountEmail || matchesCredentialName(c.name, account.id);
    });
    if (credential) {
      matched.add(credential.name);
      pairing.set(account.id, credential);
    }
  }

  const unpaired = runtimeAccounts.filter((account) => !pairing.has(account.id));
  for (const account of unpaired) {
    const accountProvider = providerOf(account.provider || "unknown");
    const rivals = unpaired.filter(
      (other) => providerOf(other.provider || "unknown") === accountProvider,
    );
    const candidates = credentialFiles.filter(
      (c) => !matched.has(c.name) && credentialProvider(c) === accountProvider,
    );
    const credential = candidates[0];
    if (rivals.length === 1 && candidates.length === 1 && credential) {
      matched.add(credential.name);
      pairing.set(account.id, credential);
    }
  }

  return pairing;
};

// Gateway runtime caches live beside credentials in the auth dir; they are
// state the app regenerates, never loadable accounts.
const RUNTIME_CACHE_CREDENTIAL_FILES: ReadonlySet<string> = new Set([
  "telemetry.json",
  "usage-samples.json",
]);

function cleanAccountLabel(raw: string, provider: string): string {
  let label = raw;
  if (provider === "devin") {
    let clean = label;
    if (clean.endsWith(".json")) {
      clean = clean.slice(0, -5);
    }
    return clean || label;
  }
  if (provider === "antigravity" && label.startsWith("antigravity-")) {
    label = label.slice("antigravity-".length);
  }
  if (provider === "cline") {
    if (label.startsWith("cline-")) {
      return label.slice("cline-".length);
    }
    if (label.startsWith("generic-cline-oauth-")) {
      const email = extractEmail(label);
      if (email && email.includes("@")) return email;
      return label;
    }
  }
  if (
    provider === "codex" ||
    provider === "openai" ||
    provider === "claude" ||
    provider === "anthropic"
  ) {
    const isClaude = provider === "claude" || provider === "anthropic";
    const prefix = isClaude ? "claude-" : "codex-";
    if (label.toLowerCase().startsWith(prefix)) {
      label = label.slice(prefix.length);
    }
    let at = label.lastIndexOf("@");
    if (at < 0) {
      const match = label.match(/^([a-zA-Z0-9._%+-]+)_([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:-.*)?$/);
      if (match?.[1] && match[2]) {
        label = `${match[1]}@${match[2]}`;
        at = label.lastIndexOf("@");
      }
    }
    if (at > 0) {
      let prefixPart = label.slice(0, at);
      const suffix = label
        .slice(at + 1)
        .replace(/-(?:plus|prolite|pro|team|free|enterprise)(?:\.json)?$/i, "");
      const hashMatch = prefixPart.match(/^[a-f0-9]{8,64}-(.+)$/i);
      if (hashMatch) {
        prefixPart = hashMatch[1];
      } else {
        const hyphenIdx = prefixPart.indexOf("-");
        if (hyphenIdx > 0 && hyphenIdx < prefixPart.length - 1) {
          prefixPart = prefixPart.slice(hyphenIdx + 1);
        }
      }
      label = `${prefixPart}@${suffix}`;
    } else if (isClaude) {
      label = raw;
    }
  }
  return label;
}

export const mergeAccountsAndCredentials = (
  runtimeAccounts: readonly AccountStats[],
  credentialFiles: readonly AuthFileItem[],
): NormalizedAccount[] => {
  const result: NormalizedAccount[] = [];
  const matchedCreds = new Set<string>();
  const nowMs = Date.now();
  const pairing = pairAccountsWithCredentials(runtimeAccounts, credentialFiles, matchedCreds);

  for (const r of runtimeAccounts) {
    const isDevin = providerOf(r.provider || "unknown") === "devin";
    const rEmail = isDevin ? "" : extractEmail(r.id);
    const cred = pairing.get(r.id);
    const devinIdentity = isDevin
      ? (cred?.identity_slug as string | undefined) ||
        ((cred as Record<string, unknown> | undefined)?.identity as string | undefined) ||
        r.id
      : null;

    const isAccountDisabled =
      (cred?.disabled ?? false) ||
      (typeof r.health === "object" && (r.health as { status?: string }).status === "disabled") ||
      r.health === "disabled";
    const hasAuthError =
      r.last_error?.status === 401 ||
      (r.last_error?.message &&
        /unauthenticated|auth.*required|invalid.*token|re-?auth/i.test(r.last_error.message));
    const health = isAccountDisabled
      ? "disabled"
      : hasAuthError
        ? "auth_required"
        : deriveAccountHealth(r.health, r.reset_at_unix_ms, r.ok, r.fails);
    const cooldownRemaining = r.reset_at_unix_ms
      ? Math.max(0, Math.floor((r.reset_at_unix_ms - nowMs) / 1000))
      : null;

    const total = r.ok + r.fails;
    const failureRate = total > 0 ? r.fails / total : 0;
    const p50 =
      typeof r.ttft === "number"
        ? r.ttft
        : r.ttft?.p50_ms && r.ttft.p50_ms > 0
          ? r.ttft.p50_ms
          : null;

    const quotaCap = getQuotaCapability(r.provider, r.usage);
    const resetCredits = r.usage?.reset_credits_available ?? 0;

    const credLabel =
      cred?.label && !cred.label.startsWith("generic-cline-oauth-") ? cred.label : null;
    const rawLabel = credLabel || r.id;

    result.push({
      id: r.id,
      runtimeId: r.id,
      credentialName: cred ? cred.name : null,
      disabled: isAccountDisabled,
      authIndex: cred ? cred.auth_index : null,
      provider: providerOf(r.provider || "unknown"),
      plan: r.plan ?? null,
      email: rEmail,
      label: cleanAccountLabel(rawLabel, providerOf(r.provider || "unknown")),
      health,
      healthRaw: typeof r.health === "string" ? r.health : JSON.stringify(r.health),
      cooldownUntilUnixMs: r.reset_at_unix_ms ?? null,
      cooldownRemainingSecs: cooldownRemaining,
      ok: r.ok,
      fails: r.fails,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      totalTokens: r.total_tokens ?? 0,
      failureRate,
      p50Ms: p50,
      lastError: r.last_error ?? null,
      usage: r.usage ?? null,
      quotaCapability: quotaCap,
      isCredentialOnly: false,
      identitySlug: devinIdentity,
      models: Array.isArray(r.models) ? r.models : undefined,
      canReset: resetCredits > 0,
      resetCreditsAvailable: resetCredits,
      supportsReset: r.usage?.reset_credits_available != null,
      resetCredits: normalizeResetCredits(r.usage?.reset_credits),
      credentialMeta: cred
        ? {
            size: cred.size,
            path: cred.path,
            modtime: cred.modtime,
            projectId: cred.project_id,
          }
        : undefined,
    });
  }

  // Unmatched credential files (failed to load into runtime pool)
  for (const c of credentialFiles) {
    if (matchedCreds.has(c.name)) continue;
    if (RUNTIME_CACHE_CREDENTIAL_FILES.has(c.name)) continue;

    const isDevin = providerOf(c.type || c.provider || "unknown") === "devin";
    const cEmail = isDevin ? "" : extractEmail(c.email || c.account || c.name);
    const devinIdentity = isDevin
      ? (c.identity_slug as string | undefined) ||
        ((c as Record<string, unknown>).identity as string | undefined) ||
        (c.name.endsWith(".json") ? c.name.slice(0, -5) : c.name)
      : null;
    result.push({
      id: `cred-${c.name}`,
      runtimeId: null,
      credentialName: c.name,
      disabled: c.disabled,
      authIndex: c.auth_index,
      provider: providerOf(c.type || c.provider || "unknown"),
      plan: null,
      email: cEmail,
      label: cleanAccountLabel(c.label || c.name, providerOf(c.type || c.provider || "unknown")),
      health: c.disabled ? "disabled" : "not_loaded",
      healthRaw: c.disabled ? "Disabled" : "Not loaded into pool",
      cooldownUntilUnixMs: null,
      cooldownRemainingSecs: null,
      ok: 0,
      fails: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      failureRate: 0,
      p50Ms: null,
      lastError: null,
      usage: null,
      quotaCapability: "unsupported",
      isCredentialOnly: true,
      identitySlug: devinIdentity,
      models: undefined,
      canReset: false,
      resetCreditsAvailable: 0,
      supportsReset: false,
      resetCredits: [],
      credentialMeta: {
        size: c.size,
        path: c.path,
        modtime: c.modtime,
        projectId: c.project_id,
      },
    });
  }

  // Display order follows the credential inventory, which the console reorders
  // on its own. The runtime pool sorts itself, so this never moves routing.
  const rank = new Map(credentialFiles.map((c, index) => [c.name, index]));
  const rankOf = (account: NormalizedAccount): number =>
    (account.credentialName ? rank.get(account.credentialName) : undefined) ??
    Number.MAX_SAFE_INTEGER;
  result.sort((a, b) => rankOf(a) - rankOf(b));

  return result;
};

export const extractDevinSlug = (account: NormalizedAccount): string => {
  if (account.identitySlug) {
    return account.identitySlug;
  }
  if (account.runtimeId) {
    return account.runtimeId;
  }
  if (account.credentialName) {
    return account.credentialName.replace(/\.json$/i, "");
  }
  return account.id.replace(/^cred-/, "").replace(/\.json$/i, "");
};

import type { AccountStats, AuthFileItem, LastError, Usage } from "./schemas";

export type AccountHealth = "healthy" | "cooldown" | "degraded" | "error" | "not_loaded";
export type QuotaCapability = "supported" | "unsupported";

export interface NormalizedAccount {
  readonly id: string; // Unique key for lists
  readonly runtimeId: string | null;
  readonly credentialName: string | null;
  readonly authIndex: string | null;
  readonly provider: string;
  readonly email: string;
  readonly label: string;
  readonly health: AccountHealth;
  readonly healthRaw: string;
  readonly cooldownUntilUnixMs: number | null;
  readonly cooldownRemainingSecs: number | null;
  readonly ok: number;
  readonly fails: number;
  readonly failureRate: number;
  readonly p50Ms: number | null;
  readonly lastError: LastError | null;
  readonly usage: Usage | null;
  readonly quotaCapability: QuotaCapability;
  readonly isCredentialOnly: boolean;
  readonly canReset: boolean;
  readonly resetCreditsAvailable: number;
  readonly credentialMeta?:
    | {
        readonly size: number;
        readonly path: string;
        readonly modtime?: number | undefined;
        readonly projectId?: string | undefined;
      }
    | undefined;
}

export const extractEmail = (idOrEmail: string): string => {
  const clean = idOrEmail.trim();
  // e.g. "565c2911-account-f@example.com" -> extract the email part
  const atIndex = clean.lastIndexOf("@");
  if (atIndex > 0) {
    const prefix = clean.slice(0, atIndex);
    const domain = clean.slice(atIndex + 1);
    const hyphenIdx = prefix.indexOf("-");
    if (hyphenIdx > 0 && hyphenIdx < prefix.length - 1) {
      // Return the email without the runtime prefix if present
      const user = prefix.slice(hyphenIdx + 1);
      return `${user}@${domain}`.toLowerCase();
    }
    return clean.toLowerCase();
  }
  return clean.toLowerCase();
};

export const getQuotaCapability = (
  provider: string,
  usage: Usage | null | undefined,
): QuotaCapability => {
  const p = (provider || "").toLowerCase();
  if (p.includes("codex") || p.includes("openai")) {
    return "supported";
  }
  if (p.includes("antigravity")) {
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
  if (resetAtUnixMs && resetAtUnixMs > now) {
    return "cooldown";
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

export const mergeAccountsAndCredentials = (
  runtimeAccounts: readonly AccountStats[],
  credentialFiles: readonly AuthFileItem[],
): NormalizedAccount[] => {
  const result: NormalizedAccount[] = [];
  const matchedCreds = new Set<string>();
  const nowMs = Date.now();

  for (const r of runtimeAccounts) {
    const rEmail = extractEmail(r.id);
    const rProv = (r.provider || "unknown").toLowerCase();

    // Match by provider and email or direct name
    const cred = credentialFiles.find((c) => {
      const cEmail = extractEmail(c.email || c.account || c.name);
      const cProv = (c.type || c.provider || "").toLowerCase();
      const provMatch = !cProv || !rProv || cProv === rProv || rProv.includes(cProv);
      return provMatch && (cEmail === rEmail || c.name === r.id);
    });

    if (cred) {
      matchedCreds.add(cred.name);
    }

    const health = deriveAccountHealth(r.health, r.reset_at_unix_ms, r.ok, r.fails);
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

    result.push({
      id: r.id,
      runtimeId: r.id,
      credentialName: cred ? cred.name : null,
      authIndex: cred ? cred.auth_index : null,
      provider: r.provider || "unknown",
      email: rEmail,
      label: cred?.label || rEmail || r.id,
      health,
      healthRaw: typeof r.health === "string" ? r.health : JSON.stringify(r.health),
      cooldownUntilUnixMs: r.reset_at_unix_ms ?? null,
      cooldownRemainingSecs: cooldownRemaining,
      ok: r.ok,
      fails: r.fails,
      failureRate,
      p50Ms: p50,
      lastError: r.last_error ?? null,
      usage: r.usage ?? null,
      quotaCapability: quotaCap,
      isCredentialOnly: false,
      canReset: resetCredits > 0,
      resetCreditsAvailable: resetCredits,
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

    const cEmail = extractEmail(c.email || c.account || c.name);
    result.push({
      id: `cred-${c.name}`,
      runtimeId: null,
      credentialName: c.name,
      authIndex: c.auth_index,
      provider: c.type || c.provider || "unknown",
      email: cEmail,
      label: c.label || c.name,
      health: "not_loaded",
      healthRaw: "Not loaded into pool",
      cooldownUntilUnixMs: null,
      cooldownRemainingSecs: null,
      ok: 0,
      fails: 0,
      failureRate: 0,
      p50Ms: null,
      lastError: null,
      usage: null,
      quotaCapability: "unsupported",
      isCredentialOnly: true,
      canReset: false,
      resetCreditsAvailable: 0,
      credentialMeta: {
        size: c.size,
        path: c.path,
        modtime: c.modtime,
        projectId: c.project_id,
      },
    });
  }

  return result;
};

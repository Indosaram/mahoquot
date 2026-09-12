import type { NormalizedAccount } from "./accounts";
import { normalizeToQuotioProviderId } from "./provider-catalog";

export interface ResolvedIdentity {
  readonly label: string;
  readonly provider: string;
  readonly isUnlinked: boolean;
}

export const truncateOpaqueIdentifier = (identifier: string): string => {
  return identifier.replace(/[0-9a-fA-F]{32,}/g, (run) => `${run.slice(0, 8)}…`);
};

export const resolveAccountIdentity = (
  identifier: string,
  accounts: readonly NormalizedAccount[],
): ResolvedIdentity => {
  // 1. exact id
  let matched = accounts.find((a) => a.id === identifier);

  // 2. exact email
  if (!matched) {
    matched = accounts.find((a) => a.email === identifier);
  }

  // 3. lowercase compare after replacing the LAST "_" with "@"
  if (!matched) {
    const lastUnderscore = identifier.lastIndexOf("_");
    if (lastUnderscore >= 0) {
      const candidate =
        `${identifier.slice(0, lastUnderscore)}@${identifier.slice(lastUnderscore + 1)}`.toLowerCase();
      matched = accounts.find(
        (a) => a.email.toLowerCase() === candidate || a.id.toLowerCase() === candidate,
      );
    }
  }

  // 4. compare after stripping a leading "<word>-" prefix
  if (!matched) {
    const prefixMatch = identifier.match(/^[a-zA-Z0-9]+-(.+)$/);
    if (prefixMatch) {
      const stripped = prefixMatch[1].toLowerCase();
      matched = accounts.find(
        (a) =>
          a.id.toLowerCase() === stripped ||
          a.email.toLowerCase() === stripped ||
          a.id.toLowerCase().replace(/^[a-zA-Z0-9]+-/, "") === stripped ||
          a.email.toLowerCase().replace(/^[a-zA-Z0-9]+-/, "") === stripped,
      );
    }
  }

  // 5. finally compare against credentialName
  if (!matched) {
    const idLower = identifier.toLowerCase();
    const idWithoutPrefix = idLower.replace(/^[a-zA-Z0-9]+-/, "");
    matched = accounts.find((a) => {
      if (!a.credentialName) return false;
      const credLower = a.credentialName.toLowerCase();
      const credWithoutJson = credLower.replace(/\.json$/, "");
      return (
        credLower === idLower || credWithoutJson === idLower || credWithoutJson === idWithoutPrefix
      );
    });
  }

  if (matched) {
    return {
      label: matched.label || matched.email || identifier,
      provider: matched.provider,
      isUnlinked: false,
    };
  }

  return {
    label: truncateOpaqueIdentifier(identifier),
    provider: "unknown",
    isUnlinked: true,
  };
};

export const resolveProviderIdentity = (
  historyProvider: string,
  account?: ResolvedIdentity,
): string => {
  const normalized = normalizeToQuotioProviderId(historyProvider);
  if ((normalized === "generic" || normalized === "unknown") && account && !account.isUnlinked) {
    return account.provider;
  }
  return normalized;
};

import { normalizeToQuotioProviderId } from "./provider-catalog";

export interface LocalPoint {
  readonly x: number;
  readonly y: number;
}

export interface HoverTarget {
  readonly provider: string;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

export const providerAtPoint = (
  point: LocalPoint | null | undefined,
  targets: readonly HoverTarget[],
): string | null => {
  if (!point) return null;
  const hit = targets.find(
    ({ rect }) =>
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom,
  );
  return hit?.provider ?? null;
};

export interface NotchQuotaRow {
  readonly name: string;
  readonly usedPercent: number;
  readonly resetSeconds: number | null;
}

export interface NotchProviderEntry {
  readonly provider: string;
  readonly label?: string;
  readonly rows: readonly NotchQuotaRow[];
}

export interface NotchAccountEntry {
  readonly label: string;
  readonly rows: readonly NotchQuotaRow[];
}

export interface NotchProviderGroup {
  readonly provider: string;
  readonly accountCount: number;
  readonly accounts: readonly NotchAccountEntry[];
  readonly rows: readonly NotchQuotaRow[];
}

interface RowAccumulator {
  name: string;
  worst: number;
  samples: number;
  resetSeconds: number | null;
}

/// The pooled icon must advertise the worst-off account: an average would
/// hide that half a pool running at 88% is about to lose capacity. The reset
/// time likewise follows the worst account, not the soonest arbitrary one.
const worstAccount = (
  currentWorst: number,
  currentReset: number | null,
  accountWorst: number,
  accountReset: number | null,
): { worst: number; resetSeconds: number | null } => {
  if (accountWorst > currentWorst && typeof accountReset === "number") {
    return { worst: accountWorst, resetSeconds: accountReset };
  }
  return { worst: Math.max(currentWorst, accountWorst), resetSeconds: currentReset };
};

export const groupNotchProviders = (
  entries: readonly NotchProviderEntry[],
): readonly NotchProviderGroup[] => {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const rowsByProvider = new Map<string, Map<string, RowAccumulator>>();
  const accountsByProvider = new Map<string, NotchAccountEntry[]>();

  for (const entry of entries) {
    const provider = normalizeToQuotioProviderId(entry.provider);
    if (!counts.has(provider)) {
      order.push(provider);
      rowsByProvider.set(provider, new Map());
      accountsByProvider.set(provider, []);
    }
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
    accountsByProvider.get(provider)?.push({
      label: entry.label ?? provider,
      rows: entry.rows,
    });

    const accumulators = rowsByProvider.get(provider) as Map<string, RowAccumulator>;
    for (const row of entry.rows) {
      const existing = accumulators.get(row.name);
      if (existing) {
        const winner = worstAccount(
          existing.worst,
          existing.resetSeconds,
          row.usedPercent,
          row.resetSeconds,
        );
        existing.worst = winner.worst;
        existing.resetSeconds = winner.resetSeconds;
        existing.samples += 1;
      } else {
        accumulators.set(row.name, {
          name: row.name,
          worst: row.usedPercent,
          samples: 1,
          resetSeconds: row.resetSeconds,
        });
      }
    }
  }

  return order.map((provider) => ({
    provider,
    accountCount: counts.get(provider) ?? 0,
    accounts: accountsByProvider.get(provider) ?? [],
    rows: [...(rowsByProvider.get(provider)?.values() ?? [])].map((accumulator) => ({
      name: accumulator.name,
      usedPercent: accumulator.worst,
      resetSeconds: accumulator.resetSeconds,
    })),
  }));
};

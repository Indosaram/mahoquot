import type { AdminStats, TelemetryBucket } from "./schemas";

export interface ProviderTotal {
  readonly provider: string;
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
}

export interface TelemetrySample {
  readonly timestamp: number;
  readonly served: number;
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
  readonly inFlight: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly providers: readonly ProviderTotal[];
}

export const providerTotals = (stats: AdminStats): readonly ProviderTotal[] => {
  const totals = new Map<string, { successes: number; failures: number }>();
  for (const account of stats.accounts) {
    const current = totals.get(account.provider) ?? { successes: 0, failures: 0 };
    current.successes += account.ok;
    current.failures += account.fails;
    totals.set(account.provider, current);
  }
  return [...totals.entries()]
    .map(([provider, total]) => ({
      provider,
      requests: total.successes + total.failures,
      successes: total.successes,
      failures: total.failures,
    }))
    .sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider));
};

const counterDelta = (current: number, previous: number | undefined): number =>
  previous === undefined || current < previous ? current : current - previous;

const latency = (stats: AdminStats): { readonly p50Ms: number; readonly p90Ms: number } =>
  typeof stats.ttft === "number"
    ? { p50Ms: stats.ttft, p90Ms: stats.ttft }
    : { p50Ms: stats.ttft?.p50_ms ?? 0, p90Ms: stats.ttft?.p90_ms ?? 0 };

export const appendTelemetrySample = (
  samples: readonly TelemetrySample[],
  stats: AdminStats,
  timestamp: number,
): readonly TelemetrySample[] => {
  const previous = samples.at(-1);
  const providers = providerTotals(stats);
  const previousProviders = new Map(
    previous?.providers.map((provider) => [provider.provider, provider]) ?? [],
  );
  const providerDeltas = providers.map((provider) => {
    const prior = previousProviders.get(provider.provider);
    const successes = counterDelta(provider.successes, prior?.successes);
    const failures = counterDelta(provider.failures, prior?.failures);
    return { provider: provider.provider, requests: successes + failures, successes, failures };
  });
  const successes = providerDeltas.reduce((sum, provider) => sum + provider.successes, 0);
  const failures = providerDeltas.reduce((sum, provider) => sum + provider.failures, 0);
  const currentLatency = latency(stats);
  const next: TelemetrySample = {
    timestamp,
    served: stats.served,
    requests: counterDelta(stats.served, previous?.served),
    successes,
    failures,
    inFlight: stats.in_flight,
    p50Ms: currentLatency.p50Ms,
    p90Ms: currentLatency.p90Ms,
    providers,
  };
  return [...samples, next].slice(-36);
};

export const persistedTelemetrySamples = (
  buckets: readonly TelemetryBucket[],
): readonly TelemetrySample[] =>
  buckets.slice(-36).map((bucket) => ({
    timestamp: bucket.minute_unix * 1000,
    served: bucket.requests,
    requests: bucket.requests,
    successes: bucket.successes,
    failures: bucket.failures,
    inFlight: 0,
    p50Ms: 0,
    p90Ms: 0,
    providers: bucket.providers,
  }));

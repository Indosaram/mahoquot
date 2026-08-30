import type { AdminStats, TelemetryBucket } from "./schemas";

export interface ProviderTotal {
  readonly provider: string;
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
}

export interface AccountTotal {
  readonly id: string;
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
  readonly accounts: readonly AccountTotal[];
}

export type TelemetryRange = "30m" | "1h" | "1d" | "7d" | "30d";

const rangeDurationMs: Readonly<Record<TelemetryRange, number>> = {
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

export const rangeSeconds = (range: TelemetryRange): number => rangeDurationMs[range] / 1000;

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
  const previousAccounts = new Map(
    previous?.accounts.map((account) => [account.id, account]) ?? [],
  );
  const accounts = stats.accounts.map((account) => {
    const successes = counterDelta(account.ok, previousAccounts.get(account.id)?.successes);
    const failures = counterDelta(account.fails, previousAccounts.get(account.id)?.failures);
    return { id: account.id, requests: successes + failures, successes, failures };
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
    accounts,
  };
  return [...samples, next].slice(-43_200);
};

export const persistedTelemetrySamples = (
  buckets: readonly TelemetryBucket[],
): readonly TelemetrySample[] =>
  buckets.map((bucket) => ({
    timestamp: bucket.minute_unix * 1000,
    served: bucket.requests,
    requests: bucket.requests,
    successes: bucket.successes,
    failures: bucket.failures,
    inFlight: 0,
    p50Ms: 0,
    p90Ms: 0,
    providers: bucket.providers,
    accounts: [],
  }));

export const filterTelemetryRange = <T extends { readonly timestamp: number }>(
  samples: readonly T[],
  range: TelemetryRange,
  now = Date.now(),
): readonly T[] => {
  const earliest = now - rangeDurationMs[range];
  return samples.filter((sample) => sample.timestamp >= earliest && sample.timestamp <= now);
};

export const summarizeTelemetry = (samples: readonly TelemetrySample[]) => {
  const providers = new Map<string, ProviderTotal>();
  let requests = 0;
  let successes = 0;
  let failures = 0;
  for (const sample of samples) {
    requests += sample.requests;
    successes += sample.successes;
    failures += sample.failures;
    for (const provider of sample.providers) {
      const current = providers.get(provider.provider) ?? {
        provider: provider.provider,
        requests: 0,
        successes: 0,
        failures: 0,
      };
      providers.set(provider.provider, {
        provider: provider.provider,
        requests: current.requests + provider.requests,
        successes: current.successes + provider.successes,
        failures: current.failures + provider.failures,
      });
    }
  }
  return {
    requests,
    successes,
    failures,
    providers: [...providers.values()].sort(
      (a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider),
    ),
  };
};

export interface TelemetryPoint {
  readonly startMs: number;
  readonly endMs: number;
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
}

/**
 * Projects sparse, irregularly spaced samples onto a dense grid of fixed-width
 * buckets covering exactly [now - range, now].
 *
 * The chart derives x from array index, so the grid — not the caller — is what
 * makes the axis time-accurate: every bucket is the same duration, and idle
 * windows are present as explicit zeros rather than missing entries. Sampling
 * gaps therefore read as gaps instead of being interpolated away.
 */
export const telemetrySeries = (
  samples: readonly Pick<TelemetrySample, "timestamp" | "requests" | "successes" | "failures">[],
  range: TelemetryRange,
  now: number = Date.now(),
  points = 240,
): readonly TelemetryPoint[] => {
  const bucketCount = Math.max(1, Math.floor(points));
  const windowMs = rangeDurationMs[range];
  const bucketMs = windowMs / bucketCount;
  const start = now - windowMs;

  const series: TelemetryPoint[] = Array.from({ length: bucketCount }, (_, index) => ({
    startMs: start + index * bucketMs,
    endMs: start + (index + 1) * bucketMs,
    requests: 0,
    successes: 0,
    failures: 0,
  }));

  for (const sample of samples) {
    if (sample.timestamp < start || sample.timestamp > now) continue;
    // The final instant belongs to the last bucket rather than a phantom one.
    const index = Math.min(bucketCount - 1, Math.floor((sample.timestamp - start) / bucketMs));
    const bucket = series[index];
    if (!bucket) continue;
    series[index] = {
      ...bucket,
      requests: bucket.requests + sample.requests,
      successes: bucket.successes + sample.successes,
      failures: bucket.failures + sample.failures,
    };
  }

  return series;
};

/**
 * kiro-lb-style small multiple: the same dense bucketing as
 * {@link telemetrySeries}, scoped to one account. Idle windows stay explicit
 * zeros so an account that served nothing reads differently from one that is
 * missing from the window.
 */
export const accountRateSeries = (
  samples: readonly TelemetrySample[],
  accountId: string,
  range: TelemetryRange,
  now: number = Date.now(),
  points = 240,
): readonly TelemetryPoint[] =>
  telemetrySeries(
    samples.flatMap((sample) =>
      sample.accounts
        .filter((account) => account.id === accountId)
        .map((account) => ({
          timestamp: sample.timestamp,
          requests: account.requests,
          successes: account.successes,
          failures: account.failures,
        })),
    ),
    range,
    now,
    points,
  );

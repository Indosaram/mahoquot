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
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly hasRawInput?: boolean;
  readonly hasRawOutput?: boolean;
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
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /**
   * Cumulative per-provider counters as reported by the gateway. Kept
   * cumulative because the next sample subtracts against them to derive its
   * own deltas; aggregate over `providerDeltas` instead of summing these.
   */
  readonly providers: readonly ProviderTotal[];
  /**
   * Per-sample per-provider deltas, aligned with the top-level fields.
   * Optional so samples persisted before this field existed still load.
   */
  readonly providerDeltas?: readonly ProviderTotal[];
  readonly accounts: readonly AccountTotal[];
  readonly cumulativeAccounts?: readonly AccountTotal[];
  readonly tokensDerivedFromAccounts?: boolean;
}

export type TelemetryRange = "30m" | "1h" | "1d" | "7d" | "30d";

const rangeDurationMs: Readonly<Record<TelemetryRange, number>> = {
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

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
  const previousCumulativeAccounts = new Map(
    previous?.cumulativeAccounts?.map((account) => [account.id, account]) ?? [],
  );
  const accounts: AccountTotal[] = stats.accounts.map((account) => {
    const prev = previousCumulativeAccounts.get(account.id);
    const successes = counterDelta(account.ok, prev?.successes);
    const failures = counterDelta(account.fails, prev?.failures);
    const hasCurrentInput = account.input_tokens !== undefined;
    const hasCurrentOutput = account.output_tokens !== undefined;
    const hasTokens = hasCurrentInput || hasCurrentOutput;

    // Check if this account or token field was observed in the immediate previous sample.
    // If not (e.g. first observation or reappearing after an omission gap), re-establish baseline
    // so historical counter changes across the gap are not attributed to this single interval.
    const priorInSample = previous?.accounts.some((a) => a.id === account.id);
    const wasAccountOmitted = previous !== undefined && !priorInSample;
    const wasInputOmitted =
      wasAccountOmitted || (previous !== undefined && !prev?.hasRawInput);
    const wasOutputOmitted =
      wasAccountOmitted || (previous !== undefined && !prev?.hasRawOutput);
    const isNewInput = prev?.inputTokens === undefined || wasInputOmitted;
    const isNewOutput = prev?.outputTokens === undefined || wasOutputOmitted;

    const accountRequests = successes + failures;
    const inputTokens = account.input_tokens !== undefined
      ? isNewInput
        ? accountRequests > 0
          ? undefined
          : 0
        : counterDelta(account.input_tokens, prev?.inputTokens)
      : undefined;

    const outputTokens = account.output_tokens !== undefined
      ? isNewOutput
        ? accountRequests > 0
          ? undefined
          : 0
        : counterDelta(account.output_tokens, prev?.outputTokens)
      : undefined;

    const totalTokens = hasTokens ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined;
    return {
      id: account.id,
      requests: accountRequests,
      successes,
      failures,
      ...(hasTokens ? { inputTokens, outputTokens, totalTokens } : {}),
    };
  });

  // Preserve cumulative baselines per-account and per-field across historical polls
  // so temporary omission of a field or account does not reset counter baseline.
  const cumulativeAccountsMap = new Map(previousCumulativeAccounts);
  for (const account of stats.accounts) {
    const prev = cumulativeAccountsMap.get(account.id);
    const inTok = account.input_tokens ?? prev?.inputTokens;
    const outTok = account.output_tokens ?? prev?.outputTokens;
    const hasTok = inTok !== undefined || outTok !== undefined;
    cumulativeAccountsMap.set(account.id, {
      id: account.id,
      requests: account.ok + account.fails,
      successes: account.ok,
      failures: account.fails,
      inputTokens: inTok,
      outputTokens: outTok,
      totalTokens: hasTok ? (inTok ?? 0) + (outTok ?? 0) : undefined,
      hasRawInput: account.input_tokens !== undefined,
      hasRawOutput: account.output_tokens !== undefined,
    });
  }
  const cumulativeAccounts = [...cumulativeAccountsMap.values()];

  const successes = providerDeltas.reduce((sum, provider) => sum + provider.successes, 0);
  const failures = providerDeltas.reduce((sum, provider) => sum + provider.failures, 0);
  const hasAnyInput = accounts.some((a) => a.inputTokens !== undefined);
  const hasAnyOutput = accounts.some((a) => a.outputTokens !== undefined);
  const hasAnyTokens = hasAnyInput || hasAnyOutput;
  const inputTokens = hasAnyInput
    ? accounts.reduce((sum, account) => sum + (account.inputTokens ?? 0), 0)
    : undefined;
  const outputTokens = hasAnyOutput
    ? accounts.reduce((sum, account) => sum + (account.outputTokens ?? 0), 0)
    : undefined;
  const totalTokens = hasAnyTokens ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined;
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
    ...(hasAnyTokens ? { inputTokens, outputTokens, totalTokens } : {}),
    providers,
    providerDeltas,
    accounts,
    cumulativeAccounts,
    tokensDerivedFromAccounts: hasAnyTokens,
  };
  return [...samples, next].slice(-43_200);
};

export const persistedTelemetrySamples = (
  buckets: readonly TelemetryBucket[],
): readonly TelemetrySample[] =>
  buckets.map((bucket) => {
    const bucketInput = bucket.input_tokens;
    const bucketOutput = bucket.output_tokens;
    const hasBucketTokens = bucketInput !== undefined || bucketOutput !== undefined;
    const accounts = bucket.accounts.map((account) => {
      const inTok = account.input_tokens;
      const outTok = account.output_tokens;
      const hasAccTokens = inTok !== undefined || outTok !== undefined;
      return {
        id: account.account,
        requests: account.requests,
        successes: account.successes,
        failures: account.failures,
        ...(hasAccTokens
          ? {
              inputTokens: inTok,
              outputTokens: outTok,
              totalTokens: (inTok ?? 0) + (outTok ?? 0),
            }
          : {}),
      };
    });
    return {
      timestamp: bucket.minute_unix * 1000,
      served: bucket.requests,
      requests: bucket.requests,
      successes: bucket.successes,
      failures: bucket.failures,
      inFlight: 0,
      p50Ms: 0,
      p90Ms: 0,
      ...(hasBucketTokens
        ? {
            inputTokens: bucketInput,
            outputTokens: bucketOutput,
            totalTokens: (bucketInput ?? 0) + (bucketOutput ?? 0),
          }
        : {}),
      providers: bucket.providers,
      // Persisted buckets are already per-minute deltas, so both views coincide.
      providerDeltas: bucket.providers,
      accounts,
    };
  });

export const filterTelemetryRange = <T extends { readonly timestamp: number }>(
  samples: readonly T[],
  range: TelemetryRange,
  now = Date.now(),
): readonly T[] => {
  const earliest = now - rangeDurationMs[range];
  return samples.filter(
    (sample) => sample.timestamp >= earliest && sample.timestamp <= now + 60_000,
  );
};

export interface TokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly isInputSupported?: boolean;
  readonly isOutputSupported?: boolean;
  readonly isPartial?: boolean;
}

export interface AccountTokenTotal {
  readonly id: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens: number;
  readonly isInputSupported?: boolean;
  readonly isOutputSupported?: boolean;
  readonly isPartial?: boolean;
}

export const summarizeTelemetry = (samples: readonly TelemetrySample[]) => {
  const providers = new Map<string, ProviderTotal>();
  interface AccountAccumulator {
    id: string;
    sumInput: number;
    sumOutput: number;
    totalTokens: number;
    hasInput: boolean;
    hasOutput: boolean;
    hasMissingField: boolean;
  }
  const accounts = new Map<string, AccountAccumulator>();
  let requests = 0;
  let successes = 0;
  let failures = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let hasInputTokens = false;
  let hasOutputTokens = false;
  let hasMissingTokenRequest = false;

  for (const sample of samples) {
    requests += sample.requests;
    successes += sample.successes;
    failures += sample.failures;

    const sampleAccounts = sample.accounts;
    const accInputSum = sampleAccounts.reduce((sum, a) => sum + (a.inputTokens ?? 0), 0);
    const accOutputSum = sampleAccounts.reduce((sum, a) => sum + (a.outputTokens ?? 0), 0);
    const hasAccInput = sampleAccounts.some((a) => a.inputTokens !== undefined);
    const hasAccOutput = sampleAccounts.some((a) => a.outputTokens !== undefined);

    let sampleHasInput = false;
    let sampleHasOutput = false;

    if (sample.inputTokens !== undefined) {
      inputTokens += sample.inputTokens;
      hasInputTokens = true;
      sampleHasInput = true;
    } else if (hasAccInput) {
      inputTokens += accInputSum;
      hasInputTokens = true;
      sampleHasInput = true;
    }

    if (sample.outputTokens !== undefined) {
      outputTokens += sample.outputTokens;
      hasOutputTokens = true;
      sampleHasOutput = true;
    } else if (hasAccOutput) {
      outputTokens += accOutputSum;
      hasOutputTokens = true;
      sampleHasOutput = true;
    }

    // If a field is derived from accounts (i.e. omitted at the bucket level OR from polling sample),
    // check if any account that handled requests lacked that specific token field.
    const isInputDerivedFromAccounts =
      (sample.tokensDerivedFromAccounts || sample.inputTokens === undefined) && hasAccInput;
    const hasMissingDerivedInput =
      isInputDerivedFromAccounts &&
      sampleAccounts.some((a) => a.requests > 0 && a.inputTokens === undefined);

    const isOutputDerivedFromAccounts =
      (sample.tokensDerivedFromAccounts || sample.outputTokens === undefined) && hasAccOutput;
    const hasMissingDerivedOutput =
      isOutputDerivedFromAccounts &&
      sampleAccounts.some((a) => a.requests > 0 && a.outputTokens === undefined);

    const accountRequestsSum = sampleAccounts.reduce((sum, a) => sum + a.requests, 0);
    const hasUncoveredRequests =
      (isInputDerivedFromAccounts || isOutputDerivedFromAccounts) &&
      sample.requests > accountRequestsSum;

    if (
      sample.requests > 0 &&
      (!sampleHasInput || !sampleHasOutput || hasMissingDerivedInput || hasMissingDerivedOutput || hasUncoveredRequests)
    ) {
      hasMissingTokenRequest = true;
    }

    for (const provider of sample.providerDeltas ?? sample.providers) {
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

    for (const account of sampleAccounts) {
      const inTok = account.inputTokens;
      const outTok = account.outputTokens;
      const current = accounts.get(account.id);

      const hasInput = (current?.hasInput ?? false) || inTok !== undefined;
      const hasOutput = (current?.hasOutput ?? false) || outTok !== undefined;
      const hasMissingField =
        (current?.hasMissingField ?? false) ||
        (account.requests > 0 && (inTok === undefined || outTok === undefined));
      const sumInput = (current?.sumInput ?? 0) + (inTok ?? 0);
      const sumOutput = (current?.sumOutput ?? 0) + (outTok ?? 0);
      const totTok = account.totalTokens ?? (inTok ?? 0) + (outTok ?? 0);
      const totalTokens = (current?.totalTokens ?? 0) + totTok;

      accounts.set(account.id, {
        id: account.id,
        totalTokens,
        hasInput,
        hasOutput,
        hasMissingField,
        sumInput,
        sumOutput,
      });
    }
  }

  const accountTokens: AccountTokenTotal[] = [...accounts.values()]
    .filter((acc) => acc.hasInput || acc.hasOutput || acc.totalTokens > 0)
    .map((acc) => {
      const isInputSupported = acc.hasInput;
      const isOutputSupported = acc.hasOutput;
      const isPartial =
        (acc.hasInput || acc.hasOutput) &&
        (acc.hasMissingField || !acc.hasInput || !acc.hasOutput);
      return {
        id: acc.id,
        inputTokens: acc.hasInput ? acc.sumInput : undefined,
        outputTokens: acc.hasOutput ? acc.sumOutput : undefined,
        totalTokens: acc.totalTokens,
        isInputSupported,
        isOutputSupported,
        isPartial,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id));

  const hasTokenData = hasInputTokens || hasOutputTokens;
  const isPartial = hasTokenData && (hasMissingTokenRequest || !hasInputTokens || !hasOutputTokens);

  return {
    requests,
    successes,
    failures,
    tokenTotals: {
      inputTokens: hasInputTokens ? inputTokens : 0,
      outputTokens: hasOutputTokens ? outputTokens : 0,
      totalTokens: (hasInputTokens ? inputTokens : 0) + (hasOutputTokens ? outputTokens : 0),
      isInputSupported: hasInputTokens,
      isOutputSupported: hasOutputTokens,
      isPartial,
    },
    accountTokens,
    hasTokenData,
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
  const windowMs = rangeDurationMs[range];
  // Since telemetry is stored at 1-minute bucket resolution, the bucket count
  // must not exceed 1 bucket per minute (e.g. 30 buckets for 30m, 60 for 1h),
  // otherwise sub-minute buckets produce artificial zero gaps between minutes.
  const maxBucketsForRange = Math.max(1, Math.floor(windowMs / 60_000));
  const bucketCount = Math.max(1, Math.min(Math.floor(points), maxBucketsForRange));
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
    if (sample.timestamp < start || sample.timestamp > now + 60_000) continue;
    // The final instant belongs to the last bucket rather than a phantom one.
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((sample.timestamp - start) / bucketMs)),
    );
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

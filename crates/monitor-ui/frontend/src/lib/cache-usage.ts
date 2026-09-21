import type { HistoryEvent, HistoryTotals } from "./schemas";

export type CacheMetric = "cached-input-tokens" | "cache-write-tokens";

export type CacheTokenReading =
  | {
      readonly state: "measured";
      readonly tokens: number;
      readonly knownRequests: number;
      readonly requests: number;
    }
  | {
      readonly state: "partial";
      readonly tokens: number;
      readonly knownRequests: number;
      readonly requests: number;
    }
  | { readonly state: "unknown"; readonly knownRequests: number; readonly requests: number };

const knownEventFlag = {
  "cached-input-tokens": "cached-input-tokens-known",
  "cache-write-tokens": "cache-write-tokens-known",
} as const;

const knownRequestsField = {
  "cached-input-tokens": "cached-input-tokens-known-requests",
  "cache-write-tokens": "cache-write-tokens-known-requests",
} as const;

const reading = (tokens: number, knownRequests: number, requests: number): CacheTokenReading => {
  if (requests > 0 && knownRequests === 0) return { state: "unknown", knownRequests, requests };
  if (knownRequests < requests) return { state: "partial", tokens, knownRequests, requests };
  return { state: "measured", tokens, knownRequests, requests };
};

export const eventCacheTokens = (event: HistoryEvent, metric: CacheMetric): CacheTokenReading => {
  const tokens = event[metric] ?? 0;
  const known = event[knownEventFlag[metric]] ?? tokens > 0;
  return known
    ? { state: "measured", tokens, knownRequests: 1, requests: 1 }
    : { state: "unknown", knownRequests: 0, requests: 1 };
};

export const totalsCacheTokens = (
  totals: HistoryTotals,
  metric: CacheMetric,
): CacheTokenReading => {
  const tokens = totals[metric] ?? 0;
  const requests = totals.requests;
  const knownRequests = totals[knownRequestsField[metric]] ?? (tokens > 0 ? requests : 0);
  return reading(tokens, Math.min(knownRequests, requests), requests);
};

export const aggregateEventCacheTokens = (
  events: readonly HistoryEvent[],
  metric: CacheMetric,
): CacheTokenReading => {
  let tokens = 0;
  let knownRequests = 0;
  for (const event of events) {
    const item = eventCacheTokens(event, metric);
    if (item.state === "measured") {
      tokens += item.tokens;
      knownRequests += 1;
    }
  }
  return reading(tokens, knownRequests, events.length);
};

export const nonCachedInputTokens = (totals: HistoryTotals): CacheTokenReading => {
  const cached = totalsCacheTokens(totals, "cached-input-tokens");
  if (cached.state === "unknown") {
    return { state: "unknown", knownRequests: cached.knownRequests, requests: cached.requests };
  }
  // Requests that never reported a cached count contribute their full input
  // here, so the partial figure is an upper bound and the coverage fields say
  // by how much. Spend math accepts only the measured case.
  return {
    state: cached.state,
    tokens: Math.max(0, (totals["input-tokens"] ?? 0) - cached.tokens),
    knownRequests: cached.knownRequests,
    requests: cached.requests,
  };
};

export const UNAVAILABLE_LABEL = "Unavailable";

export const formatCacheTokens = (value: CacheTokenReading): string =>
  value.state === "unknown" ? UNAVAILABLE_LABEL : value.tokens.toLocaleString("en-US");

export const cacheCoverageNote = (value: CacheTokenReading): string | null =>
  value.state === "partial"
    ? `${value.knownRequests.toLocaleString("en-US")} of ${value.requests.toLocaleString("en-US")} requests`
    : null;

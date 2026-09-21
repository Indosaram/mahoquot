import { describe, expect, it } from "vitest";
import {
  aggregateEventCacheTokens,
  eventCacheTokens,
  nonCachedInputTokens,
  totalsCacheTokens,
} from "../lib/cache-usage";
import type { HistoryEvent, HistoryTotals } from "../lib/schemas";

const totals = (patch: Partial<HistoryTotals> = {}): HistoryTotals => ({
  requests: 10,
  "successful-requests": 10,
  "failed-requests": 0,
  "input-tokens": 1_000,
  "output-tokens": 500,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 1_500,
  "estimated-cost-usd": 1,
  ...patch,
});

const event = (patch: Partial<HistoryEvent> = {}): HistoryEvent => ({
  "event-id": "evt",
  "occurred-at-ms": 1_788_192_000_000,
  account: "account-a",
  provider: "codex",
  model: "gpt-5.6",
  "key-label": null,
  status: 200,
  succeeded: true,
  "input-tokens": 100,
  "output-tokens": 20,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 120,
  "latency-ms": 10,
  "estimated-cost-usd": 0.1,
  "price-version": null,
  ...patch,
});

describe("event cache token readings", () => {
  it("reports a genuine zero as measured when the gateway marks it known", () => {
    const reading = eventCacheTokens(
      event({ "cached-input-tokens": 0, "cached-input-tokens-known": true }),
      "cached-input-tokens",
    );

    expect(reading).toEqual({ state: "measured", tokens: 0, knownRequests: 1, requests: 1 });
  });

  it("reports an unreported metric as unknown even though the numeric field is zero", () => {
    const reading = eventCacheTokens(
      event({ "cached-input-tokens": 0, "cached-input-tokens-known": false }),
      "cached-input-tokens",
    );

    expect(reading).toEqual({ state: "unknown", knownRequests: 0, requests: 1 });
  });

  it("treats a legacy zero without the known flag as unknown and a legacy positive as measured", () => {
    expect(eventCacheTokens(event(), "cache-write-tokens")).toEqual({
      state: "unknown",
      knownRequests: 0,
      requests: 1,
    });
    expect(eventCacheTokens(event({ "cache-write-tokens": 64 }), "cache-write-tokens")).toEqual({
      state: "measured",
      tokens: 64,
      knownRequests: 1,
      requests: 1,
    });
  });

  it("resolves each metric independently", () => {
    const mixed = event({
      "cached-input-tokens": 0,
      "cached-input-tokens-known": true,
      "cache-write-tokens": 0,
      "cache-write-tokens-known": false,
    });

    expect(eventCacheTokens(mixed, "cached-input-tokens").state).toBe("measured");
    expect(eventCacheTokens(mixed, "cache-write-tokens").state).toBe("unknown");
  });
});

describe("totals cache token readings", () => {
  it("is measured when every request reported the metric", () => {
    const reading = totalsCacheTokens(
      totals({
        requests: 10,
        "cached-input-tokens": 400,
        "cached-input-tokens-known-requests": 10,
      }),
      "cached-input-tokens",
    );

    expect(reading).toEqual({ state: "measured", tokens: 400, knownRequests: 10, requests: 10 });
  });

  it("is partial when only part of the request set reported the metric", () => {
    const reading = totalsCacheTokens(
      totals({
        requests: 10,
        "cached-input-tokens": 400,
        "cached-input-tokens-known-requests": 4,
      }),
      "cached-input-tokens",
    );

    expect(reading).toEqual({ state: "partial", tokens: 400, knownRequests: 4, requests: 10 });
  });

  it("is unknown when no request reported the metric, regardless of the numeric sum", () => {
    expect(
      totalsCacheTokens(
        totals({ "cached-input-tokens": 0, "cached-input-tokens-known-requests": 0 }),
        "cached-input-tokens",
      ),
    ).toEqual({ state: "unknown", knownRequests: 0, requests: 10 });
  });

  it("falls back to the legacy numeric reading when the coverage counter is absent", () => {
    expect(totalsCacheTokens(totals({ "cache-write-tokens": 0 }), "cache-write-tokens")).toEqual({
      state: "unknown",
      knownRequests: 0,
      requests: 10,
    });
    expect(totalsCacheTokens(totals({ "cache-write-tokens": 90 }), "cache-write-tokens")).toEqual({
      state: "measured",
      tokens: 90,
      knownRequests: 10,
      requests: 10,
    });
  });

  it("treats an empty request set as a measured zero instead of unknown", () => {
    const reading = totalsCacheTokens(
      totals({ requests: 0, "input-tokens": 0, "total-tokens": 0 }),
      "cached-input-tokens",
    );

    expect(reading).toEqual({ state: "measured", tokens: 0, knownRequests: 0, requests: 0 });
  });
});

describe("aggregating events into a cache reading", () => {
  it("sums only the measured subset and reports partial coverage", () => {
    const reading = aggregateEventCacheTokens(
      [
        event({ "cache-write-tokens": 30, "cache-write-tokens-known": true }),
        event({ "cache-write-tokens": 0, "cache-write-tokens-known": true }),
        event({ "cache-write-tokens": 0, "cache-write-tokens-known": false }),
      ],
      "cache-write-tokens",
    );

    expect(reading).toEqual({ state: "partial", tokens: 30, knownRequests: 2, requests: 3 });
  });

  it("is unknown when no event reported the metric", () => {
    const reading = aggregateEventCacheTokens(
      [event({ "cache-write-tokens-known": false }), event({ "cache-write-tokens-known": false })],
      "cache-write-tokens",
    );

    expect(reading).toEqual({ state: "unknown", knownRequests: 0, requests: 2 });
  });
});

describe("non-cached input tokens", () => {
  it("subtracts the cached share only when cached input is fully measured", () => {
    const reading = nonCachedInputTokens(
      totals({
        requests: 10,
        "input-tokens": 1_000,
        "cached-input-tokens": 400,
        "cached-input-tokens-known-requests": 10,
      }),
    );

    expect(reading).toEqual({ state: "measured", tokens: 600, knownRequests: 10, requests: 10 });
  });

  it("stays unknown rather than assuming a full cache miss when cached input is unknown", () => {
    const reading = nonCachedInputTokens(
      totals({ "input-tokens": 1_000, "cached-input-tokens-known-requests": 0 }),
    );

    expect(reading).toEqual({ state: "unknown", knownRequests: 0, requests: 10 });
  });

  it("stays partial when only part of the request set reported cached input", () => {
    const reading = nonCachedInputTokens(
      totals({
        requests: 10,
        "input-tokens": 1_000,
        "cached-input-tokens": 400,
        "cached-input-tokens-known-requests": 4,
      }),
    );

    expect(reading.state).toBe("partial");
  });
});

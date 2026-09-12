import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOverviewAnalytics } from "../hooks/useOverviewAnalytics";
import type { NormalizedAccount } from "../lib/accounts";
import type { GatewayClients, HistoryStatsQuery } from "../lib/api";
import { EMPTY_ANALYTICS } from "../lib/overview-analytics";
import type { HistoryStatsResponse, HistoryTotals } from "../lib/schemas";
import type { TelemetrySample } from "../lib/telemetry";

const defaultTotals: HistoryTotals = {
  requests: 0,
  "successful-requests": 0,
  "failed-requests": 0,
  "input-tokens": 0,
  "output-tokens": 0,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 0,
  "estimated-cost-usd": 0,
};

const makeHistoryResponse = (
  groups: HistoryStatsResponse["groups"] = [],
  totalsPartial: Partial<HistoryTotals> = {},
): HistoryStatsResponse => ({
  totals: { ...defaultTotals, ...totalsPartial },
  groups,
});

const makeAccount = (id: string, email: string, provider: string): NormalizedAccount =>
  ({
    id,
    runtimeId: null,
    credentialName: null,
    disabled: false,
    authIndex: null,
    provider,
    plan: null,
    email,
    label: id,
    health: "healthy",
    healthRaw: "healthy",
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
    isCredentialOnly: false,
    canReset: false,
    resetCreditsAvailable: 0,
    supportsReset: false,
    resetCredits: [],
  }) as NormalizedAccount;

const makeTelemetrySample = (timestamp: number): TelemetrySample => ({
  timestamp,
  served: 50,
  requests: 50,
  successes: 45,
  failures: 5,
  inFlight: 1,
  p50Ms: 120,
  p90Ms: 250,
  inputTokens: 2000,
  outputTokens: 1000,
  totalTokens: 3000,
  providers: [
    {
      provider: "codex",
      requests: 30,
      successes: 28,
      failures: 2,
    },
    {
      provider: "claude",
      requests: 20,
      successes: 17,
      failures: 3,
    },
  ],
  providerDeltas: [
    {
      provider: "codex",
      requests: 30,
      successes: 28,
      failures: 2,
    },
    {
      provider: "claude",
      requests: 20,
      successes: 17,
      failures: 3,
    },
  ],
  accounts: [
    {
      id: "acc-1",
      requests: 30,
      successes: 28,
      failures: 2,
      inputTokens: 1200,
      outputTokens: 600,
      totalTokens: 1800,
    },
    {
      id: "acc-2",
      requests: 20,
      successes: 17,
      failures: 3,
      inputTokens: 800,
      outputTokens: 400,
      totalTokens: 1200,
    },
  ],
});

describe("useOverviewAnalytics", () => {
  const fixedNowMs = 1700000000000;
  const accounts: readonly NormalizedAccount[] = [
    makeAccount("acc-1", "acc1@example.com", "codex"),
    makeAccount("acc-2", "acc2@example.com", "claude"),
  ];
  const samples: readonly TelemetrySample[] = [
    makeTelemetrySample(fixedNowMs - 60000),
    makeTelemetrySample(fixedNowMs - 30000),
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Mount with enabled true issues exactly three historyStats calls and exposes source 'history'", async () => {
    const historyStatsMock = vi
      .fn<(query?: HistoryStatsQuery) => Promise<HistoryStatsResponse>>()
      .mockResolvedValueOnce(
        makeHistoryResponse(
          [
            {
              "bucket-start-ms": null,
              account: null,
              provider: "codex",
              model: null,
              "key-label": null,
              status: null,
              totals: {
                ...defaultTotals,
                requests: 100,
                "successful-requests": 95,
                "failed-requests": 5,
                "total-tokens": 50000,
              },
            },
            {
              "bucket-start-ms": null,
              account: null,
              provider: "claude",
              model: null,
              "key-label": null,
              status: null,
              totals: {
                ...defaultTotals,
                requests: 50,
                "successful-requests": 48,
                "failed-requests": 2,
                "total-tokens": 25000,
              },
            },
          ],
          { requests: 150, "total-tokens": 75000 },
        ),
      )
      .mockResolvedValueOnce(
        makeHistoryResponse([
          {
            "bucket-start-ms": fixedNowMs - 60000,
            account: null,
            provider: "codex",
            model: null,
            "key-label": null,
            status: null,
            totals: { ...defaultTotals, requests: 100, "total-tokens": 50000 },
          },
          {
            "bucket-start-ms": fixedNowMs - 60000,
            account: null,
            provider: "claude",
            model: null,
            "key-label": null,
            status: null,
            totals: { ...defaultTotals, requests: 50, "total-tokens": 25000 },
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeHistoryResponse([
          {
            "bucket-start-ms": fixedNowMs - 60000,
            account: null,
            provider: null,
            model: null,
            "key-label": null,
            status: null,
            totals: { ...defaultTotals, requests: 150, "total-tokens": 75000 },
          },
        ]),
      );

    const mockClients = {
      management: {
        historyStats: historyStatsMock,
      },
    } as unknown as GatewayClients;

    const { result } = renderHook(() =>
      useOverviewAnalytics({
        clients: mockClients,
        range: "1h",
        dimension: "provider",
        metric: "requests",
        accounts,
        samples,
        enabled: true,
        nowMs: fixedNowMs,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(historyStatsMock).toHaveBeenCalledTimes(3);
    expect(result.current.analytics.source).toBe("history");
    expect(result.current.analytics.dimension).toBe("provider");
    expect(result.current.analytics.rows.length).toBe(2);
    expect(result.current.error).toBe("");
  });

  it("Changing metric from 'requests' to 'tokens' issues ZERO additional historyStats calls", async () => {
    const historyStatsMock = vi
      .fn<(query?: HistoryStatsQuery) => Promise<HistoryStatsResponse>>()
      .mockResolvedValueOnce(
        makeHistoryResponse(
          [
            {
              "bucket-start-ms": null,
              account: null,
              provider: "codex",
              model: null,
              "key-label": null,
              status: null,
              totals: {
                ...defaultTotals,
                requests: 100,
                "total-tokens": 10000,
              },
            },
            {
              "bucket-start-ms": null,
              account: null,
              provider: "claude",
              model: null,
              "key-label": null,
              status: null,
              totals: {
                ...defaultTotals,
                requests: 50,
                "total-tokens": 90000,
              },
            },
          ],
          { requests: 150, "total-tokens": 100000 },
        ),
      )
      .mockResolvedValueOnce(
        makeHistoryResponse([
          {
            "bucket-start-ms": fixedNowMs - 60000,
            account: null,
            provider: "codex",
            model: null,
            "key-label": null,
            status: null,
            totals: { ...defaultTotals, requests: 100, "total-tokens": 10000 },
          },
          {
            "bucket-start-ms": fixedNowMs - 60000,
            account: null,
            provider: "claude",
            model: null,
            "key-label": null,
            status: null,
            totals: { ...defaultTotals, requests: 50, "total-tokens": 90000 },
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeHistoryResponse([
          {
            "bucket-start-ms": fixedNowMs - 60000,
            account: null,
            provider: null,
            model: null,
            "key-label": null,
            status: null,
            totals: { ...defaultTotals, requests: 150, "total-tokens": 100000 },
          },
        ]),
      );

    const mockClients = {
      management: {
        historyStats: historyStatsMock,
      },
    } as unknown as GatewayClients;

    let currentMetric: "requests" | "tokens" = "requests";
    const { result, rerender } = renderHook(() =>
      useOverviewAnalytics({
        clients: mockClients,
        range: "1h",
        dimension: "provider",
        metric: currentMetric,
        accounts,
        samples,
        enabled: true,
        nowMs: fixedNowMs,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(historyStatsMock).toHaveBeenCalledTimes(3);
    // With requests, codex (100) is first
    expect(result.current.analytics.rows[0]?.key).toBe("codex");

    // Switch to tokens
    currentMetric = "tokens";
    rerender();

    await waitFor(() => {
      expect(result.current.analytics.metric).toBe("tokens");
    });

    // ZERO additional fetch calls
    expect(historyStatsMock).toHaveBeenCalledTimes(3);
    // With tokens, claude (90000) is first
    expect(result.current.analytics.rows[0]?.key).toBe("claude");
  });

  it("Changing dimension issues a new round; a late response from the previous dimension is discarded (assert the exposed analytics.dimension matches the newest one)", async () => {
    let resolveLateProviderRanking!: (value: HistoryStatsResponse) => void;
    const lateProviderRankingPromise = new Promise<HistoryStatsResponse>((resolve) => {
      resolveLateProviderRanking = resolve;
    });

    const historyStatsMock = vi.fn<(query?: HistoryStatsQuery) => Promise<HistoryStatsResponse>>(
      async (query) => {
        if (query?.groupBy?.includes("model")) {
          // ranking (["model", "provider"]) or series (["model"]) for model
          return makeHistoryResponse(
            [
              {
                "bucket-start-ms": null,
                account: null,
                provider: "codex",
                model: "gpt-4o",
                "key-label": null,
                status: null,
                totals: { ...defaultTotals, requests: 80 },
              },
            ],
            { requests: 80 },
          );
        }
        if (query?.groupBy?.includes("provider")) {
          // ranking or series for provider
          return lateProviderRankingPromise;
        }
        // totalSeries or default
        return makeHistoryResponse([], { requests: 80 });
      },
    );

    const mockClients = {
      management: {
        historyStats: historyStatsMock,
      },
    } as unknown as GatewayClients;

    let currentDimension: "provider" | "model" = "provider";
    const { result, rerender } = renderHook(() =>
      useOverviewAnalytics({
        clients: mockClients,
        range: "1h",
        dimension: currentDimension,
        metric: "requests",
        accounts,
        samples,
        enabled: true,
        nowMs: fixedNowMs,
      }),
    );

    // Provider fetch is initiated and waiting on lateProviderRankingPromise
    expect(historyStatsMock).toHaveBeenCalledTimes(1);

    // Switch dimension to model before provider resolves
    currentDimension = "model";
    rerender();

    // Model query should finish fast
    await waitFor(() => {
      expect(result.current.analytics.dimension).toBe("model");
    });
    expect(result.current.analytics.rows[0]?.key).toBe("gpt-4o");

    // Now the slow provider ranking finally resolves
    act(() => {
      resolveLateProviderRanking(
        makeHistoryResponse(
          [
            {
              "bucket-start-ms": null,
              account: null,
              provider: "codex",
              model: null,
              "key-label": null,
              status: null,
              totals: { ...defaultTotals, requests: 999 },
            },
          ],
          { requests: 999 },
        ),
      );
    });

    // Stale provider response must be discarded; dimension must still be model
    expect(result.current.analytics.dimension).toBe("model");
    expect(result.current.analytics.rows[0]?.key).toBe("gpt-4o");
  });

  it("historyStats rejecting with an Error whose message contains 'history worker is unavailable' leaves analytics.source === 'telemetry', analytics.rows non-empty for dimension 'provider' given seeded samples, and error non-empty", async () => {
    const historyStatsMock = vi
      .fn<(query?: HistoryStatsQuery) => Promise<HistoryStatsResponse>>()
      .mockRejectedValue(new Error("history worker is unavailable"));

    const mockClients = {
      management: {
        historyStats: historyStatsMock,
      },
    } as unknown as GatewayClients;

    const { result } = renderHook(() =>
      useOverviewAnalytics({
        clients: mockClients,
        range: "1h",
        dimension: "provider",
        metric: "requests",
        accounts,
        samples,
        enabled: true,
        nowMs: fixedNowMs,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.analytics.source).toBe("telemetry");
    expect(result.current.analytics.rows.length).toBeGreaterThan(0);
    expect(result.current.error).toContain("history worker is unavailable");
  });

  it("enabled false performs no fetch", async () => {
    const historyStatsMock = vi.fn<(query?: HistoryStatsQuery) => Promise<HistoryStatsResponse>>();

    const mockClients = {
      management: {
        historyStats: historyStatsMock,
      },
    } as unknown as GatewayClients;

    const { result } = renderHook(() =>
      useOverviewAnalytics({
        clients: mockClients,
        range: "1h",
        dimension: "provider",
        metric: "requests",
        accounts,
        samples,
        enabled: false,
        nowMs: fixedNowMs,
      }),
    );

    expect(historyStatsMock).not.toHaveBeenCalled();
    expect(result.current.analytics).toEqual(EMPTY_ANALYTICS("provider", "requests", "1h"));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe("");
  });

  it("refresh() forces a fresh round of queries", async () => {
    const historyStatsMock = vi
      .fn<(query?: HistoryStatsQuery) => Promise<HistoryStatsResponse>>()
      .mockResolvedValue(makeHistoryResponse([], { requests: 10 }));

    const mockClients = {
      management: {
        historyStats: historyStatsMock,
      },
    } as unknown as GatewayClients;

    const { result } = renderHook(() =>
      useOverviewAnalytics({
        clients: mockClients,
        range: "1h",
        dimension: "provider",
        metric: "requests",
        accounts,
        samples,
        enabled: true,
        nowMs: fixedNowMs,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(historyStatsMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      await result.current.refresh();
    });

    expect(historyStatsMock).toHaveBeenCalledTimes(6);
  });

  it("repeat round skips when document.hidden is true, and runs when document.hidden is false", async () => {
    vi.useFakeTimers();

    const historyStatsMock = vi
      .fn<(query?: HistoryStatsQuery) => Promise<HistoryStatsResponse>>()
      .mockResolvedValue(makeHistoryResponse([], { requests: 10 }));

    const mockClients = {
      management: {
        historyStats: historyStatsMock,
      },
    } as unknown as GatewayClients;

    renderHook(() =>
      useOverviewAnalytics({
        clients: mockClients,
        range: "1h",
        dimension: "provider",
        metric: "requests",
        accounts,
        samples,
        enabled: true,
        nowMs: fixedNowMs,
      }),
    );

    // Initial round
    expect(historyStatsMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(historyStatsMock).toHaveBeenCalledTimes(3);

    // Simulate tab hidden
    const originalHidden = document.hidden;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    // Should NOT have triggered a new round while hidden
    expect(historyStatsMock).toHaveBeenCalledTimes(3);

    // Simulate tab visible again
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    // Should have triggered repeat round
    expect(historyStatsMock).toHaveBeenCalledTimes(6);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => originalHidden,
    });
    vi.useRealTimers();
  });

  it("isLoading is true only while the first round for a given cache key is in flight", async () => {
    const historyStatsMock = vi
      .fn<(query?: HistoryStatsQuery) => Promise<HistoryStatsResponse>>()
      .mockResolvedValue(makeHistoryResponse([], { requests: 10 }));

    const mockClients = {
      management: {
        historyStats: historyStatsMock,
      },
    } as unknown as GatewayClients;

    let currentDimension: "provider" | "account" = "provider";
    const { result, rerender } = renderHook(() =>
      useOverviewAnalytics({
        clients: mockClients,
        range: "1h",
        dimension: currentDimension,
        metric: "requests",
        accounts,
        samples,
        enabled: true,
        nowMs: fixedNowMs,
      }),
    );

    // First round for 1h|provider is in flight -> isLoading is true
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Switch to account (first round for 1h|account)
    currentDimension = "account";
    act(() => {
      rerender();
    });
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Switch back to provider (cache hit!) -> isLoading remains false
    currentDimension = "provider";
    act(() => {
      rerender();
    });
    expect(result.current.isLoading).toBe(false);

    // Await background revalidation so no in-flight updates leak past the test
    await waitFor(() => {
      expect(historyStatsMock).toHaveBeenCalledTimes(9);
    });
  });
});

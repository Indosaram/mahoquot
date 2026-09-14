import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOverviewAnalytics } from "../hooks/useOverviewAnalytics";
import type { GatewayClients } from "../lib/api";
import { HistoryStatsResponseSchema } from "../lib/schemas";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("overview analytics error surface", () => {
  it("reports a readable failure instead of raw validator output", async () => {
    // A gateway whose payload no longer matches the console's schema is what a
    // version skew looks like; the boundary parser throws a ZodError.
    const parseFailure = (() => {
      try {
        HistoryStatsResponseSchema.parse({ unexpected: true });
        throw new Error("schema unexpectedly accepted the payload");
      } catch (error) {
        return error;
      }
    })();

    const historyStatsMock = vi.fn(async () => {
      throw parseFailure;
    });
    // A stable clients identity, as App.tsx memoizes it; a fresh object each
    // render bumps the generation guard and discards the round.
    const clients = {
      management: { historyStats: historyStatsMock },
    } as unknown as GatewayClients;

    const accounts: never[] = [];
    const samples: never[] = [];

    const { result } = renderHook(() =>
      useOverviewAnalytics({
        clients,
        range: "1d",
        dimension: "provider",
        metric: "requests",
        accounts,
        samples,
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.error).not.toBe(""));

    const message = result.current.error;
    // A validator dump is not an error message: it leaks internals and tells
    // the operator nothing about what to do next.
    expect(message).not.toMatch(/"code":/);
    expect(message).not.toMatch(/"path":/);
    expect(message.length).toBeLessThan(200);
  });
});

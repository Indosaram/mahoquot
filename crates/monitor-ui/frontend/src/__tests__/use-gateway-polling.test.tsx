import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGatewayPolling } from "../hooks/useGatewayPolling";
import { createGatewayClients } from "../lib/api";
import type { AdminStats } from "../lib/schemas";

const baseStats: AdminStats = {
  uptime_secs: 10,
  in_flight: 0,
  served: 10,
  failed_over: 0,
  refreshed: 1,
  ttft: null,
  accounts: [],
  history: [],
};

describe("useGatewayPolling generation guard", () => {
  it("discards slow in-flight stats when a newer client or poll completes first", async () => {
    let resolveSlowStats: (response: Response) => void = () => undefined;
    const slowStatsPromise = new Promise<Response>((resolve) => {
      resolveSlowStats = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("18801") && url.includes("/admin/stats")) {
          return slowStatsPromise;
        }
        if (url.includes("18802") && url.includes("/admin/stats")) {
          return new Response(JSON.stringify({ ...baseStats, uptime_secs: 999, served: 999 }));
        }
        if (url.includes("/healthz")) {
          return new Response(JSON.stringify({ status: "ok", version: "1.0", api_schema: 1 }));
        }
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs")) {
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        }
        if (url.includes("model-registry")) {
          return new Response(
            JSON.stringify({
              source: "remote_signed",
              "catalog-version": 1,
              generation: 1,
              "generated-at": 0,
              "loaded-at": 0,
              stale: false,
              "last-refresh": {
                outcome: "success",
                "attempted-at": 0,
                "duration-ms": 0,
                "rejection-reason": null,
              },
              "provider-count": 1,
              "model-count": 1,
              "refresh-in-flight": false,
            }),
          );
        }
        if (url.includes("/v1/models")) return new Response(JSON.stringify({ data: [] }));
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    const clientA = createGatewayClients("http://127.0.0.1:18801", "keyA");
    const clientB = createGatewayClients("http://127.0.0.1:18802", "keyB");

    const { result, rerender } = renderHook(({ clients }) => useGatewayPolling(clients), {
      initialProps: { clients: clientA },
    });

    // Client A request is in-flight (waiting on slowStatsPromise)
    expect(result.current.stats.uptime_secs).toBe(0);

    // Rerender with Client B
    rerender({ clients: clientB });

    // Client B resolves quickly
    await waitFor(() => {
      expect(result.current.stats.uptime_secs).toBe(999);
    });

    // Now resolve Client A's slow promise
    await act(async () => {
      resolveSlowStats(
        new Response(JSON.stringify({ ...baseStats, uptime_secs: 111, served: 111 })),
      );
    });

    // Ensure Client A's stale response did NOT overwrite Client B's state
    expect(result.current.stats.uptime_secs).toBe(999);
  });

  it("R4 regression: clears telemetry and stats when switching gateway clients", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("18801") && url.includes("/admin/stats")) {
          return new Response(
            JSON.stringify({
              ...baseStats,
              uptime_secs: 100,
              history: [
                {
                  minute_unix: 1_800,
                  requests: 4,
                  successes: 4,
                  failures: 0,
                  input_tokens: 120,
                  output_tokens: 30,
                  providers: [],
                  accounts: [],
                },
              ],
            }),
          );
        }
        if (url.includes("18802") && url.includes("/admin/stats")) {
          return new Response(
            JSON.stringify({
              ...baseStats,
              uptime_secs: 200,
              history: [],
            }),
          );
        }
        if (url.includes("/healthz")) {
          return new Response(JSON.stringify({ status: "ok", version: "1.0", api_schema: 1 }));
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    const clientA = createGatewayClients("http://127.0.0.1:18801", "keyA");
    const clientB = createGatewayClients("http://127.0.0.1:18802", "keyB");

    const { result, rerender } = renderHook(({ clients }) => useGatewayPolling(clients), {
      initialProps: { clients: clientA },
    });

    await waitFor(() => {
      expect(result.current.telemetry).toHaveLength(1);
      expect(result.current.telemetry[0].inputTokens).toBe(120);
    });

    // Switch to client B
    act(() => {
      rerender({ clients: clientB });
    });

    await waitFor(() => {
      expect(result.current.stats.uptime_secs).toBe(200);
      expect(result.current.telemetry).toHaveLength(0);
    });
  });
});

import { nextPollDelayMs, useGatewayPolling } from "@/hooks/useGatewayPolling";
import { createGatewayClients } from "@/lib/api";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const okStats = {
  uptime_secs: 3600,
  in_flight: 0,
  served: 3,
  failed_over: 0,
  refreshed: 0,
  ttft: null,
  accounts: [],
  history: [],
};

const statsUrl = /\/admin\/stats/;

function makeClients() {
  return createGatewayClients("http://127.0.0.1:18801", "k");
}

describe("startup loading", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  // Startup contract: the first fetch happens on mount, never after an
  // interval; the fast-retry cadence is pinned by nextPollDelayMs below.
  it("fetches on mount before any interval elapses", async () => {
    let statsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (statsUrl.test(String(input))) {
          statsCalls += 1;
          if (statsCalls <= 2) throw new Error("connect ECONNREFUSED");
          return new Response(JSON.stringify(okStats));
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    const clients = makeClients();
    renderHook(() => useGatewayPolling(clients));
    await waitFor(() => expect(statsCalls).toBe(1));
  });

  // Reveal contract: the console window starts hidden; when the OS brings it
  // to front (dock reopen / tray open) the visible data must load right then,
  // not on the next background tick.
  it("refreshes immediately when the window gains focus", async () => {
    let focused: ((event: { payload: boolean }) => void) | null = null;
    vi.stubGlobal("__TAURI__", {
      window: {
        getCurrentWindow: () => ({
          onFocusChanged: (cb: (event: { payload: boolean }) => void) => {
            focused = cb;
            return Promise.resolve(() => {});
          },
        }),
      },
    });
    let statsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (statsUrl.test(String(input))) {
          statsCalls += 1;
          return new Response(JSON.stringify(okStats));
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    const clients = makeClients();
    renderHook(() => useGatewayPolling(clients));
    await waitFor(() => expect(statsCalls).toBe(1));

    await act(async () => {
      focused?.({ payload: true });
    });
    expect(statsCalls).toBeGreaterThanOrEqual(2);

    // unfocusing must not trigger anything
    const before = statsCalls;
    await act(async () => {
      focused?.({ payload: false });
    });
    expect(statsCalls).toBe(before);
  });
});

describe("poll cadence decision", () => {
  it("settles to the poll interval after a success", () => {
    expect(nextPollDelayMs(true, true, 2_000)).toBe(10_000);
  });
  it("keeps retrying fast while the first success is still pending", () => {
    expect(nextPollDelayMs(false, false, 2_000)).toBe(2_000);
    expect(nextPollDelayMs(false, false, 2_000)).not.toBe(4_000);
  });
  it("backs off exponentially only after a success existed", () => {
    expect(nextPollDelayMs(false, true, 2_000)).toBe(4_000);
    expect(nextPollDelayMs(false, true, 100_000)).toBe(60_000);
  });
});

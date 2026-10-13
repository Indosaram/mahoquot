import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSettingsScalarsStatus, useConnectionSettings } from "../hooks/useConnectionSettings";
import { useGatewayPolling } from "../hooks/useGatewayPolling";
import { useOverviewAnalytics } from "../hooks/useOverviewAnalytics";
import { useTotpVault } from "../hooks/useTotpVault";
import { type GatewayClients, GatewayError } from "../lib/api";
import * as native from "../lib/native";
import type { AdminStats, HistoryStatsResponse } from "../lib/schemas";
import { type TotpSecretStore, TotpVault } from "../lib/totp-vault";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const scalarAnswers: Record<string, Record<string, unknown>> = {
  "proxy-url": { "proxy-url": "http://127.0.0.1:7890" },
  "routing/strategy": { strategy: "fill-first" },
  "request-retry": { "request-retry": 5 },
  "logging-to-file": { "logging-to-file": true },
  "codex-fast-mode": { "codex-fast-mode": false },
  "proxy-providers": {
    "proxy-providers": { codex: { enabled: true, sticky: true, "ttl-secs": 60, url: "x" } },
  },
};

const settingsHook = (scalar: (path: string) => Promise<Record<string, unknown>>) => {
  const saveScalar = vi.fn(async () => undefined);
  const setNotice = vi.fn();
  const clients = { management: { scalar, saveScalar } } as unknown as GatewayClients;
  const view = renderHook(() =>
    useConnectionSettings({
      clients,
      loadState: "online",
      surface: "settings",
      setNotice,
      setPending: vi.fn(),
    }),
  );
  return { ...view, saveScalar, setNotice };
};

describe("useConnectionSettings (review item 1)", () => {
  it("refuses to save the provider table when its read failed", async () => {
    const { result, saveScalar, setNotice } = settingsHook(async (path) => {
      if (path === "proxy-providers") throw new GatewayError("boom", 500);
      return scalarAnswers[path] ?? {};
    });
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.providersLoaded).toBe(false);

    act(() => result.current.updateProxyProviderPolicy("claude", { enabled: true }));
    await act(async () => {
      await result.current.saveProviderProxySettings();
    });
    expect(saveScalar).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenLastCalledWith(
      expect.stringContaining("Provider proxy routing has not loaded"),
    );
  });

  it("saves the provider table once it loaded", async () => {
    const { result, saveScalar } = settingsHook(async (path) => scalarAnswers[path] ?? {});
    await waitFor(() => expect(result.current.providersLoaded).toBe(true));
    await act(async () => {
      await result.current.saveProviderProxySettings();
    });
    expect(saveScalar).toHaveBeenCalledWith("proxy-providers", {
      codex: { enabled: true, sticky: true, "ttl-secs": 60, url: "x" },
    });
  });

  it.each([
    ["wrong-typed", { "request-retry": "5" }],
    ["missing", {}],
  ])("does not latch defaults as loaded when a scalar is %s", async (_label, retryAnswer) => {
    const { result, saveScalar } = settingsHook(async (path) =>
      path === "request-retry" ? retryAnswer : (scalarAnswers[path] ?? {}),
    );
    await waitFor(() => expect(getSettingsScalarsStatus()).toBe("error"));
    expect(result.current.settingsLoaded).toBe(false);
    await act(async () => {
      await result.current.saveProxySettings();
    });
    expect(saveScalar).not.toHaveBeenCalled();
  });
});

const storedVault = (label: string) =>
  JSON.stringify({
    version: 1,
    entries: [
      {
        id: label,
        label,
        issuer: null,
        account: null,
        secret: SECRET,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        createdAt: 1,
      },
    ],
  });

describe("useTotpVault (review item 2)", () => {
  it("does not touch the keychain while disabled", async () => {
    const read = vi.spyOn(native, "readDesktopSecret").mockResolvedValue(null);
    renderHook(() => useTotpVault("http://127.0.0.1:18801", false));
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
  });

  it("clears entries when a reload fails", async () => {
    const read = vi.spyOn(native, "readDesktopSecret").mockResolvedValue(storedVault("kept"));
    const { result } = renderHook(() => useTotpVault("http://127.0.0.1:18801", true));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    read.mockRejectedValue(new Error("keychain locked"));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.poisoned).toBe(true);
    expect(result.current.entries).toEqual([]);
    expect(result.current.codes).toEqual({});
  });

  it("drops the previous endpoint's entries the moment the endpoint changes", async () => {
    const pending = deferred<string | null>();
    vi.spyOn(native, "readDesktopSecret").mockImplementation((endpoint) =>
      endpoint.endsWith("18801") ? Promise.resolve(storedVault("old")) : pending.promise,
    );
    const { result, rerender } = renderHook(({ endpoint }) => useTotpVault(endpoint, true), {
      initialProps: { endpoint: "http://127.0.0.1:18801" },
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    rerender({ endpoint: "http://127.0.0.1:18802" });
    expect(result.current.entries).toEqual([]);
    expect(result.current.codes).toEqual({});
    await act(async () => {
      pending.resolve(null);
    });
  });

  it("reports a rejected clipboard write", async () => {
    vi.spyOn(native, "readDesktopSecret").mockResolvedValue(storedVault("copy"));
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { result } = renderHook(() => useTotpVault("http://127.0.0.1:18801", true));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    const entry = result.current.entries[0];
    if (!entry) throw new Error("entry missing");

    await act(async () => {
      result.current.copyCode(entry, "123456");
    });
    expect(result.current.error).toContain("permission denied");
  });
});

const history = (requests: number): HistoryStatsResponse => ({
  totals: {
    requests,
    "successful-requests": requests,
    "failed-requests": 0,
    "input-tokens": 0,
    "output-tokens": 0,
    "cached-input-tokens": 0,
    "cache-write-tokens": 0,
    "reasoning-tokens": 0,
    "total-tokens": 0,
    "estimated-cost-usd": 0,
  },
  groups: [],
});

const analyticsHook = (historyStats: () => Promise<HistoryStatsResponse>) => {
  const clients = { management: { historyStats } } as unknown as GatewayClients;
  const accounts: never[] = [];
  const samples: never[] = [];
  return renderHook(() =>
    useOverviewAnalytics({
      clients,
      range: "1h",
      dimension: "provider",
      metric: "requests",
      accounts,
      samples,
      enabled: true,
      nowMs: 1_700_000_000_000,
    }),
  );
};

describe("useOverviewAnalytics (review item 3)", () => {
  it.each([429, 503, 0])(
    "keeps cached history and raises no banner when a later round fails with %s",
    async (status) => {
      const historyStats = vi.fn(async () => history(10));
      const { result } = analyticsHook(historyStats);
      await waitFor(() => expect(result.current.analytics.totals.requests).toBe(10));
      const before = result.current.analytics;

      historyStats.mockRejectedValue(new GatewayError("upstream busy", status));
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.error).toBe("");
      expect(result.current.analytics).toBe(before);
    },
  );

  it("raises no banner for an operational first-round failure", async () => {
    const { result } = analyticsHook(async () => {
      throw new GatewayError("rate limited", 429);
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.analytics.source).toBe("telemetry");
    expect(result.current.error).toBe("");
  });

  it("raises a banner for an auth failure even over cached history", async () => {
    const historyStats = vi.fn(async () => history(10));
    const { result } = analyticsHook(historyStats);
    await waitFor(() => expect(result.current.analytics.totals.requests).toBe(10));

    historyStats.mockRejectedValue(new GatewayError("unauthorized", 401));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe("unauthorized");
    expect(result.current.analytics.source).toBe("history");
  });

  it("refreshes when the document becomes visible", async () => {
    const historyStats = vi.fn(async () => history(10));
    const { result } = analyticsHook(historyStats);
    await waitFor(() => expect(result.current.analytics.totals.requests).toBe(10));
    expect(historyStats).toHaveBeenCalledTimes(3);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(historyStats).toHaveBeenCalledTimes(6));
  });
});

const stats: AdminStats = {
  uptime_secs: 1,
  in_flight: 0,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  ttft: null,
  accounts: [],
  history: [],
};

const pollingClients = () => {
  const admin = {
    stats: vi.fn(async (): Promise<AdminStats> => stats),
    health: vi.fn(async () => ({ status: "ok", version: "1.0", api_schema: 1 })),
  };
  const management = {
    credentials: vi.fn(async (): Promise<unknown[]> => [{ name: "acct.json" }]),
    logs: vi.fn(async () => ({ records: [], "request-count": 0, "proxy-count": 0 })),
    modelRegistryStatus: vi.fn(async () => null),
    models: vi.fn(async (): Promise<unknown[]> => [{ id: "model-a" }]),
    usageRefresh: vi.fn(async () => undefined),
  };
  return { admin, management, clients: { admin, management } as unknown as GatewayClients };
};

const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));

describe("useGatewayPolling (review item 4)", () => {
  it("does not back off when a poll round is superseded by a manual refresh", async () => {
    vi.useFakeTimers();
    const { admin, clients } = pollingClients();
    const { result } = renderHook(() => useGatewayPolling(clients));
    await flush();
    expect(admin.stats).toHaveBeenCalledTimes(1);

    // Next poll round hangs; a manual refresh supersedes it.
    const slow = deferred<AdminStats>();
    admin.stats.mockImplementationOnce(() => slow.promise);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(admin.stats).toHaveBeenCalledTimes(2);
    await act(async () => {
      await expect(result.current.refresh()).resolves.toBe(true);
    });
    await act(async () => {
      slow.resolve(stats);
    });
    await flush();

    // A failure-counted supersession would push the next poll to 20s.
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(admin.stats).toHaveBeenCalledTimes(4);
  });

  it("keeps the last good credentials and models when a later read rejects", async () => {
    vi.useFakeTimers();
    const { management, clients } = pollingClients();
    const { result } = renderHook(() => useGatewayPolling(clients));
    await flush();
    expect(result.current.credentials).toHaveLength(1);
    expect(result.current.gatewayModels).toHaveLength(1);

    management.credentials.mockRejectedValue(new GatewayError("bad gateway", 502));
    management.models.mockRejectedValue(new GatewayError("bad gateway", 502));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.credentials).toHaveLength(1);
    expect(result.current.gatewayModels).toHaveLength(1);
    expect(result.current.credentialsError).toBe("bad gateway");
  });

  it("re-runs the schema probe when the gateway comes back online", async () => {
    vi.useFakeTimers();
    const { admin, clients } = pollingClients();
    admin.health.mockResolvedValueOnce({ status: "ok", version: "0.9", api_schema: 99 });
    const { result } = renderHook(() => useGatewayPolling(clients));
    await flush();
    await flush();
    expect(result.current.schemaMismatch).not.toBeNull();

    admin.stats.mockRejectedValueOnce(new GatewayError("down", 503));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.loadState).toBe("starting");
    await act(async () => {
      await result.current.refresh();
    });
    await flush();
    expect(result.current.loadState).toBe("online");
    expect(admin.health).toHaveBeenCalledTimes(2);
    expect(result.current.schemaMismatch).toBeNull();
  });

  it("clears the manual-refresh min-spin timer on unmount", async () => {
    vi.useFakeTimers();
    const { clients } = pollingClients();
    const { result, unmount } = renderHook(() => useGatewayPolling(clients));
    await flush();
    await act(async () => {
      await result.current.refreshNow();
    });
    expect(result.current.refreshing).toBe(true);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

class DeferredStore implements TotpSecretStore {
  value: string | null = null;
  nextRead: Promise<string | null> | null = null;
  async read(): Promise<string | null> {
    const pending = this.nextRead;
    this.nextRead = null;
    return pending ?? this.value;
  }
  async write(value: string): Promise<void> {
    this.value = value;
  }
  async delete(): Promise<void> {
    this.value = null;
  }
}

describe("TotpVault (review item 5)", () => {
  it("a read issued before a write cannot overwrite the written entry", async () => {
    const store = new DeferredStore();
    let id = 0;
    const vault = new TotpVault(store, { createId: () => `id-${++id}` });
    await vault.load();

    const staleRead = deferred<string | null>();
    store.nextRead = staleRead.promise;
    const loading = vault.load();
    const adding = vault.add(SECRET, "new");
    staleRead.resolve(null);
    await loading;
    await adding;

    expect(vault.entries.map((entry) => entry.label)).toEqual(["new"]);
    await vault.add(SECRET, "second");
    expect(JSON.parse(store.value ?? "{}").entries).toHaveLength(2);
  });

  it("serializes concurrent mutations so none is lost", async () => {
    const store = new DeferredStore();
    let id = 0;
    const vault = new TotpVault(store, { createId: () => `id-${++id}` });
    await vault.load();

    await Promise.all([vault.add(SECRET, "a"), vault.add(SECRET, "b")]);
    expect(vault.entries.map((entry) => entry.label)).toEqual(["a", "b"]);
    expect(JSON.parse(store.value ?? "{}").entries).toHaveLength(2);
  });

  it("keeps working after a failed operation", async () => {
    const store = new DeferredStore();
    const vault = new TotpVault(store, { createId: () => "only" });
    await vault.load();
    await expect(vault.remove("missing")).rejects.toThrow("not found");
    await vault.add(SECRET, "after");
    expect(vault.entries).toHaveLength(1);
  });
});

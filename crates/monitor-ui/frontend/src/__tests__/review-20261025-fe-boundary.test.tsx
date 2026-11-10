import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGatewayPolling } from "../hooks/useGatewayPolling";
import { useTotpVault } from "../hooks/useTotpVault";
import { createGatewayClients } from "../lib/api";
import { isRelayTarget, relayUsageOverride, RELAY_USAGE_BASE_URL } from "../lib/relay-plans";
import { DEFAULT_GATEWAY_URL, resolveGatewayEndpoint } from "../lib/storage";

const base = "http://127.0.0.1:18849";
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

afterEach(() => {
  cleanup();
  window.__MAHOQUOT_MANAGEMENT__ = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("B01 obsolete polling callbacks", () => {
  it("does not start A stats after A usage settles under B, or after unmount", async () => {
    const usage = deferred<void>();
    const started = deferred<void>();
    const a = createGatewayClients(base, "a");
    const b = createGatewayClients("http://127.0.0.1:18848", "b");
    const stats = { uptime_secs: 1, in_flight: 0, served: 7, failed_over: 0, refreshed: 0, ttft: null, accounts: [], history: [] };
    for (const client of [a, b]) {
      vi.spyOn(client.admin, "stats").mockResolvedValue({ ...stats, served: client === a ? 1 : 7 });
      vi.spyOn(client.admin, "health").mockResolvedValue({ status: "ok", version: "1", api_schema: 1 });
      vi.spyOn(client.management, "credentials").mockResolvedValue([]);
      vi.spyOn(client.management, "logs").mockResolvedValue({ records: [], "request-count": 0, "proxy-count": 0 });
      vi.spyOn(client.management, "modelRegistryStatus").mockRejectedValue(new Error("fixture unavailable"));
      vi.spyOn(client.management, "models").mockResolvedValue([]);
    }
    vi.spyOn(a.management, "usageRefresh").mockImplementation(async () => { started.resolve(); await usage.promise; });
    const view = renderHook(({ client }) => useGatewayPolling(client), { initialProps: { client: a } });
    await act(async () => { await view.result.current.refresh(); });
    const old = view.result.current;
    let pending!: Promise<void>;
    await act(async () => { pending = old.refreshNow(); await started.promise; });
    view.rerender({ client: b });
    await act(async () => { await view.result.current.refresh(); });
    const calls = vi.mocked(a.admin.stats).mock.calls.length;
    await act(async () => { usage.resolve(); await pending; });
    expect(a.admin.stats).toHaveBeenCalledTimes(calls);
    expect(view.result.current.stats.served).toBe(7);
    await old.refreshUsage(true);
    expect(a.management.usageRefresh).toHaveBeenCalledTimes(1);
    const current = view.result.current;
    view.unmount();
    const bCalls = vi.mocked(b.admin.stats).mock.calls.length;
    expect(await current.refresh()).toBe(false);
    expect(b.admin.stats).toHaveBeenCalledTimes(bCalls);
  });
});

describe("B02 endpoint-owned vault writes", () => {
  it.each(["success", "failure", "unmount"])("ignores old publication on %s but emits successful store changes", async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:05Z"));
    const write = deferred<void>();
    const started = deferred<void>();
    const emit = vi.fn().mockResolvedValue(undefined);
    const stored = new Map<string, string>();
    stored.set("http://127.0.0.1:18848", JSON.stringify({ version: 1, entries: [{
      id: "b", label: "B", issuer: "Fixture", account: "b@example.test",
      secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", algorithm: "SHA1", digits: 6, period: 30, createdAt: 1,
    }] }));
    vi.stubGlobal("__TAURI__", { event: { emit, listen: async () => () => {} } });
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: async (command: string, args: { request: { endpoint: string; value?: string } }) => {
        const { endpoint, value } = args.request;
        if (command === "read_secret") return stored.get(endpoint) ?? null;
        if (command === "write_secret") {
          started.resolve();
          await write.promise;
          stored.set(endpoint, value ?? "");
          return null;
        }
        throw new Error(`Unexpected IPC ${command}`);
      },
    });
    const view = renderHook(({ endpoint }) => useTotpVault(endpoint, true), { initialProps: { endpoint: base } });
    await act(async () => { await view.result.current.reload(); });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = view.result.current.add("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "A").catch((error: unknown) => error);
      await started.promise;
    });
    view.rerender({ endpoint: "http://127.0.0.1:18848" });
    await act(async () => { await view.result.current.reload(); });
    const bEntries = view.result.current.entries;
    const bCodes = view.result.current.codes;
    expect(bEntries.map((entry) => entry.id)).toEqual(["b"]);
    expect(bCodes.b).toMatch(/^\d{6}$/);
    if (outcome === "unmount") view.unmount();
    await act(async () => {
      if (outcome === "failure") write.reject(new Error("A write failed"));
      else write.resolve();
      await pending;
    });
    expect(view.result.current.entries).toEqual(bEntries);
    expect(view.result.current.codes).toEqual(bCodes);
    expect(view.result.current.error).toBeNull();
    expect(emit).toHaveBeenCalledTimes(outcome === "failure" ? 0 : 1);
    expect(stored.has(base)).toBe(outcome !== "failure");
    expect(JSON.parse(stored.get("http://127.0.0.1:18848") ?? "{}").entries[0].id).toBe("b");
  });
});

describe("B03 hostname-label relay policy", () => {
  it.each([
    "https://example.test/ccapi/v1", "https://example.test/?nekos=ccapi",
    "https://ccapi:nekos@example.test/v1", "https://notccapi.example.test",
    "https://ccapi-lookalike.example.test", "https://nekosnot.example.test",
    "not a URL ccapi", "file://ccapi/path",
  ])("does not classify %s as a relay", (url) => {
    expect(isRelayTarget(url)).toBe(false);
    expect(relayUsageOverride(url)).toBeNull();
  });
  it("preserves supported hostname labels without letting path markers override them", () => {
    expect(isRelayTarget("https://api.ccapi.example.com/v1")).toBe(true);
    expect(relayUsageOverride("https://ccapi.labs.mengmota.com/nekos?nekos=1")).toBe(RELAY_USAGE_BASE_URL);
    expect(isRelayTarget("https://CLAUDE.NEKOS.ME/")).toBe(true);
    expect(relayUsageOverride("https://claude.nekos.me/ccapi")).toBeNull();
  });
});

describe("B04 header composition", () => {
  it.each(["dedicated", "recovered", "missing", "browser"])("retains export secret with %s management auth", async (mode) => {
    if (mode !== "browser") window.__MAHOQUOT_MANAGEMENT__ = { endpoint: base, key: mode === "dedicated" ? "dedicated" : "" };
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke: vi.fn().mockResolvedValue(mode === "recovered" ? "recovered" : null) });
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(new Headers(init.headers));
      return new Response("event_id\n");
    }));
    await createGatewayClients(base, "inference").management.exportHistory("csv", {}, "export-secret");
    expect(requests[0]?.get("x-mahoquot-export-authorization")).toBe("export-secret");
    expect(requests[0]?.get("authorization")).toBe(mode === "missing" ? null : `Bearer ${mode === "browser" ? "inference" : mode}`);
  });
  it("merges request JSON headers with dedicated auth using Headers", async () => {
    window.__MAHOQUOT_MANAGEMENT__ = { endpoint: base, key: "dedicated" };
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await createGatewayClients(base, "inference").management.saveScalar("proxy-url", "");
    const headers = new Headers(fetch.mock.calls[0]?.[1].headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer dedicated");
  });
});

describe("B07 cancellable log reconnect", () => {
  it("recovers after EOF and transport failure and delivers a request without resubscription", async () => {
    vi.useFakeTimers();
    const closed = [deferred<void>(), deferred<void>()];
    const delivered = deferred<void>();
    let failures = 0;
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.close(); } })))
      .mockRejectedValueOnce(new TypeError("fixture disconnect"))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"kind":"request","status":200}\n\n'));
        controller.close();
      } })));
    vi.stubGlobal("fetch", fetch);
    const dispose = createGatewayClients(base, "fake").management.subscribeLogs((record) => {
      expect(record.kind).toBe("request");
      delivered.resolve();
    }, () => { closed[failures++]?.resolve(); });
    await closed[0]?.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await closed[1]?.promise;
    await vi.advanceTimersByTimeAsync(2000);
    await delivered.promise;
    dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([200, 401, 403])("disposal or terminal status %s prevents retries", async (status) => {
    vi.useFakeTimers();
    const closed = deferred<void>();
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal("fetch", fetch);
    const dispose = createGatewayClients(base, "fake").management.subscribeLogs(() => {}, () => closed.resolve());
    await closed.promise;
    if (status === 200) dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("B08 environment-resolved endpoint identity", () => {
  it("resolves blank browser input to the document origin for requests and secret identity", async () => {
    vi.stubGlobal("__TAURI__", undefined);
    const endpoint = resolveGatewayEndpoint("  ");
    expect(endpoint).toBe(window.location.origin);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await createGatewayClients(endpoint, "fake").admin.reset("a");
    expect(fetch.mock.calls[0]?.[0]).toBe(`${window.location.origin}/admin/accounts/a/reset`);
    vi.stubGlobal("__TAURI__", {});
    expect(resolveGatewayEndpoint("")).toBe(DEFAULT_GATEWAY_URL);
    expect(resolveGatewayEndpoint(`${base}/ `)).toBe(base);
  });
});

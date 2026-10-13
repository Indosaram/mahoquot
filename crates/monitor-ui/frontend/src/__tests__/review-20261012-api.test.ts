import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayClients, discoverProviderModels, fetchClineModelLists } from "../lib/api";
import {
  DevinAccountStatusSchema,
  LogsResponseSchema,
  ModelRegistryStatusSchema,
  SchedulerAccountStatusSchema,
  parseAdminStats,
} from "../lib/schemas";

const base = "http://127.0.0.1:18840";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stubFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return handler(String(input), init);
    }),
  );
  return calls;
};

const registryStatus = {
  source: "remote_unsigned",
  "catalog-version": 1,
  generation: 1,
  "generated-at": null,
  "loaded-at": 1,
  stale: false,
  "last-refresh": { outcome: "success" },
  "provider-count": 1,
  "model-count": 1,
  "refresh-in-flight": false,
};

describe("schema tolerance (items 1, 3, 11)", () => {
  it("keeps the whole logs list when one record has an unknown kind", () => {
    const parsed = LogsResponseSchema.parse({
      records: [
        { kind: "request", status: 200 },
        { kind: "warmup", message: "probe" },
      ],
    });
    expect(parsed.records.map((record) => record.kind)).toEqual(["request", "warmup"]);
  });

  it("accepts fractional and out-of-range remaining_percent", () => {
    const row = {
      id: "a",
      selected: true,
      parked: false,
      priority: null,
      reset_at_unix: null,
      consecutive_non_auth_failures: 0,
    };
    expect(
      SchedulerAccountStatusSchema.parse({ ...row, remaining_percent: 37.5 }).remaining_percent,
    ).toBe(37.5);
    expect(
      SchedulerAccountStatusSchema.parse({ ...row, remaining_percent: 100.4 }).remaining_percent,
    ).toBe(100.4);
  });

  it("maps unknown registry source and devin status to a neutral value", () => {
    expect(ModelRegistryStatusSchema.parse(registryStatus).source).toBe("unknown");
    expect(ModelRegistryStatusSchema.parse({ ...registryStatus, source: "lkg_cache" }).source).toBe(
      "lkg_cache",
    );
    expect(DevinAccountStatusSchema.parse({ identity_slug: "d", status: "expired" }).status).toBe(
      "unknown",
    );
  });

  it("treats an unknown provider auth state as still pending", async () => {
    stubFetch(() => new Response(JSON.stringify({ status: "expired" })));
    const status = await createGatewayClients(base, "k").management.providerAuthStatus("s");
    expect(status.status).toBe("pending");
  });
});

describe("unknown never becomes zero (items 2, 14)", () => {
  const stats = (ttft: unknown, lastError: unknown) => ({
    accounts: [{ id: "a", ttft, last_error: lastError }],
    ttft,
  });

  it("leaves missing ttft percentiles and samples undefined", () => {
    const parsed = parseAdminStats(stats({ samples: 3 }, null));
    expect(parsed.ttft).toEqual({ samples: 3 });
    expect(parsed.accounts[0]?.ttft).toEqual({ samples: 3 });
  });

  it("keeps a bare-number ttft as p50 only without inventing samples", () => {
    const parsed = parseAdminStats(stats(250, null));
    expect(parsed.ttft).toEqual({ p50_ms: 250 });
    expect(parsed.accounts[0]?.ttft).toEqual({ p50_ms: 250 });
  });

  it("does not invent a 1970 timestamp for a last error without unix_ms", () => {
    const parsed = parseAdminStats(stats(null, { status: 401, message: "x" }));
    expect(parsed.accounts[0]?.last_error).toEqual({ status: 401, message: "x" });
  });

  it("treats a last error with no status as unknown instead of status 0", () => {
    const parsed = parseAdminStats(stats(null, { message: "x" }));
    expect(parsed.accounts[0]?.last_error).toBeNull();
  });
});

describe("request body handling (items 4, 5)", () => {
  it("times out when the body stalls after headers", async () => {
    vi.useFakeTimers();
    stubFetch(
      (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
        ),
    );
    const pending = createGatewayClients(base, "k").admin.stats();
    const outcome = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
  });

  it("treats a 200 with an empty body as success", async () => {
    stubFetch(() => new Response("", { status: 200 }));
    await expect(createGatewayClients(base, "k").admin.reset("a")).resolves.toBeUndefined();
  });
});

describe("boundary validation (items 6, 7, 12, 13)", () => {
  it("rejects a credential order ack without names", async () => {
    stubFetch(() => new Response(JSON.stringify({ order: ["a"] })));
    await expect(
      createGatewayClients(base, "k").management.saveCredentialOrder(["a"]),
    ).rejects.toThrow();
  });

  it("accepts the wrapped or bare excluded-models map and rejects anything else", async () => {
    let body: unknown = { "oauth-excluded-models": { codex: ["m1"] } };
    stubFetch(() => new Response(JSON.stringify(body)));
    const management = createGatewayClients(base, "k").management;
    await expect(management.excludedModels()).resolves.toEqual({ codex: ["m1"] });
    body = { codex: ["m2"] };
    await expect(management.excludedModels()).resolves.toEqual({ codex: ["m2"] });
    body = null;
    await expect(management.excludedModels()).rejects.toThrow();
    body = { "oauth-excluded-models": "nope" };
    await expect(management.excludedModels()).rejects.toThrow();
  });

  it("accepts a camelCase-only credits ack", async () => {
    stubFetch(() => new Response(JSON.stringify({ id: "a", creditsAfterLimit: true })));
    const ack = await createGatewayClients(base, "k").management.setCodexCreditsOptIn("a", true);
    expect(ack.credits_after_limit).toBe(true);
  });

  it("rejects a credits ack with neither spelling", async () => {
    stubFetch(() => new Response(JSON.stringify({ id: "a" })));
    await expect(
      createGatewayClients(base, "k").management.setCodexCreditsOptIn("a", true),
    ).rejects.toThrow();
  });

  it("refuses scalar paths outside the management slug grammar", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({})));
    const management = createGatewayClients(base, "k").management;
    for (const path of ["../admin/stats", "proxy-url?x=1", "proxy-url#a", "Proxy-Url", ""]) {
      await expect(management.scalar(path)).rejects.toThrow(/Invalid management path/);
      await expect(management.saveScalar(path, 1)).rejects.toThrow(/Invalid management path/);
    }
    expect(calls).toEqual([]);
    await management.scalar("routing/strategy");
    expect(calls[0]?.url).toBe(`${base}/v0/management/routing/strategy`);
  });
});

describe("external and raw fetches carry a deadline (item 8)", () => {
  it("passes an abort signal to configYaml, Cline lists and provider discovery", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ data: [] })));
    await createGatewayClients(base, "k").management.configYaml();
    await fetchClineModelLists();
    await discoverProviderModels("http://example.com");
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(calls[1]?.init?.headers).get("Authorization")).toBeNull();
  });
});

describe("contracts C1 and C2 (items 9, 10)", () => {
  it("sends the caller-supplied export secret without prompting", async () => {
    const prompt = vi.fn(() => "prompted");
    vi.stubGlobal("prompt", prompt);
    const calls = stubFetch(() => new Response("event_id\n"));
    const blob = await createGatewayClients(base, "k").management.exportHistory(
      "csv",
      {},
      "export-secret",
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(await blob?.text()).toBe("event_id\n");
    expect(new Headers(calls[0]?.init?.headers).get("x-mahoquot-export-authorization")).toBe(
      "export-secret",
    );
  });

  it("reports stream errors with whether the stream closed", () => {
    class FakeEventSource {
      static readonly CLOSED = 2;
      static last: FakeEventSource | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 0;
      constructor(readonly url: string) {
        FakeEventSource.last = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const errors: boolean[] = [];
    createGatewayClients(base, "k").management.subscribeLogs(
      () => {},
      (closed) => errors.push(closed),
    );
    const source = FakeEventSource.last;
    if (!source) throw new Error("no stream opened");
    source.onerror?.();
    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.();
    expect(errors).toEqual([false, true]);
  });
});

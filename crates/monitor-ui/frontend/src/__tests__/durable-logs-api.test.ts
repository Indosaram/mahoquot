import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayClients } from "../lib/api";

const totals = {
  requests: 1,
  "successful-requests": 1,
  "failed-requests": 0,
  "input-tokens": 10,
  "output-tokens": 5,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 15,
  "estimated-cost-usd": 0.01,
};

const event = {
  "event-id": "event-1",
  "occurred-at-ms": 1_788_192_000_000,
  account: "account-a",
  provider: "codex",
  model: "gpt-5.6-sol",
  "key-label": "key-prod",
  status: 200,
  succeeded: true,
  "input-tokens": 10,
  "output-tokens": 5,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 15,
  "latency-ms": 87,
  "estimated-cost-usd": 0.01,
  "price-version": "2026-09",
};

afterEach(() => vi.unstubAllGlobals());

describe("durable logs API", () => {
  it("serializes cursor pagination and every filter", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify(
            String(input).includes("/events/event%2F1")
              ? { event }
              : { events: [event], "next-cursor": 41, totals },
          ),
        );
      }),
    );

    const management = createGatewayClients("http://127.0.0.1:18840", "key").management;
    const result = await management.historyEvents({
      startMs: 10,
      endMs: 20,
      accounts: ["account-a"],
      providers: ["codex"],
      models: ["gpt-5.6-sol"],
      keyLabels: ["key-prod"],
      statusCodes: [200, 429],
      outcomes: ["failed"],
      search: "event-1",
      cursor: 42,
      limit: 50,
    });

    expect(result.events).toEqual([event]);
    const url = new URL(calls[0] ?? "");
    expect(url.pathname).toBe("/v0/management/history/events");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "start-ms": "10",
      "end-ms": "20",
      account: "account-a",
      provider: "codex",
      model: "gpt-5.6-sol",
      "key-label": "key-prod",
      status: "200,429",
      outcome: "failed",
      text: "event-1",
      limit: "50",
      cursor: "42",
    });

    await expect(management.historyEvent("event/1")).resolves.toEqual(event);
    expect(new URL(calls[1] ?? "").pathname).toBe("/v0/management/history/events/event%2F1");
  });

  it("confirms scoped clear and downloads redacted CSV and JSON payloads", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "export-secret"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
        });
        if ((init?.method ?? "GET") === "DELETE") {
          return new Response(JSON.stringify({ deleted: 1 }));
        }
        if (new URL(url).pathname.endsWith("/history/count")) {
          return new Response(JSON.stringify({ count: 1 }));
        }
        return new Response(
          url.includes("format=csv")
            ? "event_id\nevent-1\n"
            : JSON.stringify({ count: 1, events: [event] }),
        );
      }),
    );

    const management = createGatewayClients("http://127.0.0.1:18840", "key").management;
    await expect(
      management.historyCount({ accounts: ["account-a"], limit: 50, cursor: 42 }),
    ).resolves.toBe(1);
    await expect(
      management.clearHistory({ accounts: ["account-a"], limit: 50, cursor: 42 }),
    ).resolves.toBe(1);
    const csv = await management.exportHistory("csv", { providers: ["codex"] });
    const json = await management.exportHistory("json", { providers: ["codex"] });
    expect(csv).toBeDefined();
    expect(json).toBeDefined();
    if (!csv || !json) throw new Error("export unexpectedly cancelled");
    expect(csv.size).toBeGreaterThan(0);
    expect(json.size).toBeGreaterThan(0);
    expect(csv.type).toBe("text/plain;charset=utf-8");
    expect(json.type).toBe("application/json");
    await expect(csv.text()).resolves.toBe("event_id\nevent-1\n");
    expect(json.size).toBe(JSON.stringify({ count: 1, events: [event] }).length);

    expect(
      calls.map(({ url, method }) => [new URL(url).pathname + new URL(url).search, method]),
    ).toEqual([
      ["/v0/management/history/count?account=account-a", "GET"],
      ["/v0/management/history/events?account=account-a&confirm=true", "DELETE"],
      ["/v0/management/history/export?provider=codex&format=csv", "GET"],
      ["/v0/management/history/export?provider=codex&format=json", "GET"],
    ]);
    expect(calls[2]?.headers.get("x-mahoquot-export-authorization")).toBe("export-secret");
    expect(calls[2]?.headers.get("x-mahoquot-export-authorization")).not.toBe("key");
    expect(calls[3]?.headers.get("x-mahoquot-export-authorization")).toBe("export-secret");
  });
});

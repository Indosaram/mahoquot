import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayClients } from "../lib/api";
afterEach(() => vi.unstubAllGlobals());

describe("warmup management boundary", () => {
  it("saves and reloads provider defaults and every account mode", async () => {
    const providers: Record<string, unknown> = {};
    const accounts: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") {
        expect([
          "/v0/management/warmup/settings/provider/provider%2Fname",
          "/v0/management/warmup/settings/account/account%2Fid",
        ]).toContain(url);
        expect(init.headers).toMatchObject({
          Authorization: "Bearer master",
          "Content-Type": "application/json",
        });
        const value: unknown = JSON.parse(String(init.body));
        const segments = url.split("/");
        const key = segments.at(-1);
        if (key === undefined) throw new Error(`warmup mock saw no key in ${url}`);
        (url.includes("/provider/") ? providers : accounts)[decodeURIComponent(key)] = value;
        return Response.json(value);
      }
      expect(["/v0/management/warmup/settings", "/v0/management/warmup/status"]).toContain(url);
      return Response.json(
        url === "/v0/management/warmup/status" ? { accounts: {} } : { providers, accounts },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = createGatewayClients("", "master").management;
    const policy = {
      enabled: true,
      model: "discovered/model",
      idle_secs: 30,
      min_interval_secs: 60,
    };
    expect(await api.saveWarmupProvider("provider/name", policy)).toEqual(policy);
    for (const mode of [
      { type: "inherit" },
      { type: "off" },
      { type: "custom", model: null, idle_secs: 20, min_interval_secs: 40 },
    ] as const) {
      expect(await api.saveWarmupAccount("account/id", mode)).toEqual(mode);
      expect((await api.warmupSettings()).accounts["account/id"]).toEqual(mode);
    }
    expect((await api.warmupSettings()).providers["provider/name"]).toEqual(policy);
    expect(await api.warmupStatus()).toEqual({ accounts: {} });
    expect(fetchMock.mock.calls[0]).toMatchObject([
      "/v0/management/warmup/settings/provider/provider%2Fname",
      {
        method: "PUT",
        headers: { Authorization: "Bearer master", "Content-Type": "application/json" },
      },
    ]);
    expect(fetchMock.mock.calls[1]).toMatchObject([
      "/v0/management/warmup/settings/account/account%2Fid",
      {
        method: "PUT",
        headers: { Authorization: "Bearer master", "Content-Type": "application/json" },
      },
    ]);
  });

  it("parses unsuccessful manual results instead of discarding them", async () => {
    const result = {
      id: "a",
      provider: "codex",
      ok: false,
      status: 200,
      latency_ms: 2,
      stream_validated: false,
      detail: "empty_stream",
      probed_model: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(result)),
    );
    expect(await createGatewayClients("", "").admin.warm("a")).toEqual(result);
  });
});

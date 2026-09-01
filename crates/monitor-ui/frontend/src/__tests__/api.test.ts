import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGatewayClients } from "../lib/api";
import { RawCredentialDocumentSchema } from "../lib/schemas";

describe("credential order resync and raw import guard", () => {
  it("returns the server's saved order so a stale capture cannot resurrect a reverted order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ names: ["c.json", "a.json"] }))),
    );
    const clients = createGatewayClients("http://127.0.0.1:18801", "k");
    const saved = await clients.management.saveCredentialOrder(["a.json", "c.json"]);
    expect(saved).toEqual(["c.json", "a.json"]);
  });

  it("falls back to an empty order when the server omits names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "ok" }))),
    );
    const clients = createGatewayClients("http://127.0.0.1:18801", "k");
    expect(await clients.management.saveCredentialOrder(["a.json"])).toEqual([]);
  });

  it("rejects raw credential documents that are empty or not objects", () => {
    expect(RawCredentialDocumentSchema.safeParse({}).success).toBe(false);
    expect(RawCredentialDocumentSchema.safeParse("{}").success).toBe(false);
    expect(RawCredentialDocumentSchema.safeParse(null).success).toBe(false);
    expect(RawCredentialDocumentSchema.safeParse([]).success).toBe(false);
    expect(RawCredentialDocumentSchema.safeParse({ type: "kiro" }).success).toBe(true);
  });
});

describe("unified gateway auth boundary", () => {
  it("uses the API key for both admin and management routes", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("auth-files")) {
        return new Response(JSON.stringify({ files: [] }));
      }
      return new Response(
        JSON.stringify({
          uptime_secs: 0,
          in_flight: 0,
          served: 0,
          failed_over: 0,
          refreshed: 0,
          ttft: null,
          accounts: [],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const clients = createGatewayClients("http://127.0.0.1:18801", "api-secret");
    await clients.admin.stats();
    expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer api-secret" });
    await clients.management.credentials();
    expect(calls[1]?.init?.headers).toEqual({ Authorization: "Bearer api-secret" });
  });

  it("loads and saves raw YAML only through the management boundary", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return init?.method === "PUT"
          ? new Response(JSON.stringify({ ok: true }))
          : new Response("port: 18801\n");
      }),
    );
    const clients = createGatewayClients("", "api-secret");
    expect(await clients.management.configYaml()).toContain("18801");
    await clients.management.saveConfigYaml("port: 18801\n");
    expect(calls[1]?.url).toBe("/v0/management/config.yaml");
    expect(calls[1]?.init).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "application/yaml", Authorization: "Bearer api-secret" },
      body: "port: 18801\n",
    });
  });

  it("uses management auth for lifecycle actions and preserves account order", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({ status: "ok", url: "https://example.com", state: "s" }),
        );
      }),
    );
    const clients = createGatewayClients("http://127.0.0.1:18801", "api-key");
    await clients.management.importLocalClaude();
    await clients.management.saveCredentialOrder(["b.json", "a.json"]);
    await clients.management.createGenericCredential({
      provider: "deepseek",
      label: "Primary DeepSeek",
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "secret",
      models: ["deepseek-chat"],
    });
    await clients.management.beginProviderAuth("claude");
    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
      ["http://127.0.0.1:18801/v0/management/claude/import-local", "POST"],
      ["http://127.0.0.1:18801/v0/management/auth-files/order", "PUT"],
      ["http://127.0.0.1:18801/v0/management/auth-files", "POST"],
      ["http://127.0.0.1:18801/v0/management/anthropic-auth-url", "GET"],
    ]);
    expect(
      calls.every(
        (call) => new Headers(call.init?.headers).get("Authorization") === "Bearer api-key",
      ),
    ).toBe(true);
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ names: ["b.json", "a.json"] }));
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      content: {
        type: "generic",
        provider: "deepseek",
        adapter: "openai-chat",
        base_url: "https://api.deepseek.com",
        api_key: "secret",
        models: ["deepseek-chat"],
      },
    });
  });

  it("only starts provider auth on routes the gateway actually serves", async () => {
    // The mocked e2e routes used to hide that the console asked for
    // /gemini-cli-auth-url and /kiro-auth-url, which the gateway never served.
    const contract = JSON.parse(
      readFileSync(resolve(process.cwd(), "../../../.omo/upstream/route-groups.json"), "utf8"),
    ) as Record<string, string[]>;
    const served = new Set([
      ...(contract.creds_oauth ?? [])
        .filter((route) => route.startsWith("GET /"))
        .map((route) => route.slice("GET /".length)),
      "cursor-auth-url",
    ]);

    for (const provider of ["codex", "antigravity", "claude", "cursor", "kimi", "xai"]) {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          calls.push(String(input));
          return new Response(JSON.stringify({ url: "https://example.com", state: "s" }));
        }),
      );
      const clients = createGatewayClients("http://127.0.0.1:18801", "api-key");
      await clients.management.beginProviderAuth(provider);
      const route = (calls[0] ?? "").split("/v0/management/")[1] ?? "";
      expect(served.has(route), `${provider} -> ${route}`).toBe(true);
    }
  });

  it("reads and writes typed scalar settings through their management routes", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        if (init?.method === "PUT") return new Response(JSON.stringify({ status: "ok" }));
        const url = String(input);
        if (url.endsWith("/proxy-url")) return new Response(JSON.stringify({ "proxy-url": "" }));
        if (url.endsWith("/routing/strategy")) {
          return new Response(JSON.stringify({ strategy: "round-robin" }));
        }
        if (url.endsWith("/request-retry")) {
          return new Response(JSON.stringify({ "request-retry": 3 }));
        }
        return new Response(JSON.stringify({ "logging-to-file": false }));
      }),
    );

    const clients = createGatewayClients("", "api-secret");
    await expect(clients.management.scalar("proxy-url")).resolves.toEqual({
      "proxy-url": "",
    });
    await clients.management.saveScalar("proxy-url", "http://127.0.0.1:7890");
    await clients.management.saveScalar("routing/strategy", "fill-first");
    await clients.management.saveScalar("request-retry", 5);
    await clients.management.saveScalar("logging-to-file", true);

    expect(calls.slice(1).map((call) => [call.url, call.init?.method, call.init?.body])).toEqual([
      ["/v0/management/proxy-url", "PUT", JSON.stringify({ value: "http://127.0.0.1:7890" })],
      ["/v0/management/routing/strategy", "PUT", JSON.stringify({ value: "fill-first" })],
      ["/v0/management/request-retry", "PUT", JSON.stringify({ value: 5 })],
      ["/v0/management/logging-to-file", "PUT", JSON.stringify({ value: true })],
    ]);
  });

  it("checks the exact provider authorization session state", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ status: "pending", provider: "codex" }));
      }),
    );
    const clients = createGatewayClients("", "api-secret");
    await expect(clients.management.providerAuthStatus("state with spaces")).resolves.toEqual({
      status: "pending",
      provider: "codex",
    });
    expect(calls).toEqual(["/v0/management/get-auth-status?state=state%20with%20spaces"]);
  });
});

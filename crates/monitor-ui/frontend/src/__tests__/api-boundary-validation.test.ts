import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { createGatewayClients } from "../lib/api";

afterEach(() => vi.unstubAllGlobals());

const management = () => createGatewayClients("http://127.0.0.1:18801", "mgmt-key").management;

describe("scheduler order acknowledgement", () => {
  it("returns the order the gateway acknowledged instead of the requested order", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ status: "ok", order: ["account-a", "account-b"] }));
      }),
    );

    const acknowledged = await management().saveSchedulerOrder(["account-b", "account-a"]);

    expect(acknowledged).toEqual(["account-a", "account-b"]);
    expect(bodies).toEqual([JSON.stringify({ order: ["account-b", "account-a"] })]);
  });
});

describe("scoped-key PATCH acknowledgement", () => {
  it("returns the parsed key with schema defaults applied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              key: {
                id: "key-1",
                name: "Partner",
                key_prefix: "mq-sh-key-1",
                key_identifier: "key-1",
                token_limit: 1_000,
                created_at_ms: 1_700_000_000_000,
              },
            }),
          ),
      ),
    );

    const key = await management().patchScopedKey("key-1", { token_limit: 1_000 });

    expect(key.allowed_providers).toEqual([]);
    expect(key.allowed_accounts).toEqual([]);
    expect(key.allowed_models).toEqual([]);
    expect(key.is_active).toBe(true);
    expect(key.token_limit).toBe(1_000);
  });

  it("rejects a malformed scoped-key PATCH acknowledgement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ key: { id: "", name: 42 } }))),
    );

    await expect(management().patchScopedKey("key-1", { name: "Partner" })).rejects.toBeInstanceOf(
      ZodError,
    );
  });
});

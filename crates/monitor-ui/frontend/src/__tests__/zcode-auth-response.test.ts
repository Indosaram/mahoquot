import { afterEach, expect, it, vi } from "vitest";
import { createGatewayClients } from "../lib/api";

afterEach(() => vi.unstubAllGlobals());

it("preserves a pending approval action instead of reporting completion", async () => {
  const result = { status: "pending", url: "https://chat.z.ai/api/oauth/authorize?state=current" };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(result)));
  const clients = createGatewayClients("http://127.0.0.1:18888", "fixture");
  expect(await clients.management.completeZcodeAuth("current", result.url)).toEqual(result);
});

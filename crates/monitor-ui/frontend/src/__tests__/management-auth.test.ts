import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayClients } from "../lib/api";

const internals = window as unknown as Record<string, unknown>;
const seen: RequestInit[] = [];

describe("management key resolution without the desktop bootstrap", () => {
  beforeEach(() => {
    seen.length = 0;
    localStorage.clear();
    localStorage.setItem("mahoquot.base", "http://10.0.2.2:18801");
    Reflect.deleteProperty(window, "__MAHOQUOT_MANAGEMENT__");
    internals.__TAURI_INTERNALS__ = {
      invoke: async (command: string) => (command === "read_secret" ? "stored-key" : null),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(JSON.stringify({ uptime_secs: 1, in_flight: 0, served: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    Reflect.deleteProperty(internals, "__TAURI_INTERNALS__");
    vi.unstubAllGlobals();
  });

  it("authorizes management calls from the stored endpoint", async () => {
    await createGatewayClients("http://10.0.2.2:18801", "").admin.stats();
    const auth = (seen[0]?.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBe("Bearer stored-key");
  });

  it("leaves foreign origins unauthenticated", async () => {
    await createGatewayClients("http://evil.test", "").admin.stats();
    const auth = (seen[0]?.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBeUndefined();
  });
});

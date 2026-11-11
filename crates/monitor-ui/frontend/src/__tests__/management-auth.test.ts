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

  it("authorizes the model catalog from the secret store", async () => {
    // `/v1/models` answers 401 without a key even though it is a management
    // surface. Because it sits outside the `/v0/management` prefix, the shell's
    // secret-store key used to be dropped here: the catalog came back empty on
    // mobile and every poll spent a failed-auth attempt against the gateway.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await createGatewayClients("http://10.0.2.2:18801", "").management.models();
    const auth = (seen[0]?.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBe("Bearer stored-key");
  });

  it("leaves foreign origins unauthenticated", async () => {
    await createGatewayClients("http://evil.test", "").admin.stats();
    const auth = (seen[0]?.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBeUndefined();
  });
});

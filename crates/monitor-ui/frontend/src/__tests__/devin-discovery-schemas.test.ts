import { describe, expect, it, vi } from "vitest";
import { createGatewayClients } from "../lib/api";
import {
  DevinAccountRefreshResultSchema,
  DevinAccountStatusSchema,
  DevinModelRefreshResponseSchema,
  DevinModelsStatusResponseSchema,
} from "../lib/schemas";

describe("Devin models status and refresh typed schemas", () => {
  it("validates DevinModelsStatusResponseSchema matching backend GET /v0/management/devin/models/status", () => {
    // Given: raw backend status payload with active, stale, and uninitialized accounts
    const raw = {
      status: "ok",
      models: ["devin/glm-5-2", "devin/swe-1-7"],
      accounts: [
        {
          identity_slug: "devin-work",
          status: "active",
          models: ["devin/glm-5-2"],
          stale: false,
          last_refresh_at: 1726000000,
          error: null,
          disabled: false,
        },
        {
          identity_slug: "devin-stale",
          status: "stale",
          models: ["devin/swe-1-7"],
          stale: true,
          last_refresh_at: 1725000000,
          error: "upstream timeout",
          disabled: false,
        },
        {
          identity_slug: "devin-empty",
          status: "uninitialized",
          models: [],
          stale: true,
          last_refresh_at: null,
          error: null,
          disabled: true,
        },
      ],
      generation: 42,
    };

    // When: parsed through schema
    const parsed = DevinModelsStatusResponseSchema.parse(raw);

    // Then: structure and account details are preserved
    expect(parsed.status).toBe("ok");
    expect(parsed.accounts).toHaveLength(3);
    expect(parsed.accounts[0]?.status).toBe("active");
    expect(parsed.accounts[1]?.stale).toBe(true);
    expect(parsed.accounts[1]?.error).toBe("upstream timeout");
    expect(parsed.accounts[2]?.status).toBe("uninitialized");
  });

  it("validates DevinAccountStatusSchema individually", () => {
    // Given: valid account status object
    const acc = {
      identity_slug: "devin-alpha",
      status: "active" as const,
      models: ["devin/swe-1-7"],
      stale: false,
    };

    // When: parsed
    const parsed = DevinAccountStatusSchema.parse(acc);

    // Then: defaults populated
    expect(parsed.identity_slug).toBe("devin-alpha");
    expect(parsed.status).toBe("active");
    expect(parsed.stale).toBe(false);
  });

  it("validates DevinModelRefreshResponseSchema with per-account results from POST /devin/models/refresh", () => {
    // Given: refresh response containing per-account refresh results
    const raw = {
      status: "ok",
      outcome: "success",
      models: ["devin/glm-5-2"],
      error: null,
      accounts: [
        {
          identity_slug: "devin-work",
          status: "success",
          models: ["devin/glm-5-2"],
          stale: false,
          last_refresh_at: 1726000000,
          error: null,
        },
      ],
      generation: 43,
    };

    // When: parsed through schema
    const parsed = DevinModelRefreshResponseSchema.parse(raw);

    // Then: per-account results are typed and preserved
    expect(parsed.outcome).toBe("success");
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]?.identity_slug).toBe("devin-work");
    expect(parsed.accounts[0]?.status).toBe("success");
  });

  it("validates DevinAccountRefreshResultSchema individually", () => {
    const res = DevinAccountRefreshResultSchema.parse({
      identity_slug: "devin-test",
      status: "error",
      models: [],
      stale: true,
      error: "network failure",
    });
    expect(res.status).toBe("error");
    expect(res.stale).toBe(true);
  });
});

describe("Devin API client GET status integration", () => {
  it("calls GET /v0/management/devin/models/status and parses typed response", async () => {
    // Given: mock fetch returning Devin models status
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        capturedUrl = String(input);
        return new Response(
          JSON.stringify({
            status: "ok",
            models: ["devin/glm-5-2"],
            accounts: [
              {
                identity_slug: "devin-work",
                status: "active",
                models: ["devin/glm-5-2"],
                stale: false,
                last_refresh_at: 1726000000,
                error: null,
                disabled: false,
              },
            ],
            generation: 10,
          }),
        );
      }),
    );

    // When: client calls getDevinModelsStatus()
    const clients = createGatewayClients("http://127.0.0.1:18801", "api-key");
    const result = await clients.management.getDevinModelsStatus();

    // Then: correct endpoint was hit and typed result returned
    expect(capturedUrl).toBe("http://127.0.0.1:18801/v0/management/devin/models/status");
    expect(result.status).toBe("ok");
    expect(result.accounts[0]?.identity_slug).toBe("devin-work");
  });
});

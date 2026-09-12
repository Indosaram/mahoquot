import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import {
  deriveAccountHealth,
  getQuotaCapability,
  mergeAccountsAndCredentials,
} from "../lib/accounts";
import { createGatewayClients } from "../lib/api";
import {
  DevinCliImportPayloadSchema,
  DevinCliImportResponseSchema,
  DevinModelRefreshResponseSchema,
  devinCredentialFileName,
  normalizeDevinManualCredential,
} from "../lib/schemas";

const baseStats = {
  uptime_secs: 3600,
  in_flight: 0,
  served: 10,
  failed_over: 0,
  refreshed: 1,
  ttft: { p50_ms: 80, p90_ms: 150, p99_ms: 300, samples: 10 },
  history: [],
  accounts: [],
};

const devinAccountStats = {
  id: "devin-work",
  provider: "devin",
  health: { status: "available" },
  ok: 12,
  fails: 0,
  input_tokens: 5000,
  output_tokens: 1200,
  total_tokens: 6200,
  usage: null, // quota is unknown
};

const devinAuthFile = {
  name: "devin-work.json",
  size: 256,
  auth_index: "0",
  path: "/home/user/.mahoquot/auth/devin-work.json",
  label: "Devin Work",
  disabled: false,
  unavailable: false,
  runtime_only: false,
  type: "devin",
};

describe("Devin credential schemas and normalization", () => {
  it("normalizes manual Devin credentials to the required wire shape", () => {
    const input = {
      identity_slug: "devin-work",
      label: "Devin Work",
      access_token: "devin-session-token$12345",
      api_server_url: "https://server.codeium.com",
      disabled: false,
    };
    const normalized = normalizeDevinManualCredential(input);
    expect(normalized).toEqual({
      type: "devin",
      identity_slug: "devin-work",
      label: "Devin Work",
      access_token: "devin-session-token$12345",
      api_server_url: "https://server.codeium.com",
      disabled: false,
    });
  });

  it("rejects invalid manual credentials at schema boundary", () => {
    // Empty identity slug
    expect(() =>
      normalizeDevinManualCredential({
        identity_slug: "",
        access_token: "valid-token",
      }),
    ).toThrow();

    // Empty token
    expect(() =>
      normalizeDevinManualCredential({
        identity_slug: "devin-work",
        access_token: "   ",
      }),
    ).toThrow();

    // Token with whitespace
    expect(() =>
      normalizeDevinManualCredential({
        identity_slug: "devin-work",
        access_token: "token with spaces",
      }),
    ).toThrow();

    // Token with control characters
    expect(() =>
      normalizeDevinManualCredential({
        identity_slug: "devin-work",
        access_token: "token\nwith\rnewlines",
      }),
    ).toThrow();

    // Token exceeding 4096 bytes
    expect(() =>
      normalizeDevinManualCredential({
        identity_slug: "devin-work",
        access_token: "a".repeat(4097),
      }),
    ).toThrow();
  });

  it("validates CLI import payload and response schemas", () => {
    const payload = DevinCliImportPayloadSchema.parse({
      identity: "devin-cli",
      label: "Devin CLI",
    });
    expect(payload.identity).toBe("devin-cli");

    const response = DevinCliImportResponseSchema.parse({
      status: "ok",
      name: "devin-cli.json",
    });
    expect(response.status).toBe("ok");
    expect(response.name).toBe("devin-cli.json");
  });

  it("validates Devin model discovery refresh response schema with explicit machine contract", () => {
    // Accepts valid success with models and null error
    const withNullError = DevinModelRefreshResponseSchema.parse({
      status: "ok",
      models: ["devin/glm-5-2", "devin/swe-1-7"],
      outcome: "success",
      error: null,
    });
    expect(withNullError.models).toEqual(["devin/glm-5-2", "devin/swe-1-7"]);
    expect(withNullError.error).toBeNull();

    // Accepts error outcome with string error
    const errorResponse = DevinModelRefreshResponseSchema.parse({
      outcome: "error",
      error: "Upstream discovery failed",
    });
    expect(errorResponse.outcome).toBe("error");
    expect(errorResponse.error).toBe("Upstream discovery failed");

    // Rejects empty {}
    expect(() => DevinModelRefreshResponseSchema.parse({})).toThrow();

    // Rejects empty success payload with only null error
    expect(() => DevinModelRefreshResponseSchema.parse({ error: null })).toThrow();

    // Rejects objects lacking any contract fields
    expect(() => DevinModelRefreshResponseSchema.parse({ unknown_field: 123 })).toThrow();
  });
});

describe("Devin account lifecycle and state normalization", () => {
  it("keeps Devin quota capability unsupported / unknown and never invents free or zero usage", () => {
    const cap = getQuotaCapability("devin", null);
    expect(cap).toBe("unsupported");

    const capWithZeroUsage = getQuotaCapability("devin", {
      primary: { used_percent: 0 },
      groups: [],
    });
    expect(capWithZeroUsage).toBe("unsupported");
  });

  it("normalizes Devin account label and identity without fabricating email", () => {
    const accounts = mergeAccountsAndCredentials([devinAccountStats], [devinAuthFile]);
    expect(accounts).toHaveLength(1);
    const account = accounts[0];
    expect(account?.provider).toBe("devin");
    expect(account?.label).toBe("Devin Work");
    expect(account?.email).toBe(""); // Devin has no email
    expect(account?.quotaCapability).toBe("unsupported");
  });

  it("surfaces auth_required distinctly when status indicates unauthenticated or token expired", () => {
    const health1 = deriveAccountHealth("unauthenticated", null, 0, 1);
    expect(health1).toBe("auth_required");

    const health2 = deriveAccountHealth("auth_required", null, 0, 1);
    expect(health2).toBe("auth_required");

    const health3 = deriveAccountHealth({ status: "unauthenticated" }, null, 0, 1);
    expect(health3).toBe("auth_required");
  });
});

describe("Devin API client integration", () => {
  it("sends only identity and label to POST /v0/management/devin/import-cli", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    let capturedMethod = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? "GET";
        if (init?.body) {
          capturedBody = JSON.parse(String(init.body));
        }
        return new Response(JSON.stringify({ status: "ok", name: "devin-cli.json" }));
      }),
    );

    const clients = createGatewayClients("http://127.0.0.1:18801", "api-key");
    const result = await clients.management.importDevinCli({
      identity: "devin-work",
      label: "Devin Work",
    });

    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toBe("http://127.0.0.1:18801/v0/management/devin/import-cli");
    expect(capturedBody).toEqual({
      identity: "devin-work",
      label: "Devin Work",
    });
    expect(result.status).toBe("ok");
  });

  it("calls POST /v0/management/devin/models/refresh for model discovery", async () => {
    let capturedUrl = "";
    let capturedMethod = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? "GET";
        return new Response(JSON.stringify({ status: "ok", models: ["devin/glm-5-2"] }));
      }),
    );

    const clients = createGatewayClients("http://127.0.0.1:18801", "api-key");
    const result = await clients.management.refreshDevinModels("devin-work");

    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain("/v0/management/devin/models/refresh?identity_slug=devin-work");
    expect(result.models).toEqual(["devin/glm-5-2"]);
  });
});

describe("Devin App console onboarding and lifecycle UI", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("navigates to Devin onboarding and shows manual token and CLI import options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(baseStats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    // Navigate to Accounts tab first
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));

    // Open onboarding drawer
    const addAccountBtn = await screen.findByRole("button", { name: /add account/i });
    fireEvent.click(addAccountBtn);

    // Click "Coding plan" to show subscription/CLI providers
    fireEvent.click(await screen.findByRole("button", { name: /coding plan/i }));

    // Look for Devin provider option in the methods/providers
    const devinTile = await screen.findByRole("button", { name: "Devin" });
    fireEvent.click(devinTile);

    // Both onboarding methods should be presented
    expect(await screen.findByRole("button", { name: /enter session token/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /import proxy-host cli login/i }),
    ).toBeInTheDocument();
  });

  it("submits manual token onboarding with masked input and normalized shape", async () => {
    let capturedUploadBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(baseStats));
        if (url.includes("auth-files")) {
          if (init?.method === "POST" && init?.body) {
            capturedUploadBody = JSON.parse(String(init.body));
            return new Response(JSON.stringify({ ok: true }));
          }
          return new Response(JSON.stringify({ files: [] }));
        }
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    fireEvent.click(await screen.findByRole("button", { name: /add account/i }));
    fireEvent.click(await screen.findByRole("button", { name: /coding plan/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Devin" }));
    fireEvent.click(await screen.findByRole("button", { name: /enter session token/i }));

    // Find inputs
    const identityInput = screen.getByLabelText(/identity/i);
    const labelInput = screen.getByLabelText(/label/i);
    const tokenInput = screen.getByLabelText(/session token/i);

    // Token must be masked (type="password")
    expect(tokenInput).toHaveAttribute("type", "password");

    // Enter details
    fireEvent.change(identityInput, { target: { value: "devin-team" } });
    fireEvent.change(labelInput, { target: { value: "Devin Team" } });
    fireEvent.change(tokenInput, { target: { value: "devin-secret-token$abc123" } });

    // Submit
    const saveBtn = screen.getByRole("button", { name: /save account/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Verify upload payload
    expect(capturedUploadBody).toEqual({
      name: "devin-devin-team.json",
      content: {
        type: "devin",
        identity_slug: "devin-team",
        label: "Devin Team",
        access_token: "devin-secret-token$abc123",
        api_server_url: "https://server.codeium.com",
        disabled: false,
      },
    });

    // Token must NOT be stored in localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || "";
      expect(localStorage.getItem(key)).not.toContain("devin-secret-token$abc123");
    }
  });

  it("submits proxy-host CLI import explaining host credentials and account-dependence", async () => {
    let capturedCliBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(baseStats));
        if (url.includes("/v0/management/devin/import-cli")) {
          capturedCliBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ status: "ok", name: "devin-cli.json" }));
        }
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    fireEvent.click(await screen.findByRole("button", { name: /add account/i }));
    fireEvent.click(await screen.findByRole("button", { name: /coding plan/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Devin" }));
    fireEvent.click(await screen.findByRole("button", { name: /import proxy-host cli login/i }));

    // Explanatory copy must be present
    expect(screen.getByText(/reads credentials\.toml from the proxy host/i)).toBeInTheDocument();
    expect(screen.getByText(/experimental/i)).toBeInTheDocument();

    const identityInput = screen.getByLabelText(/identity/i);
    fireEvent.change(identityInput, { target: { value: "devin-host-cli" } });

    const importBtn = screen.getByRole("button", { name: /import from proxy host/i });
    await act(async () => {
      fireEvent.click(importBtn);
    });

    expect(capturedCliBody).toEqual({
      identity: "devin-host-cli",
      label: "Devin CLI",
    });
  });

  it("displays Devin account in Accounts view with unknown quota and no email", async () => {
    const statsWithDevin = {
      ...baseStats,
      accounts: [devinAccountStats],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(statsWithDevin));
        if (url.includes("auth-files"))
          return new Response(JSON.stringify({ files: [devinAuthFile] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    // Go to Accounts view
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));

    // Account card should be visible
    expect(await screen.findByText("Devin Work")).toBeInTheDocument();

    // No email address should be rendered for Devin
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();

    // Quota should show "Not reported by provider"
    expect(screen.getByText("Not reported by provider")).toBeInTheDocument();
  });

  it("handles account lifecycle controls: disable, enable, and delete for Devin", async () => {
    let capturedDisabledCall: { name: string; disabled: boolean } | null = null;
    let capturedDeleteName: string | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) {
          return new Response(JSON.stringify({ ...baseStats, accounts: [devinAccountStats] }));
        }
        if (url.includes("/v0/management/auth-files/status")) {
          capturedDisabledCall = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ ok: true }));
        }
        if (url.includes("auth-files") && init?.method === "DELETE") {
          const match = url.match(/name=([^&]+)/);
          capturedDeleteName = match ? decodeURIComponent(match[1] || "") : null;
          return new Response(JSON.stringify({ ok: true }));
        }
        if (url.includes("auth-files"))
          return new Response(JSON.stringify({ files: [devinAuthFile] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(await screen.findByText("Devin Work")).toBeInTheDocument();

    // Open overflow menu for the card
    const moreBtn = screen.getByRole("button", { name: /more actions for devin work/i });
    fireEvent.click(moreBtn);

    // Disable account
    const disableItem = screen.getByRole("menuitem", { name: /disable.*devin work/i });
    await act(async () => {
      fireEvent.click(disableItem);
    });
    expect(capturedDisabledCall).toEqual({
      name: "devin-work.json",
      disabled: true,
    });

    // Re-open menu to remove account
    fireEvent.click(moreBtn);
    const removeItem = screen.getByRole("menuitem", { name: /remove.*devin work/i });
    fireEvent.click(removeItem);

    // Confirm remove button
    const confirmBtn = await screen.findByRole("button", { name: /confirm/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    expect(capturedDeleteName).toBe("devin-work.json");
  });

  it("generates injective filenames preserving exact identity slug without collapsing", () => {
    expect(devinCredentialFileName("work")).toBe("devin-work.json");
    expect(devinCredentialFileName("devin-work")).toBe("devin-devin-work.json");
    expect(devinCredentialFileName("work")).not.toBe(devinCredentialFileName("devin-work"));
    expect(devinCredentialFileName("devin-cli-work")).toBe("devin-devin-cli-work.json");
    expect(devinCredentialFileName("")).toBe("devin.json");
  });

  it("two-account coexistence and exact reimport/reauth: prevents collision, preserves distinct filenames and identities simultaneously", async () => {
    let capturedCliImportBody: { identity?: string; label?: string } | null = null;
    let capturedUploadBody: { name: string; content: unknown } | null = null;

    const workStats = {
      ...devinAccountStats,
      id: "work",
    };
    const devinWorkStats = {
      ...devinAccountStats,
      id: "devin-work",
    };

    const workAuth = {
      ...devinAuthFile,
      name: "devin-work.json",
      identity_slug: "work",
      label: "Work Account",
    };
    const devinWorkAuth = {
      ...devinAuthFile,
      name: "devin-devin-work.json",
      identity_slug: "devin-work",
      label: "Devin Work Account",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) {
          return new Response(
            JSON.stringify({ ...baseStats, accounts: [workStats, devinWorkStats] }),
          );
        }
        if (url.includes("/v0/management/devin/import-cli")) {
          capturedCliImportBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ status: "ok" }));
        }
        if (url.includes("auth-files") && init?.method === "POST") {
          capturedUploadBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ ok: true }));
        }
        if (url.includes("auth-files")) {
          return new Response(JSON.stringify({ files: [workAuth, devinWorkAuth] }));
        }
        if (url.includes("/logs")) {
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));

    // Both cards must be rendered simultaneously in the list
    expect(await screen.findByText("Work Account")).toBeInTheDocument();
    expect(await screen.findByText("Devin Work Account")).toBeInTheDocument();

    // --- 1. Re-import CLI on "work" ---
    const workMoreBtn = screen.getByRole("button", { name: /more actions for work account/i });
    fireEvent.click(workMoreBtn);
    const workReimportBtn = screen.getByRole("menuitem", { name: /re-import.*from host cli/i });
    await act(async () => {
      fireEvent.click(workReimportBtn);
    });
    expect(capturedCliImportBody).toEqual({
      identity: "work",
      label: "Work Account",
    });

    // --- 2. Re-import CLI on "devin-work" ---
    const devinWorkMoreBtn = screen.getByRole("button", {
      name: /more actions for devin work account/i,
    });
    fireEvent.click(devinWorkMoreBtn);
    const devinWorkReimportBtn = screen.getByRole("menuitem", {
      name: /re-import.*from host cli/i,
    });
    await act(async () => {
      fireEvent.click(devinWorkReimportBtn);
    });
    expect(capturedCliImportBody).toEqual({
      identity: "devin-work",
      label: "Devin Work Account",
    });

    // --- 3. Re-authenticate "work" -> targets devin-work.json ---
    fireEvent.click(workMoreBtn);
    const workReauthBtn = screen.getByRole("menuitem", {
      name: /re-authenticate.*work account/i,
    });
    await act(async () => {
      fireEvent.click(workReauthBtn);
    });

    const workIdentityInput = await screen.findByLabelText(/devin account identity/i);
    expect(workIdentityInput).toHaveValue("work");
    fireEvent.change(screen.getByLabelText(/session token/i), {
      target: { value: "token-for-work" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save account/i }));
    });
    const uploadWork = capturedUploadBody as {
      name: string;
      content: { identity_slug?: string };
    } | null;
    expect(uploadWork?.name).toBe("devin-work.json");
    expect(uploadWork?.content?.identity_slug).toBe("work");

    // --- 4. Re-authenticate "devin-work" -> targets devin-devin-work.json ---
    fireEvent.click(devinWorkMoreBtn);
    const devinWorkReauthBtn = screen.getByRole("menuitem", {
      name: /re-authenticate.*devin work account/i,
    });
    await act(async () => {
      fireEvent.click(devinWorkReauthBtn);
    });

    const devinWorkIdentityInput = await screen.findByLabelText(/devin account identity/i);
    expect(devinWorkIdentityInput).toHaveValue("devin-work");
    fireEvent.change(screen.getByLabelText(/session token/i), {
      target: { value: "token-for-devin-work" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save account/i }));
    });
    const uploadDevinWork = capturedUploadBody as {
      name: string;
      content: { identity_slug?: string };
    } | null;
    expect(uploadDevinWork?.name).toBe("devin-devin-work.json");
    expect(uploadDevinWork?.content?.identity_slug).toBe("devin-work");
  });

  it("preserves exact identity for devin-work through reimport and reauth", async () => {
    let capturedCliImportBody: { identity?: string; label?: string } | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) {
          return new Response(JSON.stringify({ ...baseStats, accounts: [devinAccountStats] }));
        }
        if (url.includes("/v0/management/devin/import-cli")) {
          capturedCliImportBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ status: "ok", name: "devin-work.json" }));
        }
        if (url.includes("auth-files"))
          return new Response(JSON.stringify({ files: [devinAuthFile] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(await screen.findByText("Devin Work")).toBeInTheDocument();

    // Open overflow menu
    const moreBtn = screen.getByRole("button", { name: /more actions for devin work/i });
    fireEvent.click(moreBtn);

    // Click "Re-import from host CLI" directly
    const reimportCliItem = screen.getByRole("menuitem", { name: /re-import.*from host cli/i });
    await act(async () => {
      fireEvent.click(reimportCliItem);
    });

    // Exact identity preservation: devin-work must NOT be normalized to work
    expect(capturedCliImportBody).toEqual({
      identity: "devin-work",
      label: "Devin Work",
    });

    // Now test Re-authenticate / Update token from menu
    fireEvent.click(moreBtn);
    const reauthItem = screen.getByRole("menuitem", { name: /re-authenticate.*devin work/i });
    await act(async () => {
      fireEvent.click(reauthItem);
    });

    // Onboarding drawer opens with devin-token form pre-filled with the same identity
    const identityInput = await screen.findByLabelText(/devin account identity/i);
    expect(identityInput).toHaveValue("devin-work");
  });

  it("preserves exact identity for work through reimport and reauth", async () => {
    let capturedCliImportBody: { identity?: string; label?: string } | null = null;
    const workAccountStats = {
      ...devinAccountStats,
      id: "work",
    };
    const workAuthFile = {
      ...devinAuthFile,
      name: "devin-work.json",
      label: "Work",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) {
          return new Response(JSON.stringify({ ...baseStats, accounts: [workAccountStats] }));
        }
        if (url.includes("/v0/management/devin/import-cli")) {
          capturedCliImportBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ status: "ok", name: "devin-work.json" }));
        }
        if (url.includes("auth-files"))
          return new Response(JSON.stringify({ files: [workAuthFile] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(await screen.findByText("Work")).toBeInTheDocument();

    const moreBtn = screen.getByRole("button", { name: /more actions for work/i });
    fireEvent.click(moreBtn);

    const reimportCliItem = screen.getByRole("menuitem", { name: /re-import.*from host cli/i });
    await act(async () => {
      fireEvent.click(reimportCliItem);
    });

    // Exact identity preservation: work must be preserved as work
    expect(capturedCliImportBody).toEqual({
      identity: "work",
      label: "Work",
    });

    fireEvent.click(moreBtn);
    const reauthItem = screen.getByRole("menuitem", { name: /re-authenticate.*work/i });
    await act(async () => {
      fireEvent.click(reauthItem);
    });

    const identityInput = await screen.findByLabelText(/devin account identity/i);
    expect(identityInput).toHaveValue("work");
  });

  it("surfaces gateway errors distinctly without exposing session tokens", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(baseStats));
        if (url.includes("auth-files") && init?.method === "POST") {
          return new Response(JSON.stringify({ error: "Upstream token rejected: invalid_auth" }), {
            status: 401,
          });
        }
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    fireEvent.click(await screen.findByRole("button", { name: /add account/i }));
    fireEvent.click(await screen.findByRole("button", { name: /coding plan/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Devin" }));
    fireEvent.click(await screen.findByRole("button", { name: /enter session token/i }));

    const secretToken = "devin-secret-token$do-not-leak";
    fireEvent.change(screen.getByLabelText(/identity/i), { target: { value: "devin-err" } });
    fireEvent.change(screen.getByLabelText(/session token/i), { target: { value: secretToken } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save account/i }));
    });

    // Error notice must be displayed
    expect(await screen.findByText(/Upstream token rejected: invalid_auth/i)).toBeInTheDocument();

    // Secret token must NOT appear in console logs or localStorage
    for (const call of [...consoleSpy.mock.calls, ...logSpy.mock.calls]) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(secretToken);
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || "";
      expect(localStorage.getItem(key)).not.toContain(secretToken);
    }

    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("two-account regression: prevents cross-account model presentation and isolates per-account discovery", async () => {
    const twoDevinStats = {
      ...baseStats,
      accounts: [
        {
          ...devinAccountStats,
          id: "devin-work",
        },
        {
          ...devinAccountStats,
          id: "devin-personal",
        },
      ],
    };
    const twoDevinFiles = [
      {
        ...devinAuthFile,
        name: "devin-work.json",
        label: "Devin Work",
      },
      {
        ...devinAuthFile,
        name: "devin-personal.json",
        label: "Devin Personal",
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) {
          return new Response(JSON.stringify(twoDevinStats));
        }
        if (url.includes("/v1/models")) {
          return new Response(
            JSON.stringify({
              data: [
                { id: "devin/glm-5-2", object: "model", created: 0, owned_by: "devin" },
                { id: "devin/swe-1-7", object: "model", created: 0, owned_by: "devin" },
              ],
            }),
          );
        }
        if (url.includes("auth-files")) {
          return new Response(JSON.stringify({ files: twoDevinFiles }));
        }
        if (url.includes("/logs")) {
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));

    // Both cards should be rendered
    expect(await screen.findByText("Devin Work")).toBeInTheDocument();
    expect(await screen.findByText("Devin Personal")).toBeInTheDocument();

    // Critical assertion: Neither account card claims the global union of models!
    // Both must show "Unknown" discovery state because per-account discovery is pending P4.
    const discoveryBadges = screen.getAllByTestId("devin-discovery");
    expect(discoveryBadges).toHaveLength(2);
    for (const badge of discoveryBadges) {
      expect(badge).toHaveTextContent("Unknown");
      expect(badge).not.toHaveTextContent("devin/glm-5-2");
      expect(badge).not.toHaveTextContent("devin/swe-1-7");
    }
  });
});

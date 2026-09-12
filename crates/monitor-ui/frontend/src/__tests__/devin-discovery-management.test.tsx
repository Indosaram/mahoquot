import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

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

const devinFailingStats = {
  id: "devin-failing",
  provider: "devin",
  health: { status: "available" },
  ok: 0,
  fails: 1,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  usage: null,
  models: undefined,
};

const devinFailingAuth = {
  name: "devin-failing.json",
  size: 256,
  auth_index: "0",
  path: "/home/user/.mahoquot/auth/devin-failing.json",
  label: "Devin Failing",
  disabled: false,
  unavailable: false,
  runtime_only: false,
  type: "devin",
  identity_slug: "devin-failing",
};

const devinStaleStats = {
  id: "devin-stale",
  provider: "devin",
  health: { status: "available" },
  ok: 5,
  fails: 0,
  input_tokens: 100,
  output_tokens: 50,
  total_tokens: 150,
  usage: null,
  models: ["devin/glm-5-2"],
};

const devinStaleAuth = {
  name: "devin-stale.json",
  size: 256,
  auth_index: "1",
  path: "/home/user/.mahoquot/auth/devin-stale.json",
  label: "Devin Stale",
  disabled: false,
  unavailable: false,
  runtime_only: false,
  type: "devin",
  identity_slug: "devin-stale",
};

describe("Devin discovery per-account truth feedback and lifecycle in App", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("reports per-account error truth on refresh even if top-level outcome claims success", async () => {
    // Given: Gateway returns top-level outcome "success" and global models, but devin-failing has error
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) {
          return new Response(JSON.stringify({ ...baseStats, accounts: [devinFailingStats] }));
        }
        if (url.includes("auth-files")) {
          return new Response(JSON.stringify({ files: [devinFailingAuth] }));
        }
        if (url.includes("/v0/management/devin/models/refresh")) {
          return new Response(
            JSON.stringify({
              status: "ok",
              outcome: "success",
              models: ["devin/other-account-model"],
              error: "Upstream connect timeout",
              accounts: [
                {
                  identity_slug: "devin-failing",
                  status: "error",
                  models: [],
                  stale: true,
                  last_refresh_at: null,
                  error: "Upstream connect timeout",
                },
              ],
              generation: 99,
            }),
          );
        }
        if (url.includes("/v0/management/devin/models/status")) {
          return new Response(JSON.stringify({ status: "ok", models: [], accounts: [] }));
        }
        if (url.includes("/logs")) {
          return new Response(JSON.stringify({ records: [] }));
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(await screen.findByText("Devin Failing")).toBeInTheDocument();

    // When: user clicks Refresh model discovery for devin-failing
    const moreBtn = screen.getByRole("button", { name: /more actions for devin failing/i });
    fireEvent.click(moreBtn);
    const refreshBtn = screen.getByRole("menuitem", { name: /refresh model discovery/i });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    // Then: notice reports per-account error truth, never falsely claiming success
    expect(
      await screen.findByText(
        /devin model discovery failed for devin failing: upstream connect timeout/i,
      ),
    ).toBeInTheDocument();
  });

  it("reports stale models preserved on discovery refresh when account is stale", async () => {
    // Given: Gateway returns stale=true for devin-stale
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) {
          return new Response(JSON.stringify({ ...baseStats, accounts: [devinStaleStats] }));
        }
        if (url.includes("auth-files")) {
          return new Response(JSON.stringify({ files: [devinStaleAuth] }));
        }
        if (url.includes("/v0/management/devin/models/refresh")) {
          return new Response(
            JSON.stringify({
              status: "ok",
              outcome: "success",
              models: ["devin/glm-5-2"],
              error: null,
              accounts: [
                {
                  identity_slug: "devin-stale",
                  status: "success",
                  models: ["devin/glm-5-2"],
                  stale: true,
                  last_refresh_at: 1726000000,
                  error: null,
                },
              ],
              generation: 100,
            }),
          );
        }
        if (url.includes("/v0/management/devin/models/status")) {
          return new Response(JSON.stringify({ status: "ok", models: [], accounts: [] }));
        }
        if (url.includes("/logs")) {
          return new Response(JSON.stringify({ records: [] }));
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(await screen.findByText("Devin Stale")).toBeInTheDocument();

    // When: user refreshes discovery
    const moreBtn = screen.getByRole("button", { name: /more actions for devin stale/i });
    fireEvent.click(moreBtn);
    const refreshBtn = screen.getByRole("menuitem", { name: /refresh model discovery/i });
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    // Then: notice reports stale models preserved with count
    expect(
      await screen.findByText(
        /devin models refreshed for devin stale \(stale models preserved\): 1 available/i,
      ),
    ).toBeInTheDocument();
  });

  it("handles Devin account disable and delete feedback with exact credential filename", async () => {
    // Given: Devin account in console
    let capturedDeletedFilename = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) {
          return new Response(JSON.stringify({ ...baseStats, accounts: [devinStaleStats] }));
        }
        if (url.includes("auth-files")) {
          if (init?.method === "PUT" && url.includes("/disabled")) {
            return new Response(JSON.stringify({ ok: true }));
          }
          if (init?.method === "DELETE") {
            const parsedName =
              new URL(url, "http://localhost").searchParams.get("name") ||
              url.split("/").pop() ||
              "";
            capturedDeletedFilename = decodeURIComponent(parsedName);
            return new Response(JSON.stringify({ ok: true }));
          }
          return new Response(JSON.stringify({ files: [devinStaleAuth] }));
        }
        if (url.includes("/v0/management/devin/models/status")) {
          return new Response(JSON.stringify({ status: "ok", models: [], accounts: [] }));
        }
        if (url.includes("/logs")) {
          return new Response(JSON.stringify({ records: [] }));
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(await screen.findByText("Devin Stale")).toBeInTheDocument();

    // When: user clicks Disable in menu
    const moreBtn = screen.getByRole("button", { name: /more actions for devin stale/i });
    fireEvent.click(moreBtn);
    const disableBtn = screen.getByRole("menuitem", { name: /disable.*devin stale/i });
    await act(async () => {
      fireEvent.click(disableBtn);
    });

    // Then: notice reports disabled
    expect(await screen.findByText(/devin stale disabled/i)).toBeInTheDocument();

    // When: user removes account
    fireEvent.click(moreBtn);
    const removeBtn = screen.getByRole("menuitem", { name: /remove.*devin stale/i });
    fireEvent.click(removeBtn);
    const confirmBtn = screen.getByRole("button", { name: /confirm removing.*devin stale/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Then: correct filename deleted and notice shows Devin account removed
    expect(capturedDeletedFilename).toBe("devin-stale.json");
    expect(
      await screen.findByText(/devin account devin stale removed from the runtime pool/i),
    ).toBeInTheDocument();
  });
});

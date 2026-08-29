import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const stats = {
  uptime_secs: 3600,
  in_flight: 2,
  served: 120,
  failed_over: 3,
  refreshed: 5,
  ttft: { p50_ms: 100, p90_ms: 220, p99_ms: 500, samples: 40 },
  accounts: [
    {
      id: "long-runtime-id@example.com",
      provider: "codex",
      health: { status: "available" },
      ok: 8,
      fails: 0,
      usage: {
        plan_type: "Pro",
        primary: {
          used_percent: 45,
          window_minutes: 300,
          reset_after_seconds: 3600,
          limit_name: "Session",
        },
        secondary: {
          used_percent: 20,
          window_minutes: 10080,
          reset_after_seconds: 172800,
          limit_name: "Weekly",
        },
      },
    },
  ],
};

describe("operations console", () => {
  beforeEach(() => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:18801");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(JSON.stringify({ lines: ["gateway ready"] }));
        if (url.includes("config.yaml")) {
          return new Response("port: 18801\n", {
            headers: { "Content-Type": "application/yaml" },
          });
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
  });

  it("loads management controls without a separate password", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs")) return new Response(JSON.stringify({ lines: [] }));
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    render(<App />);
    await screen.findByText("Gateway connected");
    expect(calls.some((url) => url.includes("/v0/management/"))).toBe(true);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    expect(screen.getByText("Provider onboarding")).toBeInTheDocument();
  });

  it("exposes exactly the approved primary surfaces and snapshot caveat", async () => {
    render(<App />);
    await screen.findByText(
      "Request history is persisted for 30 days and survives gateway and console restarts.",
    );
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(nav).toHaveTextContent("Overview");
    expect(nav).toHaveTextContent("Accounts");
    expect(nav).toHaveTextContent("Settings");
    expect(nav).not.toHaveTextContent("Credentials");
    expect(screen.getByRole("img", { name: "Request activity over time" })).toBeInTheDocument();
    expect(screen.getByText("Success rate")).toBeInTheDocument();
    expect(screen.getByText("Provider traffic")).toBeInTheDocument();
    expect(screen.getByText("Latency distribution")).toBeInTheDocument();
    expect(screen.getByText("Successful")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/8 calls · 100% success/)).toBeInTheDocument();
    expect(screen.queryByText("long-runtime-id@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("POOL HEALTH")).not.toBeInTheDocument();
  });

  it("renders compact notch surface when requested via query param", async () => {
    window.history.pushState({}, "", "/management.html?surface=notch");
    try {
      render(<App />);
      expect(await screen.findByTestId("notch-ring-codex")).toBeInTheDocument();
      expect(screen.getByTestId("notch-tooltip-codex")).toBeInTheDocument();
      expect(
        screen.queryByRole("navigation", { name: "Primary navigation" }),
      ).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("keeps account lifecycle out of Settings and separates auth copy", async () => {
    render(<App />);
    const settings = screen.getAllByText("Settings").at(0);
    if (!settings) throw new Error("Settings navigation missing");
    fireEvent.click(settings);
    expect(await screen.findByText("Connection & access")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    expect(screen.queryByText("Provider onboarding")).not.toBeInTheDocument();
    expect(screen.getByText("Connection & access")).toBeInTheDocument();
    expect(screen.getByText("Routing policy")).toBeInTheDocument();
    expect(screen.queryByLabelText("Management password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeInTheDocument();
    expect(screen.getByText("Runtime & logging")).toBeInTheDocument();
    expect(screen.getByText("Advanced YAML")).toBeInTheDocument();
    expect(screen.queryAllByText("Edit settings")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Open YAML editor" }));
    expect(
      await screen.findByRole("complementary", { name: "Advanced configuration editor" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/may contain API keys/)).toBeInTheDocument();
  });

  it("copies the masked API key without revealing it", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    localStorage.setItem("mahoquot.key", "secret-api-key");
    render(<App />);
    fireEvent.click(screen.getAllByText("Settings").at(0) as HTMLElement);
    const input = screen.getByLabelText("API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("secret-api-key");
    fireEvent.click(screen.getByRole("button", { name: "Copy API key" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("secret-api-key"));
    expect(screen.getByText("API key copied.")).toBeInTheDocument();
  });

  it("keeps credential onboarding and lifecycle inside Accounts", async () => {
    render(<App />);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    fireEvent.click(await screen.findByText("Start onboarding"));
    expect(screen.getByRole("complementary", { name: "Provider onboarding" })).toBeInTheDocument();
    expect(screen.getByText("Add or re-authenticate")).toBeInTheDocument();
    expect(screen.getByText(/will not claim success/)).toBeInTheDocument();
    expect(screen.getAllByText(/require a gateway restart/).length).toBeGreaterThan(0);
  });

  it("renders bundled official logos for every onboarding provider", async () => {
    render(<App />);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    fireEvent.click(await screen.findByText("Start onboarding"));

    for (const provider of ["codex", "antigravity", "claude", "kiro", "cursor"]) {
      expect(screen.getAllByTestId(`provider-logo-${provider}`).length).toBeGreaterThan(0);
    }
  });

  it("formats tiny quota percentages without floating point noise", async () => {
    const tinyStats = {
      ...stats,
      accounts: [
        {
          ...stats.accounts[0],
          usage: { primary: { used_percent: 0.0016330000000008837 } },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(tinyStats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs")) return new Response(JSON.stringify({ lines: [] }));
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    render(<App />);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    expect(await screen.findByText("100%")).toBeInTheDocument();
  });

  it("renders reference-style provider tabs and detailed usage cards", async () => {
    render(<App />);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    expect(await screen.findByRole("radio", { name: "codex 1 account" })).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("USAGE")).toBeInTheDocument();
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("1h 0m")).toBeInTheDocument();
    expect(screen.getByText("2d 0h")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Warm up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh quota" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Search accounts")).not.toBeInTheDocument();
  });

  it("switches the visible account group when a provider tab is clicked", async () => {
    const multiProvider = {
      ...stats,
      accounts: [
        stats.accounts[0],
        {
          ...stats.accounts[0],
          id: "gravity@example.com",
          provider: "antigravity",
          usage: {
            groups: [
              {
                display_name: "Gemini quota",
                buckets: [{ used_percent: 20 }],
              },
            ],
          },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(multiProvider));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs")) return new Response(JSON.stringify({ lines: [] }));
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    render(<App />);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    const codex = await screen.findByRole("radio", { name: "codex 1 account" });
    fireEvent.click(codex);
    expect(await screen.findByText("runtime-id@example.com")).toBeInTheDocument();
    expect(screen.queryByText("gravity@example.com")).not.toBeInTheDocument();
  });

  it("imports the local Claude subscription through the real management action", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs")) return new Response(JSON.stringify({ lines: [] }));
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );
    render(<App />);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    fireEvent.click(await screen.findByRole("button", { name: /Start onboarding/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Import Claude Code subscription/i }),
    );
    await waitFor(() =>
      expect(calls.some((url) => url.endsWith("/v0/management/claude/import-local"))).toBe(true),
    );
    expect(await screen.findByText(/Claude Code subscription imported/i)).toBeInTheDocument();
  });

  it("tracks provider authorization until the gateway reports completion", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs")) return new Response(JSON.stringify({ lines: [] }));
        if (url.includes("codex-auth-url")) {
          return new Response(
            JSON.stringify({ status: "ok", url: "https://example.com/auth", state: "auth-42" }),
          );
        }
        if (url.includes("get-auth-status")) {
          return new Response(JSON.stringify({ status: "ok", provider: "codex" }));
        }
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );
    vi.spyOn(window, "open").mockReturnValue(null);

    render(<App />);
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: /Start onboarding/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Codex \/ OpenAI/i }));
    expect(await screen.findByText(/Authorization pending/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Check authorization status/i }));

    expect(await screen.findByText(/Codex authorization completed/i)).toBeInTheDocument();
    expect(calls.some((url) => url.endsWith("get-auth-status?state=auth-42"))).toBe(true);
  });

  it("edits proxy routing retry and logging without raw YAML", async () => {
    const writes: Array<{ readonly url: string; readonly body: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs")) return new Response(JSON.stringify({ lines: [] }));
        if (init?.method === "PUT") {
          writes.push({ url, body: typeof init.body === "string" ? init.body : null });
          return new Response(JSON.stringify({ status: "ok" }));
        }
        if (url.endsWith("/proxy-url")) {
          return new Response(JSON.stringify({ "proxy-url": "" }));
        }
        if (url.endsWith("/routing/strategy")) {
          return new Response(JSON.stringify({ strategy: "round-robin" }));
        }
        if (url.endsWith("/request-retry")) {
          return new Response(JSON.stringify({ "request-retry": 3 }));
        }
        if (url.endsWith("/logging-to-file")) {
          return new Response(JSON.stringify({ "logging-to-file": false }));
        }
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );

    render(<App />);
    fireEvent.click(screen.getAllByText("Settings").at(0) as HTMLElement);
    fireEvent.change(await screen.findByLabelText("Upstream proxy URL"), {
      target: { value: "http://127.0.0.1:7890" },
    });
    fireEvent.change(screen.getByLabelText("Routing strategy"), {
      target: { value: "fill-first" },
    });
    fireEvent.change(screen.getByLabelText("Request retry count"), { target: { value: "5" } });
    fireEvent.click(screen.getByLabelText("Write logs to file"));
    fireEvent.click(screen.getByRole("button", { name: "Save proxy settings" }));

    await waitFor(() => expect(writes).toHaveLength(4));
    expect(screen.getByText(/Proxy settings saved/i)).toBeInTheDocument();
  });

  it("keeps navigation and reconnect controls alive when the gateway is offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("connection refused"))),
    );
    render(<App />);
    expect(await screen.findByText(/Gateway offline/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Settings").at(0) as HTMLElement);
    expect(screen.getByLabelText("Gateway URL")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save & reconnect" })).toBeEnabled();
  });

  it("does not replace a focused settings field during polling", async () => {
    vi.useFakeTimers();
    render(<App />);
    const settings = screen.getAllByText("Settings").at(0);
    if (!settings) throw new Error("Settings navigation missing");
    fireEvent.click(settings);
    const input = screen.getByLabelText("Gateway URL");
    fireEvent.change(input, { target: { value: "http://localhost:19999" } });
    input.focus();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(input).toHaveFocus();
    expect(input).toHaveValue("http://localhost:19999");
    vi.useRealTimers();
  });

  it("opens raw logs without presenting fabricated request history", async () => {
    render(<App />);
    fireEvent.click(await screen.findByText("Open logs"));
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Gateway logs" })).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Raw server output, not a reconstructed request history."),
    ).toBeInTheDocument();
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const stats = {
  uptime_secs: 3600,
  in_flight: 2,
  served: 120,
  failed_over: 3,
  refreshed: 5,
  ttft: { p50_ms: 100, p90_ms: 220, p99_ms: 500, samples: 40 },
  history: [
    {
      minute_unix: Math.floor((Date.now() - 5 * 60_000) / 60_000) * 60,
      requests: 8,
      successes: 8,
      failures: 0,
      accounts: [
        {
          account: "long-runtime-id@example.com",
          requests: 8,
          successes: 8,
          failures: 0,
        },
      ],
    },
  ],
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
    localStorage.removeItem("mahoquot.theme");
    sessionStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
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
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    render(<App />);
    (await screen.findAllByText("Requests"))[0];
    expect(calls.some((url) => url.includes("/v0/management/"))).toBe(true);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    expect(screen.getByRole("button", { name: "Add account" })).toBeInTheDocument();
  });

  it("exposes exactly the approved primary surfaces and snapshot caveat", async () => {
    render(<App />);
    (await screen.findAllByText("Requests"))[0];
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(nav).toHaveTextContent("Overview");
    expect(nav).toHaveTextContent("Accounts");
    expect(nav).toHaveTextContent("Logs");
    expect(nav).toHaveTextContent("Settings");
    expect(nav).not.toHaveTextContent("Credentials");
    expect(screen.getByText("Request activity")).toBeInTheDocument();
    expect(screen.getAllByText("Requests")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Success")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Failed")[0]).toBeInTheDocument();
    expect(screen.getByText("In flight")).toBeInTheDocument();
    expect(screen.getByText("p50")).toBeInTheDocument();
    expect(screen.getByText("p90")).toBeInTheDocument();
    expect(screen.getByText("Provider mix")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Telemetry range" })).toBeInTheDocument();
    for (const range of ["30m", "1h", "1d", "7d", "30d"]) {
      expect(screen.getByRole("radio", { name: range })).toBeInTheDocument();
    }
    expect(screen.queryByText("Latency distribution")).not.toBeInTheDocument();
    expect(screen.queryByText("Current interval")).not.toBeInTheDocument();
    expect(screen.queryByText("30-day retention")).not.toBeInTheDocument();
    expect(screen.queryByText("Open logs")).not.toBeInTheDocument();
    expect(screen.queryByText(/Live/i)).not.toBeInTheDocument();
    expect(screen.queryByText("POOL HEALTH")).not.toBeInTheDocument();
  });

  it("keeps refresh in Accounts and theme selection in Settings", async () => {
    render(<App />);
    (await screen.findAllByText("Requests"))[0];

    expect(screen.queryByRole("button", { name: "Refresh snapshot" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Theme")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Toggle theme" })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    expect(screen.getByRole("button", { name: "Refresh snapshot" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Theme")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Toggle theme" })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByText("Logs").at(0) as HTMLElement);
    expect(screen.queryByRole("button", { name: "Refresh snapshot" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Theme")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByText("Settings").at(0) as HTMLElement);
    expect(screen.queryByRole("button", { name: "Refresh snapshot" })).not.toBeInTheDocument();
    const theme = await screen.findByLabelText("Theme");
    expect(theme).toHaveValue("dark");

    fireEvent.change(theme, { target: { value: "light" } });
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "light"));
    expect(localStorage.getItem("mahoquot.theme")).toBe("light");
  });

  it("detects provider approval without a manual status click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        if (url.includes("codex-auth-url")) {
          return new Response(
            JSON.stringify({ url: "https://example.com/auth", state: "auth-77" }),
          );
        }
        if (url.includes("get-auth-status")) {
          statusCalls += 1;
          return new Response(
            JSON.stringify(
              statusCalls > 1 ? { status: "ok", provider: "codex" } : { status: "pending" },
            ),
          );
        }
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );
    vi.spyOn(window, "open").mockReturnValue(null);

    render(<App />);
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in with OpenAI" }));
    expect(await screen.findByText(/Waiting for provider approval/i)).toBeInTheDocument();

    // No click on "Check authorization status" — the session polls itself.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6500);
    });
    expect(await screen.findByText(/Codex authorization completed/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("reorders accounts by dragging one card onto another", async () => {
    const orderStats = {
      ...stats,
      accounts: [
        {
          id: "a@example.com",
          provider: "codex",
          health: { status: "available" },
          ok: 1,
          fails: 0,
        },
        {
          id: "b@example.com",
          provider: "codex",
          health: { status: "available" },
          ok: 1,
          fails: 0,
        },
      ],
    };
    const credential = (name: string, email: string) => ({
      name,
      size: 1,
      auth_index: name,
      path: `/auth/${name}`,
      label: email,
      disabled: false,
      unavailable: false,
      runtime_only: false,
      type: "codex",
      email,
    });
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PUT" && url.includes("auth-files/order")) {
          bodies.push(String(init.body ?? ""));
          return new Response(JSON.stringify({ status: "ok" }));
        }
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(orderStats));
        if (url.includes("auth-files")) {
          return new Response(
            JSON.stringify({
              files: [
                credential("codex-a.json", "a@example.com"),
                credential("codex-b.json", "b@example.com"),
              ],
            }),
          );
        }
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    render(<App />);
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    await screen.findByLabelText("Reorder a@example.com");

    const cards = document.querySelectorAll(".account-card");
    const first = cards[0] as HTMLElement;
    const second = cards[1] as HTMLElement;
    const dataTransfer = { effectAllowed: "", setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(second, { dataTransfer });
    fireEvent.drop(second, { dataTransfer });

    await waitFor(() => expect(bodies.length).toBe(1));
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({
      names: ["codex-b.json", "codex-a.json"],
    });
  });

  it("adds a Z.ai account by writing a provisioned key credential", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") calls.push({ url, body: String(init.body ?? "") });
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );

    render(<App />);
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Z.ai" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste a provisioned API key" }));

    fireEvent.change(screen.getByLabelText("Z.ai account email"), {
      target: { value: "me@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Z.ai provisioned API key"), {
      target: { value: "keyid.keysecret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/v0/management/auth-files"))).toBe(true),
    );
    const written = calls.find((call) => call.url.endsWith("/v0/management/auth-files"));
    expect(JSON.parse(written?.body ?? "{}")).toEqual({
      name: "zcode-me@example.com.json",
      content: { type: "zcode", access_token: "keyid.keysecret", email: "me@example.com" },
    });
  });

  it("shows Claude subscription usage windows", async () => {
    const claudeStats = {
      ...stats,
      accounts: [
        {
          id: "claude-code",
          provider: "claude",
          health: { status: "available" },
          ok: 3,
          fails: 0,
          usage: {
            active_limit: "five_hour",
            primary: {
              used_percent: 3,
              window_minutes: 300,
              limit_name: "Session",
              reset_after_seconds: 3600,
            },
            secondary: {
              used_percent: 12,
              window_minutes: 10080,
              limit_name: "Weekly",
              reset_after_seconds: 172800,
            },
          },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(claudeStats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    render(<App />);
    (await screen.findAllByText("Requests"))[0];
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);

    expect(await screen.findByText("Session")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("97%")).toBeInTheDocument();
    expect(screen.getByText("88%")).toBeInTheDocument();
    expect(screen.queryByText("Not reported by provider")).not.toBeInTheDocument();
  });

  it("names the model pool each quota window meters", async () => {
    const groupedStats = {
      ...stats,
      accounts: [
        {
          id: "pooled@example.com",
          provider: "antigravity",
          health: { status: "available" },
          ok: 4,
          fails: 0,
          usage: {
            groups: [
              {
                display_name: "Gemini Models",
                buckets: [
                  { display_name: "Weekly Limit Remaining", used_percent: 0 },
                  { display_name: "Five Hour Limit Remaining", used_percent: 0 },
                ],
              },
              {
                display_name: "Claude and GPT Models",
                buckets: [{ display_name: "Weekly Limit Remaining", used_percent: 0 }],
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
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(groupedStats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    render(<App />);
    (await screen.findAllByText("Requests"))[0];
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);

    // Two pools each report a weekly window, so the window name alone cannot say
    // which limit it belongs to.
    expect(await screen.findByText("Gemini Models")).toBeInTheDocument();
    expect(screen.getByText("Claude and GPT Models")).toBeInTheDocument();
    expect(screen.getAllByText("Weekly")).toHaveLength(2);
    expect(screen.getByText("Five Hour")).toBeInTheDocument();
    expect(screen.queryByText(/Limit Remaining/)).not.toBeInTheDocument();
  });

  it("keeps account management when the gateway refuses the log endpoint", async () => {
    const managedStats = {
      ...stats,
      accounts: [
        {
          id: "pooled@example.com",
          provider: "codex",
          health: { status: "available" },
          ok: 2,
          fails: 0,
        },
      ],
    };
    const files = {
      files: [
        {
          name: "codex-pooled.json",
          size: 200,
          auth_index: "codex-pooled",
          path: "/auth/codex-pooled.json",
          label: "pooled",
          disabled: false,
          unavailable: false,
          runtime_only: false,
          type: "codex",
          email: "pooled@example.com",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(managedStats));
        if (url.includes("auth-files")) return new Response(JSON.stringify(files));
        // The gateway rejects this outright while file logging is disabled.
        if (url.includes("/logs")) {
          return new Response(JSON.stringify({ error: "logging to file disabled" }), {
            status: 400,
          });
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    render(<App />);
    (await screen.findAllByText("Requests"))[0];
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);

    // A refused log read must not strip the credential inventory.
    expect(await screen.findByRole("button", { name: "Remove pooled" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-authenticate pooled" })).toBeInTheDocument();
  });

  it("manages a subscription account with re-auth and confirmed removal", async () => {
    const requests: { url: string; method: string }[] = [];
    const claudeStats = {
      ...stats,
      accounts: [
        { id: "claude-code", provider: "claude", health: { status: "available" }, ok: 3, fails: 0 },
      ],
    };
    const files = {
      files: [
        {
          name: "claude-local.json",
          size: 180,
          auth_index: "claude-local",
          path: "/auth/claude-local.json",
          label: "claude-local",
          disabled: false,
          unavailable: false,
          runtime_only: false,
          type: "claude",
          email: "owner@example.com",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET" });
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(claudeStats));
        if (url.includes("auth-files")) return new Response(JSON.stringify(files));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    render(<App />);
    (await screen.findAllByText("Requests"))[0];
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);

    // The imported subscription is one manageable account, not a runtime card plus a
    // phantom "not loaded" credential card.
    expect(await screen.findByLabelText("claude 1 account")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Re-authenticate claude-local" }),
    ).toBeInTheDocument();

    // Removal takes two deliberate clicks so one stray click cannot destroy a credential.
    fireEvent.click(screen.getByRole("button", { name: "Remove claude-local" }));
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm removing claude-local" }));
    await waitFor(() =>
      expect(
        requests.some(
          (request) => request.method === "DELETE" && request.url.includes("claude-local.json"),
        ),
      ).toBe(true),
    );
  });

  it("re-authenticates an API-key account through its provider form instead of OAuth", async () => {
    const genericStats = {
      ...stats,
      accounts: [
        {
          id: "deepseek-main",
          provider: "deepseek",
          health: { status: "available" },
          ok: 3,
          fails: 0,
        },
      ],
    };
    const files = {
      files: [
        {
          name: "generic-deepseek-main.json",
          size: 180,
          auth_index: "generic-deepseek-main",
          path: "/auth/generic-deepseek-main.json",
          label: "deepseek-main",
          disabled: false,
          unavailable: false,
          runtime_only: false,
          type: "generic",
          provider: "deepseek",
        },
      ],
    };
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(genericStats));
        if (url.includes("auth-files")) return new Response(JSON.stringify(files));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    render(<App />);
    await waitFor(() => expect(requests.some((url) => url.includes("auth-files"))).toBe(true));
    (await screen.findAllByText("Requests"))[0];
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(await screen.findByLabelText("deepseek 1 account"));
    expect(await screen.findByText("deepseek-main")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Re-authenticate deepseek-main" }));

    expect(await screen.findByText("DeepSeek")).toBeInTheDocument();
    expect(screen.getByLabelText("Provider API key")).toBeInTheDocument();
    expect(requests.some((url) => url.includes("deepseek-auth-url"))).toBe(false);
  });

  it("updates Overview totals when the telemetry range changes", async () => {
    const now = Date.now();
    const historyStats = {
      ...stats,
      history: [
        {
          minute_unix: Math.floor((now - 2 * 60 * 60_000) / 60_000) * 60,
          requests: 90,
          successes: 88,
          failures: 2,
          providers: [{ provider: "codex", requests: 90, successes: 88, failures: 2 }],
        },
        {
          minute_unix: Math.floor((now - 10 * 60_000) / 60_000) * 60,
          requests: 3,
          successes: 3,
          failures: 0,
          providers: [{ provider: "claude", requests: 3, successes: 3, failures: 0 }],
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(historyStats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    render(<App />);
    expect(await screen.findByText("93")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "30m" }));
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.queryByText("93")).not.toBeInTheDocument();
  });

  it("restores the selected telemetry range after remount", async () => {
    const first = render(<App />);
    (await screen.findAllByText("Requests"))[0];
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));
    expect(localStorage.getItem("mahoquot.telemetry-range")).toBe("7d");
    first.unmount();

    render(<App />);
    expect(await screen.findByRole("radio", { name: "7d" })).toBeChecked();
  });

  it("renders compact notch surface when requested via query param", async () => {
    window.history.pushState({}, "", "/management.html?surface=notch");
    try {
      render(<App />);
      const triggerStrip = await screen.findByTestId("notch-trigger-strip");
      expect(triggerStrip).not.toHaveAttribute("aria-label");
      expect(screen.queryByText("Quotio")).not.toBeInTheDocument();
      expect(screen.getByTestId("notch-ring-codex")).toBeInTheDocument();
      expect(document.querySelector(".notch-surface")).not.toHaveClass("expanded");
      expect(
        screen.queryByRole("navigation", { name: "Primary navigation" }),
      ).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("opens the notch immediately from a native hover event without an animation frame", async () => {
    window.history.pushState({}, "", "/management.html?surface=notch");
    let hover: ((payload: boolean) => void) | undefined;
    const invoke = vi.fn();
    Object.assign(window, {
      __TAURI__: {
        core: { invoke },
        event: {
          listen: vi.fn(async (event: string, handler: (message: { payload: unknown }) => void) => {
            if (event === "notch-hover") {
              hover = (payload) => handler({ payload });
            }
            return () => undefined;
          }),
        },
      },
    });
    const animationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    try {
      const { container } = render(<App />);
      await waitFor(() => expect(hover).toBeTypeOf("function"));
      act(() => hover?.(true));

      expect(container.querySelector(".notch-shell")).toHaveClass("expanded", "open");
      expect(container.querySelector(".notch-surface")).toHaveClass("expanded");
      expect(invoke).not.toHaveBeenCalledWith("expand_notch");
    } finally {
      animationFrame.mockRestore();
      Reflect.deleteProperty(window, "__TAURI__");
      window.history.pushState({}, "", "/");
    }
  });

  it("opens the notch from the synchronous native DOM bridge", async () => {
    window.history.pushState({}, "", "/management.html?surface=notch");
    try {
      const { container } = render(<App />);
      await act(async () => {
        await Promise.resolve();
        window.dispatchEvent(new CustomEvent("mahoquot:notch-hover", { detail: true }));
      });

      expect(container.querySelector(".notch-shell")).toHaveClass("expanded", "open");
      expect(container.querySelector(".notch-surface")).toHaveClass("expanded");
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("automatically opens provider detail from forwarded native cursor coordinates", async () => {
    window.history.pushState({}, "", "/management.html?surface=notch");
    try {
      render(<App />);
      await screen.findByTestId("notch-ring-codex");
      const ring = screen.getByTestId("notch-ring-codex");
      vi.spyOn(ring, "getBoundingClientRect").mockReturnValue({
        x: 350,
        y: 210,
        left: 350,
        top: 210,
        right: 393,
        bottom: 253,
        width: 43,
        height: 43,
        toJSON: () => ({}),
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("mahoquot:notch-hover", { detail: true }));
        window.dispatchEvent(
          new CustomEvent("mahoquot:notch-cursor", { detail: { x: 370, y: 230 } }),
        );
      });

      expect(await screen.findByTestId("notch-tooltip-codex")).toBeVisible();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("keeps official provider colors and every account quota row in notch detail", async () => {
    window.history.pushState({}, "", "/management.html?surface=notch");
    const firstAccount = stats.accounts[0];
    if (!firstAccount) throw new Error("fixture account missing");
    const manyAccounts = {
      ...stats,
      accounts: [
        ...stats.accounts,
        {
          ...firstAccount,
          id: "second@example.com",
          usage: {
            ...firstAccount.usage,
            groups: [
              {
                display_name: "Limits",
                models: "codex",
                buckets: [
                  { display_name: "Daily", used_percent: 10, reset_after_seconds: 100 },
                  { display_name: "Monthly", used_percent: 20, reset_after_seconds: 200 },
                  { display_name: "Credits", used_percent: 30, reset_after_seconds: 300 },
                ],
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
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(manyAccounts));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    try {
      render(<App />);
      fireEvent.click(await screen.findByTestId("notch-ring-codex"));
      const tooltip = screen.getByTestId("notch-tooltip-codex");
      expect(within(tooltip).getAllByTestId(/notch-tooltip-account-/)).toHaveLength(2);
      expect(within(tooltip).getByText("runtime-id@example.com")).toBeInTheDocument();
      expect(within(tooltip).getByText("second@example.com")).toBeInTheDocument();
      expect(within(tooltip).getByText("Credits")).toBeInTheDocument();
      expect(
        screen.getByTestId("notch-ring-codex").querySelector(".notch-ring-logo .provider-logo"),
      ).toHaveClass("notch-provider-logo-color");

      // Verify that hidden tooltips are not queried as hover targets
      const queryableTargets = document.querySelectorAll(
        ".notch-ring-item[data-hover-provider], .react-visible .notch-tooltip[data-hover-provider], .notch-empty-ring[data-hover-provider]",
      );
      // Tooltip target should ONLY be codex (the active one), not antigravity or others
      const tooltipProviders = [...queryableTargets]
        .filter((el) => el.classList.contains("notch-tooltip"))
        .map((el) => (el as HTMLElement).dataset.hoverProvider);
      expect(tooltipProviders).toEqual(["codex"]);
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
    expect(screen.getByText("Proxy behavior")).toBeInTheDocument();
    expect(screen.queryByLabelText("Management password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeInTheDocument();
    expect(screen.getByText("Advanced YAML")).toBeInTheDocument();
    expect(screen.queryByText("Routing policy")).not.toBeInTheDocument();
    expect(screen.queryByText("Runtime & logging")).not.toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    expect(
      await screen.findByRole("complementary", { name: "Provider onboarding" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Add Account")).toBeInTheDocument();
    // The gateway rescans its pool on every credential write, so the console
    // must not tell anyone to restart it.
    expect(screen.queryByText(/restart/i)).not.toBeInTheDocument();
  });

  it("dismisses both account and YAML drawers with Escape", async () => {
    render(<App />);

    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    expect(
      await screen.findByRole("complementary", { name: "Provider onboarding" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("complementary", { name: "Provider onboarding" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByText("Settings").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Open YAML editor" }));
    expect(
      await screen.findByRole("complementary", { name: "Advanced configuration editor" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("complementary", { name: "Advanced configuration editor" }),
    ).not.toBeInTheDocument();
  });

  it("opens a provider detail before starting another account authorization", async () => {
    const authCalls: string[] = [];
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("codex-auth-url")) authCalls.push(url);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        if (url.includes("codex-auth-url")) {
          return new Response(JSON.stringify({ url: "https://example.com/auth", state: "s" }));
        }
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );

    render(<App />);
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));

    expect(authCalls).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Add Codex account" })).toBeInTheDocument();
    const drawer = screen.getByRole("complementary", { name: "Provider onboarding" });
    expect(within(drawer).queryByText("runtime-id@example.com")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with OpenAI" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with OpenAI" }));
    await waitFor(() => expect(authCalls).toHaveLength(1));
  });

  it("does not duplicate dedicated canonical providers in generic key onboarding", async () => {
    render(<App />);
    (await screen.findAllByText("Requests"))[0];
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(
      screen.queryByRole("button", { name: /OpenAI \(Codex login\)/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Google Vertex AI/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Z\.AI — GLM Coding Plan/ }),
    ).not.toBeInTheDocument();
  });

  it("allows a reference key-optional provider to save without an API key", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files") && init?.method === "POST") {
          requests.push({ url, body: String(init.body ?? "") });
          return new Response(JSON.stringify({ status: "ok" }));
        }
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ ok: true }));
      }),
    );

    render(<App />);
    (await screen.findAllByText("Requests"))[0];
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.change(await screen.findByLabelText("Search providers"), {
      target: { value: "OpenCode Free" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /OpenCode Free/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add API key" }));

    const save = screen.getByRole("button", { name: "Save account" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(requests[0]?.body ?? "{}").content.api_key).toBe("");
  });

  it("renders bundled official logos for every onboarding provider", async () => {
    render(<App />);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));

    for (const provider of ["codex", "antigravity", "claude", "cursor"]) {
      await screen.findByRole("complementary", { name: "Provider onboarding" });
      expect(screen.getAllByTestId(`provider-logo-${provider}`).length).toBeGreaterThan(0);
    }
  });

  it("offers Kiro and account enable disable lifecycle", async () => {
    const writes: Array<{ readonly url: string; readonly method: string; readonly body: string }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files") && !init?.method) {
          return new Response(
            JSON.stringify({
              files: [
                {
                  name: "codex-runtime.json",
                  path: "/auth/codex-runtime.json",
                  type: "codex",
                  email: "runtime-id@example.com",
                  disabled: false,
                },
              ],
            }),
          );
        }
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        if (init?.method === "PATCH") {
          writes.push({ url, method: init.method, body: String(init.body) });
          return new Response(JSON.stringify({ status: "ok" }));
        }
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );

    render(<App />);
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    expect(await screen.findByRole("button", { name: "Kiro" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close onboarding" }));
    fireEvent.click(await screen.findByRole("button", { name: "Disable runtime-id@example.com" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      url: "http://127.0.0.1:18801/v0/management/auth-files/status",
      method: "PATCH",
      body: JSON.stringify({ name: "codex-runtime.json", disabled: true }),
    });
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
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
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
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
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
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );
    render(<App />);
    const accounts = screen.getAllByText("Accounts").at(0);
    if (!accounts) throw new Error("Accounts navigation missing");
    fireEvent.click(accounts);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    // Claude offers two ways in, so its tile opens a method list first.
    fireEvent.click(await screen.findByRole("button", { name: "Claude" }));
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
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
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
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in with OpenAI" }));
    expect(await screen.findByText(/Waiting for provider approval/i)).toBeInTheDocument();
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
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
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

  it("keeps gateway lifecycle state in Settings instead of rendering an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("connection refused"))),
    );
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("Settings").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Gateway offline/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Settings").at(0) as HTMLElement);
    expect(screen.getByLabelText("Gateway URL")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save & reconnect" })).toBeEnabled();
    expect(screen.getByText("Gateway process")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start gateway|Stop gateway/ })).toBeInTheDocument();
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
    fireEvent.click((await screen.findAllByText("Logs")).at(0) as HTMLElement);
    expect(await screen.findByRole("heading", { name: "Gateway logs" })).toBeInTheDocument();
    expect(
      screen.getByText(/Parsed request outcomes, not a reconstructed request history\./),
    ).toBeInTheDocument();
  });

  it("composes onboarding and config drawers through OverlayLayer with layout-overlay-layer class", async () => {
    render(<App />);
    (await screen.findAllByText("Requests"))[0];

    // 1. Open Onboarding drawer
    fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));

    const onboardingAside = await screen.findByRole("complementary", {
      name: "Provider onboarding",
    });
    const onboardingBackdrop = onboardingAside.parentElement;
    expect(onboardingBackdrop).not.toBeNull();
    expect(onboardingBackdrop).toHaveClass("layout-overlay-layer");
    expect(onboardingBackdrop).toHaveClass("drawer-backdrop");

    // Close onboarding
    fireEvent.click(screen.getByRole("button", { name: "Close onboarding" }));
    expect(
      screen.queryByRole("complementary", { name: "Provider onboarding" }),
    ).not.toBeInTheDocument();

    // 2. Open Configuration drawer from Settings
    fireEvent.click(screen.getAllByText("Settings").at(0) as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Open YAML editor" }));

    const configAside = await screen.findByRole("complementary", {
      name: "Advanced configuration editor",
    });
    const configBackdrop = configAside.parentElement;
    expect(configBackdrop).not.toBeNull();
    expect(configBackdrop).toHaveClass("layout-overlay-layer");
    expect(configBackdrop).toHaveClass("drawer-backdrop");

    // Close config drawer
    fireEvent.click(screen.getByRole("button", { name: "Close configuration editor" }));
    expect(
      screen.queryByRole("complementary", { name: "Advanced configuration editor" }),
    ).not.toBeInTheDocument();
  });
});

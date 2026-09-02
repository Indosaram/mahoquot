import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const stats = {
  uptime_secs: 3600,
  in_flight: 2,
  served: 120,
  failed_over: 3,
  refreshed: 5,
  ttft: { p50_ms: 100, p90_ms: 220, p99_ms: 500, samples: 40 },
  accounts: [],
};

const durableTotals = {
  requests: 2,
  "successful-requests": 1,
  "failed-requests": 1,
  "input-tokens": 0,
  "output-tokens": 15,
  "cached-input-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 15,
  "average-latency-ms": 70,
  "estimated-cost-usd": 0,
};

const durableEvents = [
  {
    "event-id": "req-429",
    "occurred-at-ms": 1_756_548_000_000,
    account: "codex-1",
    provider: "codex",
    model: "gpt-5.6",
    "key-label": null,
    status: 429,
    succeeded: false,
    "input-tokens": 0,
    "output-tokens": 15,
    "cached-input-tokens": 0,
    "reasoning-tokens": 0,
    "total-tokens": 15,
    "latency-ms": 71,
    "estimated-cost-usd": 0,
    "price-version": null,
  },
  {
    "event-id": "req-200",
    "occurred-at-ms": 1_756_548_001_000,
    account: "codex-1",
    provider: "codex",
    model: "gpt-5.6",
    "key-label": null,
    status: 200,
    succeeded: true,
    "input-tokens": 0,
    "output-tokens": 0,
    "cached-input-tokens": 0,
    "reasoning-tokens": 0,
    "total-tokens": 0,
    "latency-ms": 69,
    "estimated-cost-usd": 0,
    "price-version": null,
  },
];

const historyResponse = (url: string, empty = false): Response | null => {
  if (url.includes("/v0/management/history/events/"))
    return new Response(JSON.stringify({ event: durableEvents[0] }));
  if (url.includes("/v0/management/history/events"))
    return new Response(
      JSON.stringify({
        events: empty ? [] : durableEvents,
        "next-cursor": null,
        totals: durableTotals,
      }),
    );
  if (url.includes("/v0/management/history/health"))
    return new Response(
      JSON.stringify({
        ready: true,
        degraded: false,
        "queue-capacity": 16,
        "queue-depth": 0,
        "enqueued-events": 2,
        "written-events": 2,
        "dropped-events": 0,
        "database-failures": 0,
        "last-error": null,
      }),
    );
  if (url.includes("/v0/management/history/stats"))
    return new Response(JSON.stringify({ totals: durableTotals, groups: [] }));
  return null;
};

describe("Logs and Settings characterization pin", () => {
  beforeEach(() => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:18801");
    localStorage.setItem("mahoquot.key", "test-relay-key");
    localStorage.removeItem("mahoquot.theme");
    document.documentElement.removeAttribute("data-theme");
  });

  describe("Logs surface behavior", () => {
    it("renders parsed request records with KPI and proxy events", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
          if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
          if (url.includes("/logs")) {
            return new Response(
              JSON.stringify({
                records: [
                  {
                    kind: "request",
                    timestamp: 1756548000,
                    provider: "codex",
                    account: "codex-1",
                    model: "gpt-5.6",
                    status: 429,
                    success: false,
                    "latency-ms": 71,
                    "bytes-in": 1169359,
                    "bytes-out": 744,
                    tokens: 15,
                  },
                  {
                    kind: "request",
                    timestamp: 1756548001,
                    provider: "codex",
                    account: "codex-1",
                    model: "gpt-5.6",
                    status: 200,
                    success: true,
                    "latency-ms": 69,
                    "bytes-in": 1024,
                  },
                  {
                    kind: "proxy",
                    timestamp: 1756548002,
                    message: "management: config updated",
                  },
                ],
                "request-count": 2,
                "proxy-count": 1,
              }),
            );
          }
          {
            const history = historyResponse(url);
            if (history) return history;
          }
          return new Response(JSON.stringify({ ok: true }));
        }),
      );

      render(<App />);
      const logsNav = (await screen.findAllByText("Logs")).at(0);
      if (!logsNav) throw new Error("Logs navigation missing");
      fireEvent.click(logsNav);

      expect(await screen.findByRole("heading", { name: "Gateway logs" })).toBeInTheDocument();
      expect(
        screen.getByText(/Parsed request outcomes, not a reconstructed request history\./),
      ).toBeInTheDocument();
      // These mocks leave file logging off, so the memory-tail hint must show.
      expect(
        screen.getByText(/File logging is off — showing the in-memory tail\./),
      ).toBeInTheDocument();

      expect(screen.getByText("Requests")).toBeInTheDocument();
      expect(screen.getByText("Success")).toBeInTheDocument();
      expect(screen.getAllByText("gpt-5.6").length).toBe(2);
      expect(screen.getAllByText("codex-1").length).toBe(2);
      expect(screen.getAllByText("15").length).toBeGreaterThan(0);
      expect(screen.getByText("429")).toBeInTheDocument();
      expect(screen.getByText("200")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: "Proxy Logs" }));
      expect(screen.getByText("management: config updated")).toBeInTheDocument();
      expect(screen.queryByText("gpt-5.6")).not.toBeInTheDocument();
    });

    it("displays the empty state when no records exist", async () => {
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
          {
            const history = historyResponse(url, true);
            if (history) return history;
          }
          return new Response(JSON.stringify({ ok: true }));
        }),
      );

      render(<App />);
      const logsNav = (await screen.findAllByText("Logs")).at(0);
      if (!logsNav) throw new Error("Logs navigation missing");
      fireEvent.click(logsNav);

      expect(await screen.findByText("No request records.")).toBeInTheDocument();
    });

    it("displays warning panel on logs error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
          if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
          if (url.includes("/logs")) return new Response("server failure", { status: 500 });
          {
            const history = historyResponse(url, true);
            if (history) return history;
          }
          return new Response(JSON.stringify({ ok: true }));
        }),
      );

      render(<App />);
      const logsNav = (await screen.findAllByText("Logs")).at(0);
      if (!logsNav) throw new Error("Logs navigation missing");
      fireEvent.click(logsNav);

      expect(await screen.findByRole("heading", { name: "Gateway logs" })).toBeInTheDocument();
      expect(screen.getByText("No request records.")).toBeInTheDocument();
    });
  });

  describe("Settings surface behavior", () => {
    it("renders all settings sections: Gateway process, Connection & access, Proxy behavior, Appearance, Advanced YAML", async () => {
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
          if (url.endsWith("/proxy-url"))
            return new Response(JSON.stringify({ "proxy-url": "http://127.0.0.1:7890" }));
          if (url.endsWith("/routing/strategy"))
            return new Response(JSON.stringify({ strategy: "round-robin" }));
          if (url.endsWith("/request-retry"))
            return new Response(JSON.stringify({ "request-retry": 3 }));
          if (url.endsWith("/logging-to-file"))
            return new Response(JSON.stringify({ "logging-to-file": false }));
          {
            const history = historyResponse(url);
            if (history) return history;
          }
          return new Response(JSON.stringify({ ok: true }));
        }),
      );

      render(<App />);
      const settingsNav = (await screen.findAllByText("Settings")).at(0);
      if (!settingsNav) throw new Error("Settings navigation missing");
      fireEvent.click(settingsNav);

      expect(await screen.findByRole("heading", { name: "Gateway process" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Connection & access" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Proxy behavior" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Advanced YAML" })).toBeInTheDocument();
      expect(screen.getByText("Saved changes require restart")).toBeInTheDocument();
    });

    it("handles connection save and URL validation error", async () => {
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
          {
            const history = historyResponse(url);
            if (history) return history;
          }
          return new Response(JSON.stringify({ ok: true }));
        }),
      );

      render(<App />);
      const settingsNav = (await screen.findAllByText("Settings")).at(0);
      if (!settingsNav) throw new Error("Settings navigation missing");
      fireEvent.click(settingsNav);

      const urlInput = await screen.findByLabelText("Gateway URL");
      fireEvent.change(urlInput, { target: { value: "invalid-url" } });
      fireEvent.click(screen.getByRole("button", { name: "Save & reconnect" }));

      expect(
        (await screen.findAllByText(/Gateway URL must be an absolute http:\/\/ or https:\/\/ URL/i))
          .length,
      ).toBeGreaterThanOrEqual(1);

      // Valid URL
      fireEvent.change(urlInput, { target: { value: "http://127.0.0.1:18801" } });
      fireEvent.click(screen.getByRole("button", { name: "Save & reconnect" }));
      expect(
        await screen.findByText(/Connection saved — active now for this console/i),
      ).toBeInTheDocument();
    });

    it("handles API key copy to clipboard", async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock },
      });
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          invoke: vi.fn(async (command: string) => {
            if (command === "gateway_status") return "running";
            if (command === "migrate_legacy_secret") {
              return { value: "test-relay-key", remove_legacy: true };
            }
            if (command === "read_secret") return { value: null };
            if (command === "tunnel_status") {
              return {
                installed: false,
                enabled: false,
                running: false,
                public_url: null,
                error: null,
              };
            }
            if (command === "list_codex_instances") return [];
            if (command === "native_settings_state") {
              return {
                login_start_enabled: false,
                notifications: "available",
                action: null,
                gateway_running: true,
                notch: "compact",
              };
            }
            return null;
          }),
        },
      });

      render(<App />);
      const settingsNav = (await screen.findAllByText("Settings")).at(0);
      if (!settingsNav) throw new Error("Settings navigation missing");
      fireEvent.click(settingsNav);

      const copyBtn = await screen.findByRole("button", { name: "Copy API key" });
      fireEvent.click(copyBtn);

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith("test-relay-key");
        expect(screen.getByText("API key copied.")).toBeInTheDocument();
      });
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    });

    it("saves proxy settings with retry validation", async () => {
      const writes: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (init?.method === "PUT") {
            writes.push(`${url}:${init.body as string}`);
            return new Response(JSON.stringify({ status: "ok" }));
          }
          if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
          if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
          if (url.includes("/logs"))
            return new Response(
              JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
            );
          if (url.endsWith("/proxy-url")) return new Response(JSON.stringify({ "proxy-url": "" }));
          if (url.endsWith("/routing/strategy"))
            return new Response(JSON.stringify({ strategy: "round-robin" }));
          if (url.endsWith("/request-retry"))
            return new Response(JSON.stringify({ "request-retry": 3 }));
          if (url.endsWith("/logging-to-file"))
            return new Response(JSON.stringify({ "logging-to-file": false }));
          return new Response(JSON.stringify({ status: "ok" }));
        }),
      );

      render(<App />);
      const settingsNav = (await screen.findAllByText("Settings")).at(0);
      if (!settingsNav) throw new Error("Settings navigation missing");
      fireEvent.click(settingsNav);

      const retryInput = await screen.findByLabelText("Request retry count");
      fireEvent.change(retryInput, { target: { value: "-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Save proxy settings" }));

      expect(
        screen.getByText(/Request retry count must be a non-negative integer/i),
      ).toBeInTheDocument();

      fireEvent.change(retryInput, { target: { value: "4" } });
      fireEvent.click(screen.getByRole("button", { name: "Save proxy settings" }));

      await waitFor(() => expect(writes.length).toBeGreaterThan(0));
      expect(screen.getByText(/Proxy settings saved and applied/i)).toBeInTheDocument();
    });

    it("toggles theme selection", async () => {
      render(<App />);
      const settingsNav = (await screen.findAllByText("Settings")).at(0);
      if (!settingsNav) throw new Error("Settings navigation missing");
      fireEvent.click(settingsNav);

      const themeSelect = await screen.findByLabelText("Theme");
      expect(themeSelect).toHaveValue("dark");
      fireEvent.change(themeSelect, { target: { value: "light" } });
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(localStorage.getItem("mahoquot.theme")).toBe("light");
    });

    it("triggers YAML editor drawer open", async () => {
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
          {
            const history = historyResponse(url);
            if (history) return history;
          }
          return new Response(JSON.stringify({ ok: true }));
        }),
      );

      render(<App />);
      const settingsNav = (await screen.findAllByText("Settings")).at(0);
      if (!settingsNav) throw new Error("Settings navigation missing");
      fireEvent.click(settingsNav);

      const yamlBtn = await screen.findByRole("button", { name: "Open YAML editor" });
      fireEvent.click(yamlBtn);

      expect(
        await screen.findByRole("complementary", { name: "Advanced configuration editor" }),
      ).toBeInTheDocument();
    });
  });
});

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

      expect(screen.getByText("Total")).toBeInTheDocument();
      expect(screen.getByText("Success")).toBeInTheDocument();
      expect(screen.getByText("Avg Time")).toBeInTheDocument();
      expect(screen.getAllByText("gpt-5.6").length).toBe(2);
      expect(screen.getAllByText("codex-1").length).toBe(2);
      expect(screen.getByText("15")).toBeInTheDocument();
      expect(screen.getByText(/1,169,359B \u2192 744B/)).toBeInTheDocument();
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
          return new Response(JSON.stringify({ ok: true }));
        }),
      );

      render(<App />);
      const logsNav = (await screen.findAllByText("Logs")).at(0);
      if (!logsNav) throw new Error("Logs navigation missing");
      fireEvent.click(logsNav);

      expect(await screen.findByText(/HTTP 500|server failure|Action failed/i)).toBeInTheDocument();
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

import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../App";
import { createGatewayClients } from "../lib/api";
import { getSettingsScalarsStatus, useConnectionSettings } from "../hooks/useConnectionSettings";
import type { LoadState } from "../hooks/useGatewayPolling";

const SCALAR_SUFFIXES = [
  "/proxy-url",
  "/routing/strategy",
  "/request-retry",
  "/logging-to-file",
  "/codex-fast-mode",
  "/proxy-providers",
] as const;

const isScalarGet = (url: string, method: string): boolean =>
  method === "GET" && SCALAR_SUFFIXES.some((suffix) => url.endsWith(suffix));

describe("settings scalar load gate (H1)", () => {
  it("keeps Save and the scalar fields disabled until the gateway read succeeds", async () => {
    let releaseScalars = () => {};
    const scalarGate = new Promise<void>((resolve) => {
      releaseScalars = resolve;
    });
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "PUT") {
          writes.push(url);
          return new Response(JSON.stringify({ value: null }));
        }
        if (isScalarGet(url, method)) {
          await scalarGate;
          return new Response(JSON.stringify({ "proxy-url": "" }));
        }
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const proxyUrl = await screen.findByLabelText("Upstream proxy URL");
    const save = screen.getByRole("button", { name: "Save proxy settings" });

    expect(proxyUrl).toBeDisabled();
    expect(screen.getByLabelText("Routing strategy")).toBeDisabled();
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(writes).toHaveLength(0);

    releaseScalars();
    await waitFor(() => expect(save).toBeEnabled());

    fireEvent.change(proxyUrl, { target: { value: "http://127.0.0.1:7899" } });
    fireEvent.change(screen.getByLabelText("Request retry count"), { target: { value: "5" } });
    fireEvent.click(save);
    await waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(5));
    vi.unstubAllGlobals();
  });

  it("blocks Save and surfaces an inline alert when the gateway read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "PUT") return new Response(JSON.stringify({ value: null }));
        if (isScalarGet(url, method)) return new Response("gateway refused", { status: 500 });
        return new Response(JSON.stringify({ status: "ok" }));
      }),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByLabelText("Upstream proxy URL");

    const alert = await screen.findByText(/Gateway settings failed to load/);
    expect(alert).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "Save proxy settings" })).toBeDisabled();
    vi.unstubAllGlobals();
  });
});

describe("connection-settings latch (M1, hook half)", () => {
  it("drops the loaded latch when the gateway leaves online so a reconnect re-reads", async () => {
    let proxyUrlReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/proxy-url")) proxyUrlReads += 1;
        return new Response(JSON.stringify({ "proxy-url": "", status: "ok" }));
      }),
    );

    const clients = createGatewayClients("http://127.0.0.1:18801", "test-key");
    const { result, rerender } = renderHook(
      ({ loadState }: { loadState: LoadState }) =>
        useConnectionSettings({
          clients,
          loadState,
          surface: "settings",
          setNotice: vi.fn(),
          setPending: vi.fn(),
        }),
      { initialProps: { loadState: "online" as LoadState } },
    );

    await waitFor(() => expect(getSettingsScalarsStatus()).toBe("loaded"));
    expect(result.current.settingsLoaded).toBe(true);
    expect(proxyUrlReads).toBe(1);

    rerender({ loadState: "stopped" as LoadState });
    await waitFor(() => expect(proxyUrlReads).toBeGreaterThanOrEqual(2));

    rerender({ loadState: "online" as LoadState });
    await waitFor(() => expect(getSettingsScalarsStatus()).toBe("loaded"));
    vi.unstubAllGlobals();
  });
});

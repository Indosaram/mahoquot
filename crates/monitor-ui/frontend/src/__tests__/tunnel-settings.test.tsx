import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const stats = {
  uptime_secs: 1,
  in_flight: 0,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  ttft: { p50_ms: 0, p90_ms: 0, p99_ms: 0, samples: 0 },
  accounts: [],
};

const mockGateway = () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
      if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
      if (url.includes("/logs"))
        return new Response(JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }));
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
};

const openSettings = async () => {
  render(<App />);
  const settings = (await screen.findAllByText("Settings")).at(0);
  if (!settings) throw new Error("Settings navigation missing");
  fireEvent.click(settings);
};

describe("public tunnel settings", () => {
  beforeEach(() => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:18801");
    mockGateway();
  });

  it("is disabled by default and requires explicit opt-in after verified download", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "gateway_status") return "running";
      if (command === "migrate_legacy_secret")
        return { value: null, remove_legacy: false, reconnect: false };
      if (command === "tunnel_status")
        return { enabled: false, running: false, public_url: null, has_binary: false };
      if (command === "download_cloudflared")
        return { enabled: false, running: false, public_url: null, has_binary: true };
      if (command === "start_tunnel")
        return {
          enabled: true,
          running: true,
          public_url: "https://explicit-opt-in.trycloudflare.com",
          has_binary: true,
        };
      throw new Error(`unexpected command ${command}`);
    });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });

    await openSettings();

    expect(await screen.findByRole("heading", { name: "Public tunnel" })).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(
      screen.getByText(/Enabling this exposes your local gateway to the public internet/i),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("start_tunnel", undefined);

    fireEvent.click(screen.getByRole("button", { name: "Download verified cloudflared" }));
    expect(
      await screen.findByText("Verified cloudflared downloaded. Public tunnel remains disabled."),
    ).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enable public tunnel" }));
    expect(
      await screen.findByText("https://explicit-opt-in.trycloudflare.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
  });

  it("shows an error toast and no active state when tunnel start is rejected", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "gateway_status") return "running";
      if (command === "migrate_legacy_secret")
        return { value: null, remove_legacy: false, reconnect: false };
      if (command === "tunnel_status")
        return { enabled: false, running: false, public_url: null, has_binary: true };
      if (command === "start_tunnel")
        throw new Error("tunnel is only available for a local gateway");
      throw new Error(`unexpected command ${command}`);
    });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });

    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Enable public tunnel" }));

    expect(
      await screen.findByText("Action failed: tunnel is only available for a local gateway"),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Disabled")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Disable public tunnel" })).not.toBeInTheDocument();
  });
});

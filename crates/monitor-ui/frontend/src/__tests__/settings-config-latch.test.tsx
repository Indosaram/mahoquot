import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const stats = {
  uptime_secs: 3600,
  in_flight: 0,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  ttft: null,
  accounts: [],
};

const stubGateway = (scalarReads: string[], configSaves: { count: number }) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
      if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
      if (url.includes("/logs"))
        return new Response(JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }));
      if (url.includes("/v0/management/config.yaml")) {
        if (method === "PUT") {
          configSaves.count += 1;
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response("port: 18801\n");
      }
      if (url.includes("/proxy-url")) {
        if (method === "GET") scalarReads.push(url);
        return new Response(JSON.stringify({ "proxy-url": "" }));
      }
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
};

const openSettings = async (scalarReads: string[]) => {
  window.history.pushState({}, "", "/management.html?surface=settings");
  render(<App />);
  await waitFor(() => expect(scalarReads.length).toBeGreaterThanOrEqual(1));
};

describe("settings scalar latch after external config changes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("re-reads connection scalars after the Advanced YAML editor saves", async () => {
    const scalarReads: string[] = [];
    const configSaves = { count: 0 };
    stubGateway(scalarReads, configSaves);

    await openSettings(scalarReads);

    fireEvent.click(screen.getByRole("button", { name: "Open YAML editor" }));
    await screen.findByLabelText("Raw configuration YAML");
    const readsBeforeSave = scalarReads.length;
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(configSaves.count).toBe(1));
    await waitFor(() => expect(scalarReads.length).toBeGreaterThan(readsBeforeSave));
  });

  it("re-reads connection scalars after a gateway stop/start cycle", async () => {
    const scalarReads: string[] = [];
    stubGateway(scalarReads, { count: 0 });

    await openSettings(scalarReads);

    fireEvent.click(await screen.findByRole("button", { name: "Stop gateway" }));
    await screen.findByRole("button", { name: "Start gateway" });
    const readsBeforeRestart = scalarReads.length;
    fireEvent.click(screen.getByRole("button", { name: "Start gateway" }));
    await waitFor(() => expect(scalarReads.length).toBeGreaterThan(readsBeforeRestart));
  });
});

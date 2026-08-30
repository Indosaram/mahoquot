import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../App";

describe("dial probe", () => {
  it("shows worst-case percent under rings", async () => {
    window.history.pushState({}, "", "/management.html?surface=notch");
    const stats = {
      uptime_secs: 1,
      in_flight: 0,
      served: 0,
      failed_over: 0,
      refreshed: 0,
      ttft: { p50_ms: 0, p90_ms: 0, p99_ms: 0, samples: 0 },
      accounts: [
        {
          id: "a@x.com",
          provider: "codex",
          health: { status: "available" },
          ok: 1,
          fails: 0,
          usage: {
            primary: { used_percent: 71, reset_after_seconds: 100 },
            secondary: { used_percent: 61 },
          },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs")) return new Response(JSON.stringify({ lines: [] }));
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    render(<App />);
    fireEvent.mouseEnter(await screen.findByTestId("notch-ring-codex"));
    expect(screen.getByTestId("notch-ring-codex").textContent).toMatch(/\d+%/);
    window.history.pushState({}, "", "/");
  });
});

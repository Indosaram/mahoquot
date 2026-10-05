import { render, screen, waitFor } from "@testing-library/react";
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

describe("overview loading propagation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the overview loading state until the first analytics round settles", async () => {
    let releaseRanking!: (response: Response) => void;
    const ranking = new Promise<Response>((resolve) => {
      releaseRanking = resolve;
    });
    let rankingPending = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/v0/management/history/stats")) {
          if (rankingPending) {
            rankingPending = false;
            return ranking;
          }
          return new Response(JSON.stringify({ ok: true }));
        }
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
    expect((await screen.findAllByText("Loading usage…")).length).toBeGreaterThan(0);

    releaseRanking(new Response(JSON.stringify({ ok: true })));
    await waitFor(() => expect(screen.queryAllByText("Loading usage…")).toHaveLength(0));
  });
});

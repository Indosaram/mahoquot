import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewDashboard } from "../components/OverviewDashboard";
import type { AdminStats } from "../lib/schemas";
import type { TelemetrySample } from "../lib/telemetry";

const stats = {
  uptime_secs: 3600,
  in_flight: 0,
  served: 12,
  failed_over: 0,
  refreshed: 0,
  ttft: { p50_ms: 100, p90_ms: 220, p99_ms: 500, samples: 12 },
  accounts: [],
} as unknown as AdminStats;

const sample = (providers: readonly { provider: string; requests: number }[]): TelemetrySample =>
  ({
    timestamp: Date.now(),
    served: providers.reduce((sum, p) => sum + p.requests, 0),
    requests: providers.reduce((sum, p) => sum + p.requests, 0),
    successes: providers.reduce((sum, p) => sum + p.requests, 0),
    failures: 0,
    inFlight: 0,
    p50Ms: 100,
    p90Ms: 200,
    providers: providers.map((p) => ({ ...p, successes: p.requests, failures: 0 })),
    accounts: [],
  }) as unknown as TelemetrySample;

const samples = [
  sample([
    { provider: "codex", requests: 8 },
    { provider: "antigravity", requests: 5 },
    { provider: "claude", requests: 3 },
  ]),
];

describe("provider mix colors", () => {
  it("renders each mix segment with its provider accent color", () => {
    render(<OverviewDashboard stats={stats} samples={samples} />);
    const segments = document.querySelectorAll<HTMLIFrameElement>(".provider-mix-track i");
    expect(segments.length).toBe(3);
    const backgrounds = [...segments].map((segment) => segment.style.background);
    // F-M3: the mix reads the same dither palette the chart paints
    // (codex → green, antigravity → blue, claude → orange), not providerColor.
    expect(backgrounds[0]).toBe("rgb(40, 210, 110)");
    expect(backgrounds[1]).toBe("rgb(53, 143, 243)");
    expect(backgrounds[2]).toBe("rgb(255, 150, 50)");
  });

  it("colors the label dots to match their segments", () => {
    render(<OverviewDashboard stats={stats} samples={samples} />);
    const dots = document.querySelectorAll<HTMLIFrameElement>(
      ".provider-mix-labels .provider-mix-dot",
    );
    expect(dots.length).toBe(3);
    expect(dots[0].style.background).toBe("rgb(40, 210, 110)");
  });

  it("gives the mix and the chart legend the same hue for the same provider (F-M3)", () => {
    render(
      <OverviewDashboard stats={stats} samples={samples} dimension="provider" metric="requests" />,
    );
    const segments = [...document.querySelectorAll<HTMLElement>(".provider-mix-track i")];
    const swatches = [
      ...document.querySelectorAll<HTMLElement>(".overview-breakdown-chart ul li span:first-child"),
    ];
    expect(segments).toHaveLength(3);
    expect(swatches).toHaveLength(3);

    // Hex inline styles serialise as "rgb(r, g, b)"; seed fills as
    // "rgba(r, g, b, 1)" — compare the r,g,b triple only.
    const rgbOf = (el: HTMLElement): string =>
      (el.style.background || el.style.backgroundColor).match(/\d+/g)?.slice(0, 3).join(",") ?? "";

    for (let i = 0; i < segments.length; i++) {
      expect(rgbOf(segments[i])).toBe(rgbOf(swatches[i]));
    }
  });
});

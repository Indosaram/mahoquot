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
    expect(backgrounds[0]).toBe("rgb(16, 163, 127)");
    expect(backgrounds[1]).toBe("rgb(49, 134, 255)");
    expect(backgrounds[2]).toBe("rgb(217, 119, 87)");
  });

  it("colors the label dots to match their segments", () => {
    render(<OverviewDashboard stats={stats} samples={samples} />);
    const dots = document.querySelectorAll<HTMLIFrameElement>(
      ".provider-mix-labels .provider-mix-dot",
    );
    expect(dots.length).toBe(3);
    expect(dots[0].style.background).toBe("rgb(16, 163, 127)");
  });
});

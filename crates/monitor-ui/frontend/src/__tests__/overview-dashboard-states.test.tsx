import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewDashboard } from "../components/OverviewDashboard";
import type { OverviewAnalytics } from "../lib/overview-analytics";
import { EMPTY_ANALYTICS, telemetryAnalytics } from "../lib/overview-analytics";
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

const nowMs = Date.now();

const baseAnalytics = (overrides: Partial<OverviewAnalytics> = {}): OverviewAnalytics => ({
  ...telemetryAnalytics({
    samples: [sample([{ provider: "codex", requests: 8 }])],
    dimension: "provider",
    metric: "requests",
    range: "1h",
    nowMs,
    accounts: [],
  }),
  ...overrides,
});
const kpi = (label: string): HTMLElement => {
  const grid = document.querySelector(".minimal-kpis");
  expect(grid).not.toBeNull();
  return within(grid as HTMLElement).getByText(label).parentElement as HTMLElement;
};

describe("overview dashboard states", () => {
  it("shows loading copies instead of stale rows/empty claims while a round is in flight (F-M1)", () => {
    render(
      <OverviewDashboard
        stats={stats}
        samples={[]}
        analytics={baseAnalytics({ isLoading: true })}
      />,
    );

    expect(screen.getByText("Loading activity…")).toBeInTheDocument();
    expect(screen.getAllByText("Loading usage…")).toHaveLength(2);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("No usage in this window")).not.toBeInTheDocument();
    expect(screen.queryByText("No provider traffic")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".provider-mix-track i")).toHaveLength(0);

    expect(kpi("Requests").textContent).toBe("Requests—");
    expect(kpi("Success").textContent).toBe("Success—");
    expect(kpi("Failed").textContent).toBe("Failed—");
  });

  it("prints '—' for Success when there are no outcomes instead of a fabricated 100% (F-M2)", () => {
    const { unmount } = render(
      <OverviewDashboard
        stats={stats}
        samples={[]}
        analytics={baseAnalytics({
          totals: { ...baseAnalytics().totals, successes: 0, failures: 0 },
        })}
      />,
    );

    const kpiEl = kpi("Success");
    expect(kpiEl.textContent).toBe("Success—");
    expect(kpiEl.textContent).not.toContain("100%");
    unmount();

    render(
      <OverviewDashboard
        stats={stats}
        samples={[]}
        analytics={EMPTY_ANALYTICS("provider", "requests", "1h")}
      />,
    );
    expect(kpi("Success").textContent).toBe("Success—");
  });

  it("focus resolves a rank >=7 row: narrows KPIs/chart and shows the clear chip (F-H1)", () => {
    const providers = Array.from({ length: 9 }, (_, i) => ({
      provider: `prov-${i + 1}`,
      requests: i + 1,
    }));
    const analytics = telemetryAnalytics({
      samples: [sample(providers)],
      dimension: "provider",
      metric: "requests",
      range: "1h",
      nowMs,
      accounts: [],
    });

    render(<OverviewDashboard stats={stats} samples={[]} analytics={analytics} />);

    // Rank 8 sits outside the plotted top-6 + Other stack but on page 1 of
    // the pager, where the table still offers focus on it.
    const target = analytics.allRows?.find((row) => row.key === "prov-2");
    expect(target?.requests).toBe(2);
    expect(analytics.rows.some((row) => row.key === "prov-2")).toBe(false);

    const row = screen.getByText(target?.label ?? "").closest("tr");
    expect(row).not.toBeNull();
    const rowButton = within(row as HTMLElement).getByRole("button");
    fireEvent.click(rowButton);
    expect(rowButton).toHaveAttribute("aria-pressed", "true");

    // Before F-H1 focusAnalytics found no such key: no chip, and KPIs/chart
    // kept the full window while the row showed pressed.
    const chip = screen.getByLabelText(`Clear filter: showing ${target?.label} only`);
    expect(chip).toBeInTheDocument();

    expect(kpi("Requests").textContent).toBe("Requests2");

    const chart = screen
      .getByRole("img", { name: "Activity by provider" })
      .closest(".overview-breakdown-chart");
    expect(chart).not.toBeNull();
    expect(within(chart as HTMLElement).getByText(target?.label ?? "")).toBeInTheDocument();
    const topLabel = analytics.rows[0]?.label ?? "";
    expect(within(chart as HTMLElement).queryByText(topLabel)).not.toBeInTheDocument();
  });
});

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewDashboard } from "../components/OverviewDashboard";
import { EMPTY_ANALYTICS } from "../lib/overview-analytics";
import type { AdminStats } from "../lib/schemas";

const stats = {
  uptime_secs: 3600,
  in_flight: 2,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  accounts: [],
} as unknown as AdminStats;

const empty = EMPTY_ANALYTICS("provider", "requests", "1h");

const summary = () => screen.getByRole("region", { name: "Window summary" });

const kpiValue = (label: string) =>
  within(summary()).getByText(label).parentElement?.querySelector("strong");

describe("Overview redesign", () => {
  it("exposes loading separately from an empty window without inventing measurements", () => {
    const { rerender } = render(
      <OverviewDashboard stats={stats} samples={[]} analytics={{ ...empty, isLoading: true }} />,
    );

    expect(summary().querySelector(".minimal-kpis")).toHaveAttribute("aria-busy", "true");
    expect(kpiValue("Requests")).toHaveTextContent("—");
    expect(kpiValue("Success")).toHaveTextContent("—");
    expect(kpiValue("Failed")).toHaveTextContent("—");
    expect(kpiValue("In flight")).toHaveTextContent("2");
    expect(kpiValue("p50")).toHaveTextContent("—");
    expect(kpiValue("p90")).toHaveTextContent("—");
    expect(screen.getByRole("region", { name: "Usage breakdown" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(document.querySelectorAll(".provider-mix-track i")).toHaveLength(0);

    rerender(<OverviewDashboard stats={stats} samples={[]} analytics={empty} />);

    expect(summary().querySelector(".minimal-kpis")).toHaveAttribute("aria-busy", "false");
    expect(kpiValue("Requests")).toHaveTextContent("0");
    expect(kpiValue("Failed")).toHaveTextContent("0");
    expect(kpiValue("Success")).toHaveTextContent("—");
    expect(screen.getByRole("region", { name: "Usage breakdown" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(document.querySelector(".overview-chart-loading")).not.toBeInTheDocument();
  });

  it.each([false, true])("preserves all six KPI labels when loading=%s", (isLoading) => {
    render(<OverviewDashboard stats={stats} samples={[]} analytics={{ ...empty, isLoading }} />);

    for (const label of ["Requests", "Success", "Failed", "In flight", "p50", "p90"]) {
      expect(within(summary()).getByText(label)).toBeInTheDocument();
      expect(kpiValue(label)).toBeInTheDocument();
    }
  });
});

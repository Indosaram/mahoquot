import { assignDimensionSeeds } from "@/lib/dimension-colors";
import type { BreakdownRow, OverviewAnalytics } from "@/lib/overview-analytics";
import { type JSX, useMemo } from "react";
import { Area } from "./dither-kit/area";
import { AreaChart } from "./dither-kit/area-chart";
import { BlockLegend } from "./dither-kit/block-legend";
import type { ChartConfig } from "./dither-kit/chart-context";

export interface OverviewBreakdownChartProps {
  readonly analytics: OverviewAnalytics;
  readonly height?: number;
  /** True while the owning hook fetches this window: say so instead of
   * claiming the window is empty or showing the previous window's data (F-M1). */
  readonly loading?: boolean;
}

const isReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

export const OverviewBreakdownChart = ({
  analytics,
  height = 250,
  loading = false,
}: OverviewBreakdownChartProps): JSX.Element => {
  // 1. const isEmpty
  const isEmpty =
    analytics.series.length === 0 || analytics.series.every((point) => point.total === 0);

  // 2. const showNotice
  const showNotice = !analytics.supportsModelDimension && analytics.dimension === "model";

  // 3. const data
  const data = useMemo(
    () => analytics.series.map((point) => ({ ...point.values })),
    [analytics.series],
  );

  // 4. const rowMap
  const rowMap = useMemo(
    () => new Map<string, BreakdownRow>(analytics.rows.map((row) => [row.key, row])),
    [analytics.rows],
  );

  // 5. const config
  const config = useMemo(() => {
    // One shared assignment: the mix bar and legend below resolve their hues
    // from this same map, so a key can never be two colours on one screen.
    const assignedColors = assignDimensionSeeds(analytics);

    const result: ChartConfig = {};
    for (const key of analytics.seriesKeys) {
      const row = rowMap.get(key);
      const label = row ? row.label : key;
      const color = assignedColors.get(key) ?? "grey";
      result[key] = { label, color };
    }
    return result;
  }, [analytics, rowMap]);

  // 6. const animate
  const animate = !isReducedMotion();

  // 7. if (loading) — a round is in flight: neither an empty-window claim nor
  // stale rows may be presented as this window's data (F-M1). Plain text div
  // (no aria-label: a name on role="generic" is never exposed, F-M5).
  if (loading) {
    return (
      <div
        className="overview-breakdown-chart overview-chart-loading flex items-center justify-center text-xs text-muted-foreground"
        aria-busy="true"
        style={{
          height,
          border: "1px dashed var(--line-soft)",
          borderRadius: 6,
          background: "var(--panel-2)",
        }}
      >
        Loading activity…
      </div>
    );
  }

  // 8. if (showNotice)
  if (showNotice) {
    return (
      <div
        className="overview-breakdown-chart flex items-center justify-center text-xs text-muted-foreground"
        style={{ height }}
      >
        Model breakdown needs request history
      </div>
    );
  }

  // 9. if (isEmpty)
  if (isEmpty) {
    return (
      <div
        className="overview-breakdown-chart flex items-center justify-center text-xs text-muted-foreground"
        style={{ height }}
      >
        No traffic in this window
      </div>
    );
  }

  // 10. return AreaChart + BlockLegend. The former `aria-label` sat on a plain
  // <div> (role="generic" cannot be named, so screen readers never heard it)
  // while the graphic itself was hardcoded "Chart"; the name now lives on the
  // chart graphic through `ariaLabel` (F-M5).
  return (
    <div className="overview-breakdown-chart flex flex-col gap-2" style={{ height }}>
      <AreaChart
        data={data}
        config={config}
        stackType="stacked"
        animate={animate}
        className="flex-1 min-h-0"
        ariaLabel={`Activity by ${analytics.dimension}`}
      >
        {analytics.seriesKeys.map((key) => (
          <Area key={key} dataKey={key} />
        ))}
      </AreaChart>
      <BlockLegend config={config} />
    </div>
  );
};

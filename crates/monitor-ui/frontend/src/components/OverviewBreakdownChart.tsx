import { dimensionDitherColor } from "@/lib/dimension-colors";
import { type BreakdownRow, OTHER_KEY, type OverviewAnalytics } from "@/lib/overview-analytics";
import { type JSX, useMemo } from "react";
import { Area } from "./dither-kit/area";
import { AreaChart } from "./dither-kit/area-chart";
import { BlockLegend } from "./dither-kit/block-legend";
import type { ChartConfig } from "./dither-kit/chart-context";
import type { DitherColor } from "./dither-kit/palette";

export interface OverviewBreakdownChartProps {
  readonly analytics: OverviewAnalytics;
  readonly height?: number;
}

const PALETTE_CHOICES: readonly DitherColor[] = [
  "green",
  "blue",
  "purple",
  "pink",
  "orange",
  "red",
];

const isReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

export const OverviewBreakdownChart = ({
  analytics,
  height = 250,
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
    const usedSeeds = new Set<DitherColor>();
    const assignedColors = new Map<string, DitherColor>();

    // Process every key whose row is NOT isOther first
    for (const key of analytics.seriesKeys) {
      const row = rowMap.get(key);
      if (key === OTHER_KEY || row?.isOther) continue;
      const provider = row ? row.provider : key;
      const preferred = dimensionDitherColor(analytics.dimension, key, provider);

      if (!usedSeeds.has(preferred)) {
        usedSeeds.add(preferred);
        assignedColors.set(key, preferred);
      } else {
        const fallback = PALETTE_CHOICES.find((c) => !usedSeeds.has(c)) ?? preferred;
        usedSeeds.add(fallback);
        assignedColors.set(key, fallback);
      }
    }

    // Process OTHER_KEY last: always assign "grey"
    for (const key of analytics.seriesKeys) {
      const row = rowMap.get(key);
      if (key === OTHER_KEY || row?.isOther) {
        assignedColors.set(key, "grey");
      }
    }

    const result: ChartConfig = {};
    for (const key of analytics.seriesKeys) {
      const row = rowMap.get(key);
      const label = row ? row.label : key;
      const color = assignedColors.get(key) ?? "grey";
      result[key] = { label, color };
    }
    return result;
  }, [analytics.dimension, analytics.seriesKeys, rowMap]);

  // 6. const animate
  const animate = !isReducedMotion();

  // 7. if (showNotice)
  if (showNotice) {
    return (
      <div
        className="overview-breakdown-chart flex items-center justify-center text-xs text-muted-foreground"
        aria-label={`Activity by ${analytics.dimension}`}
        style={{ height }}
      >
        Model breakdown needs request history
      </div>
    );
  }

  // 8. if (isEmpty)
  if (isEmpty) {
    return (
      <div
        className="overview-breakdown-chart flex items-center justify-center text-xs text-muted-foreground"
        aria-label={`Activity by ${analytics.dimension}`}
        style={{ height }}
      >
        No traffic in this window
      </div>
    );
  }

  // 9. return AreaChart + BlockLegend
  return (
    <div
      className="overview-breakdown-chart flex flex-col gap-2"
      aria-label={`Activity by ${analytics.dimension}`}
      style={{ height }}
    >
      <AreaChart
        data={data}
        config={config}
        stackType="stacked"
        animate={animate}
        className="flex-1 min-h-0"
      >
        {analytics.seriesKeys.map((key) => (
          <Area key={key} dataKey={key} />
        ))}
      </AreaChart>
      <BlockLegend config={config} />
    </div>
  );
};

import { useMemo, useState } from "react";
import type { NormalizedAccount } from "../lib/accounts";
import { dimensionColor } from "../lib/dimension-colors";
import type {
  OverviewAnalytics,
  OverviewDimension,
  OverviewMetric,
} from "../lib/overview-analytics";
import { telemetryAnalytics } from "../lib/overview-analytics";
import type { AdminStats } from "../lib/schemas";
import {
  getOverviewDimension,
  getOverviewMetric,
  getTelemetryRange,
  setOverviewDimension,
  setOverviewMetric,
  setTelemetryRange,
} from "../lib/storage";
import type { TelemetryRange, TelemetrySample } from "../lib/telemetry";
import { OverviewBreakdownChart } from "./OverviewBreakdownChart";
import { OverviewBreakdownTable } from "./OverviewBreakdownTable";
import { Cluster, IntrinsicGrid, Stack } from "./layout";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

const latency = (stats: AdminStats, pick: "p50_ms" | "p90_ms"): string => {
  const value = typeof stats.ttft === "number" ? stats.ttft : stats.ttft?.[pick];
  return value === undefined || value <= 0 ? "—" : `${Math.round(value)} ms`;
};

const providerName = (provider: string): string =>
  provider === "antigravity" ? "Antigravity" : provider.charAt(0).toUpperCase() + provider.slice(1);

export interface OverviewDashboardProps {
  readonly stats: AdminStats;
  readonly samples: readonly TelemetrySample[];
  readonly accounts?: readonly NormalizedAccount[];
  readonly range?: TelemetryRange;
  readonly onRangeChange?: (range: TelemetryRange) => void;
  readonly asOfMs?: number;
  readonly analytics?: OverviewAnalytics;
  readonly dimension?: OverviewDimension;
  readonly onDimensionChange?: (dimension: OverviewDimension) => void;
  readonly metric?: OverviewMetric;
  readonly onMetricChange?: (metric: OverviewMetric) => void;
  readonly analyticsError?: string;
}

export const OverviewDashboard = ({
  stats,
  samples,
  accounts = [],
  range: controlledRange,
  onRangeChange,
  asOfMs,
  analytics,
  dimension: controlledDimension,
  onDimensionChange,
  metric: controlledMetric,
  onMetricChange,
  analyticsError,
}: OverviewDashboardProps) => {
  const [localRange, setLocalRange] = useState<TelemetryRange>(getTelemetryRange);
  const range = controlledRange ?? localRange;

  const [localDimension, setLocalDimension] = useState<OverviewDimension>(getOverviewDimension);
  const dimension = controlledDimension ?? analytics?.dimension ?? localDimension;

  const [localMetric, setLocalMetric] = useState<OverviewMetric>(getOverviewMetric);
  const metric = controlledMetric ?? analytics?.metric ?? localMetric;

  const handleRangeChange = (nextRange: TelemetryRange) => {
    if (onRangeChange) {
      onRangeChange(nextRange);
    } else {
      setLocalRange(nextRange);
      setTelemetryRange(nextRange);
    }
  };

  const handleDimensionChange = (nextDimension: OverviewDimension) => {
    if (onDimensionChange) {
      onDimensionChange(nextDimension);
    }
    if (controlledDimension === undefined) {
      setLocalDimension(nextDimension);
      setOverviewDimension(nextDimension);
    }
  };

  const handleMetricChange = (nextMetric: OverviewMetric) => {
    if (onMetricChange) {
      onMetricChange(nextMetric);
    }
    if (controlledMetric === undefined) {
      setLocalMetric(nextMetric);
      setOverviewMetric(nextMetric);
    }
  };

  const derivedAnalytics = useMemo(() => {
    if (analytics) return analytics;
    return telemetryAnalytics({
      samples,
      dimension,
      metric,
      range,
      nowMs: asOfMs ?? Date.now(),
      accounts,
    });
  }, [accounts, analytics, asOfMs, dimension, metric, range, samples]);

  const effectiveAnalytics = analytics ?? derivedAnalytics;

  const outcomes = effectiveAnalytics.totals.successes + effectiveAnalytics.totals.failures;
  const successRate = outcomes > 0 ? (effectiveAnalytics.totals.successes / outcomes) * 100 : 100;

  const mixTitle =
    effectiveAnalytics.dimension === "model"
      ? "Model mix"
      : effectiveAnalytics.dimension === "account"
        ? "Account mix"
        : "Provider mix";

  return (
    <Stack className="content overview operations-dashboard minimal-dashboard">
      <Cluster className="range-selector" role="radiogroup" aria-label="Telemetry range">
        {(["30m", "1h", "1d", "7d", "30d"] as const).map((item) => (
          <label key={item}>
            <input
              type="radio"
              name="telemetry-range"
              value={item}
              checked={range === item}
              onChange={() => handleRangeChange(item)}
            />
            <span>{item}</span>
          </label>
        ))}
      </Cluster>

      <Cluster className="overview-dimension-selector" role="radiogroup" aria-label="Group by">
        {(
          [
            { id: "provider", label: "Provider" },
            { id: "model", label: "Model" },
            { id: "account", label: "Account" },
          ] as const
        ).map((item) => (
          <label key={item.id}>
            <input
              type="radio"
              name="overview-dimension"
              value={item.id}
              checked={dimension === item.id}
              onChange={() => handleDimensionChange(item.id)}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </Cluster>

      <Cluster className="overview-metric-selector" role="radiogroup" aria-label="Metric">
        {(
          [
            { id: "requests", label: "Requests" },
            { id: "tokens", label: "Tokens" },
          ] as const
        ).map((item) => (
          <label key={item.id}>
            <input
              type="radio"
              name="overview-metric"
              value={item.id}
              checked={metric === item.id}
              onChange={() => handleMetricChange(item.id)}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </Cluster>

      <IntrinsicGrid className="minimal-kpis">
        <div>
          <span>Requests</span>
          <strong>{compact.format(effectiveAnalytics.totals.requests)}</strong>
        </div>
        <div>
          <span>Success</span>
          <strong>{successRate.toFixed(outcomes > 0 ? 1 : 0)}%</strong>
        </div>
        <div>
          <span>Failed</span>
          <strong>{compact.format(effectiveAnalytics.totals.failures)}</strong>
        </div>
        <div>
          <span>In flight</span>
          <strong>{stats.in_flight}</strong>
        </div>
        <div>
          <span>p50</span>
          <strong>{latency(stats, "p50_ms")}</strong>
        </div>
        <div>
          <span>p90</span>
          <strong>{latency(stats, "p90_ms")}</strong>
        </div>
      </IntrinsicGrid>

      <section className="minimal-chart-section">
        <header>
          <h2>Request activity</h2>
          <span>{range}</span>
        </header>
        <OverviewBreakdownChart analytics={effectiveAnalytics} />
      </section>

      <section className="minimal-provider-mix" aria-label={mixTitle}>
        <header>
          <h2>{mixTitle}</h2>
          <span>{range}</span>
        </header>
        <div className="provider-mix-track" aria-hidden="true">
          {effectiveAnalytics.rows.map((row) => (
            <i
              key={row.key}
              style={{
                width: `${row.share * 100}%`,
                background: dimensionColor(effectiveAnalytics.dimension, row.key, row.provider),
              }}
            />
          ))}
        </div>
        <Cluster className="provider-mix-labels">
          {effectiveAnalytics.rows.length ? (
            effectiveAnalytics.rows.map((row) => {
              const color = dimensionColor(effectiveAnalytics.dimension, row.key, row.provider);
              return (
                <span key={row.key}>
                  <i className="provider-mix-dot" style={{ background: color }} />
                  <strong>
                    {effectiveAnalytics.dimension === "provider"
                      ? providerName(row.label)
                      : row.label}
                  </strong>
                  {Math.round(row.share * 100)}%
                </span>
              );
            })
          ) : (
            <span>No {effectiveAnalytics.dimension} traffic</span>
          )}
        </Cluster>
      </section>

      <OverviewBreakdownTable analytics={effectiveAnalytics} />

      {analyticsError && analyticsError.trim() !== "" ? (
        <div className="state-panel warning" role="alert">
          {analyticsError}
        </div>
      ) : null}
    </Stack>
  );
};

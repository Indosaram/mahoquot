import { useMemo, useState } from "react";
import type { AdminStats } from "../lib/schemas";
import { getTelemetryRange, setTelemetryRange } from "../lib/storage";
import {
  type TelemetryPoint,
  type TelemetryRange,
  type TelemetrySample,
  filterTelemetryRange,
  summarizeTelemetry,
  telemetrySeries,
} from "../lib/telemetry";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// Every point is one equal-duration bucket, so index maps straight to elapsed time.
const chartPoints = (series: readonly TelemetryPoint[]): string => {
  const values = series.length ? series.map((point) => point.requests) : [0];
  const max = Math.max(1, ...values);
  const denominator = Math.max(1, values.length - 1);
  return values
    .map((value, index) => `${(index / denominator) * 100},${34 - (value / max) * 30}`)
    .join(" ");
};

// Persisted buckets carry no latency, so percentiles come from live stats.
const latency = (stats: AdminStats, pick: "p50_ms" | "p90_ms"): string => {
  const value = typeof stats.ttft === "number" ? stats.ttft : stats.ttft?.[pick];
  return value === undefined || value <= 0 ? "—" : `${Math.round(value)} ms`;
};

const providerName = (provider: string): string =>
  provider === "antigravity" ? "Antigravity" : provider.charAt(0).toUpperCase() + provider.slice(1);

export const OverviewDashboard = ({
  stats,
  samples,
}: {
  readonly stats: AdminStats;
  readonly samples: readonly TelemetrySample[];
}) => {
  const [range, setRange] = useState<TelemetryRange>(getTelemetryRange);
  const filtered = useMemo(() => filterTelemetryRange(samples, range), [range, samples]);
  const series = useMemo(() => telemetrySeries(filtered, range), [filtered, range]);
  const summary = useMemo(() => summarizeTelemetry(filtered), [filtered]);
  const outcomes = summary.successes + summary.failures;
  const successRate = outcomes > 0 ? (summary.successes / outcomes) * 100 : 100;
  const totalProviderRequests = Math.max(
    1,
    summary.providers.reduce((sum, provider) => sum + provider.requests, 0),
  );

  return (
    <div className="content overview operations-dashboard minimal-dashboard">
      <div className="range-selector" role="radiogroup" aria-label="Telemetry range">
        {(["30m", "1h", "1d", "7d", "30d"] as const).map((item) => (
          <label key={item}>
            <input
              type="radio"
              name="telemetry-range"
              value={item}
              checked={range === item}
              onChange={() => {
                setRange(item);
                setTelemetryRange(item);
              }}
            />
            <span>{item}</span>
          </label>
        ))}
      </div>
      <div className="minimal-kpis">
        <div>
          <span>Requests</span>
          <strong>{compact.format(summary.requests)}</strong>
        </div>
        <div>
          <span>Success</span>
          <strong>{successRate.toFixed(outcomes > 0 ? 1 : 0)}%</strong>
        </div>
        <div>
          <span>Failed</span>
          <strong>{compact.format(summary.failures)}</strong>
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
      </div>

      <section className="minimal-chart-section">
        <header>
          <h2>Request activity</h2>
          <span>{range}</span>
        </header>
        <div className="minimal-request-chart" role="img" aria-label="Request activity over time">
          <svg viewBox="0 0 100 36" preserveAspectRatio="none">
            <title>Request activity over time</title>
            <defs>
              <linearGradient id="minimal-request-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.24" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M0 34H100 M0 18H100" className="minimal-chart-grid" />
            <polygon
              points={`0,34 ${chartPoints(series)} 100,34`}
              fill="url(#minimal-request-area)"
            />
            <polyline points={chartPoints(series)} className="minimal-request-line" />
          </svg>
          {!series.some((point) => point.requests > 0) ? <span>No requests yet</span> : null}
        </div>
      </section>

      <section className="minimal-provider-mix" aria-label="Provider mix">
        <header>
          <h2>Provider mix</h2>
          <span>{range}</span>
        </header>
        <div className="provider-mix-track" aria-hidden="true">
          {summary.providers.map((provider, index) => (
            <i
              key={provider.provider}
              style={{
                width: `${(provider.requests / totalProviderRequests) * 100}%`,
                opacity: Math.max(0.38, 1 - index * 0.17),
              }}
            />
          ))}
        </div>
        <div className="provider-mix-labels">
          {summary.providers.length ? (
            summary.providers.map((provider) => (
              <span key={provider.provider}>
                <strong>{providerName(provider.provider)}</strong>
                {Math.round((provider.requests / totalProviderRequests) * 100)}%
              </span>
            ))
          ) : (
            <span>No provider traffic</span>
          )}
        </div>
      </section>
    </div>
  );
};

import { useMemo, useState } from "react";
import type { AdminStats } from "../lib/schemas";
import { getTelemetryRange, setTelemetryRange } from "../lib/storage";
import {
  type TelemetryPoint,
  type TelemetryRange,
  type TelemetrySample,
  accountRateSeries,
  filterTelemetryRange,
  rangeSeconds,
  summarizeTelemetry,
  telemetrySeries,
} from "../lib/telemetry";
import { Cluster, IntrinsicGrid, Stack } from "./layout";

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
  accountSamples,
}: {
  readonly stats: AdminStats;
  readonly samples: readonly TelemetrySample[];
  readonly accountSamples: readonly TelemetrySample[];
}) => {
  const [range, setRange] = useState<TelemetryRange>(getTelemetryRange);
  const filtered = useMemo(() => filterTelemetryRange(samples, range), [range, samples]);
  const series = useMemo(() => telemetrySeries(filtered, range), [filtered, range]);
  const accountFiltered = useMemo(
    () => filterTelemetryRange(accountSamples, range),
    [accountSamples, range],
  );
  const summary = useMemo(() => summarizeTelemetry(filtered), [filtered]);
  const outcomes = summary.successes + summary.failures;
  const successRate = outcomes > 0 ? (summary.successes / outcomes) * 100 : 100;
  const totalProviderRequests = Math.max(
    1,
    summary.providers.reduce((sum, provider) => sum + provider.requests, 0),
  );

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
              onChange={() => {
                setRange(item);
                setTelemetryRange(item);
              }}
            />
            <span>{item}</span>
          </label>
        ))}
      </Cluster>
      <IntrinsicGrid className="minimal-kpis">
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
      </IntrinsicGrid>

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

      <section className="minimal-chart-section" aria-label="Per-account request rate">
        <header>
          <h2>Per-account request rate</h2>
          <span>{range}</span>
        </header>
        <div className="minimal-account-panels">
          {stats.accounts.map((account, index) => {
            const label = `Account ${index + 1}`;
            const series = accountRateSeries(accountFiltered, account.id, range);
            const total = series.reduce((sum, point) => sum + point.requests, 0);
            const bucketSecs = rangeSeconds(range) / series.length;
            const peakPerMin =
              (Math.max(0, ...series.map((point) => point.requests)) * 60) / bucketSecs;
            return (
              <article key={account.id} className="minimal-account-panel">
                <header>
                  <span className="name">{label}</span>
                  <span className="peak tnum">{Math.round(peakPerMin)}/min peak</span>
                </header>
                {total === 0 ? (
                  <div className="minimal-account-empty">No traffic in this window</div>
                ) : (
                  <div
                    className="minimal-account-chart"
                    role="img"
                    aria-label={`${label}: peak ${Math.round(peakPerMin)} requests per minute`}
                  >
                    <svg viewBox="0 0 100 36" preserveAspectRatio="none">
                      <title>{`${label} peak request rate`}</title>
                      <defs>
                        <linearGradient
                          id={`minimal-account-area-${account.id}`}
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.24" />
                          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <path d="M0 34H100 M0 18H100" className="minimal-chart-grid" />
                      <polygon
                        points={`0,34 ${chartPoints(series)} 100,34`}
                        fill={`url(#minimal-account-area-${account.id})`}
                      />
                      <polyline points={chartPoints(series)} className="minimal-request-line" />
                    </svg>
                  </div>
                )}
              </article>
            );
          })}
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
        <Cluster className="provider-mix-labels">
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
        </Cluster>
      </section>
    </Stack>
  );
};

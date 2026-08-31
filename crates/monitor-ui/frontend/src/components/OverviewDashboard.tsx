import { DitherArea } from "@/components/dither-area";
import { useMemo, useState } from "react";
import { providerColor } from "../lib/provider-colors";
import type { AdminStats } from "../lib/schemas";
import { getTelemetryRange, setTelemetryRange } from "../lib/storage";
import {
  type TelemetryRange,
  type TelemetrySample,
  filterTelemetryRange,
  summarizeTelemetry,
  telemetrySeries,
} from "../lib/telemetry";
import { Cluster, IntrinsicGrid, Stack } from "./layout";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

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
        <div className="minimal-request-chart">
          {series.some((point) => point.requests > 0) ? (
            <DitherArea
              values={series.map((point) => point.requests)}
              seed={{ fill: [240, 128, 26], line: [255, 178, 102] }}
              height={250}
              ariaLabel="Request activity over time"
            />
          ) : (
            <span>No traffic in this window</span>
          )}
        </div>
      </section>

      <section className="minimal-provider-mix" aria-label="Provider mix">
        <header>
          <h2>Provider mix</h2>
          <span>{range}</span>
        </header>
        <div className="provider-mix-track" aria-hidden="true">
          {summary.providers.map((provider) => (
            <i
              key={provider.provider}
              style={{
                width: `${(provider.requests / totalProviderRequests) * 100}%`,
                background: providerColor(provider.provider),
              }}
            />
          ))}
        </div>
        <Cluster className="provider-mix-labels">
          {summary.providers.length ? (
            summary.providers.map((provider) => (
              <span key={provider.provider}>
                <i
                  className="provider-mix-dot"
                  style={{ background: providerColor(provider.provider) }}
                />
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

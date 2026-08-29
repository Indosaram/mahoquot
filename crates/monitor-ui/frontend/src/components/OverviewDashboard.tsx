import { Activity, ArrowUpRight, Clock3, Gauge, GitFork, TerminalSquare } from "lucide-react";
import type { AdminStats } from "../lib/schemas";
import { type TelemetrySample, providerTotals } from "../lib/telemetry";
import { Badge, Button, Card } from "./ui";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

const chartPoints = (samples: readonly TelemetrySample[]): string => {
  const values = samples.length ? samples.map((sample) => sample.requests) : [0];
  const max = Math.max(1, ...values);
  const denominator = Math.max(1, values.length - 1);
  return values
    .map((value, index) => `${(index / denominator) * 100},${34 - (value / max) * 30}`)
    .join(" ");
};

const latencyValue = (stats: AdminStats, key: "p50_ms" | "p90_ms" | "p99_ms"): number =>
  typeof stats.ttft === "number" ? stats.ttft : (stats.ttft?.[key] ?? 0);

const providerName = (provider: string): string =>
  provider === "antigravity" ? "Antigravity" : provider.charAt(0).toUpperCase() + provider.slice(1);

export const OverviewDashboard = ({
  stats,
  samples,
  online,
  onOpenLogs,
}: {
  readonly stats: AdminStats;
  readonly samples: readonly TelemetrySample[];
  readonly online: boolean;
  readonly onOpenLogs: () => void;
}) => {
  const providers = providerTotals(stats);
  const successes = providers.reduce((sum, provider) => sum + provider.successes, 0);
  const failures = providers.reduce((sum, provider) => sum + provider.failures, 0);
  const outcomes = successes + failures;
  const successRate = outcomes > 0 ? (successes / outcomes) * 100 : 100;
  const latest = samples.at(-1);
  const peak = Math.max(0, ...samples.map((sample) => sample.requests));
  const chartMax = Math.max(1, peak);
  const latestY = 34 - ((latest?.requests ?? 0) / chartMax) * 30;
  const maxProviderRequests = Math.max(1, ...providers.map((provider) => provider.requests));

  return (
    <div className="content overview operations-dashboard">
      <div className="operations-toolbar">
        <div>
          <span className="live-indicator">
            <i className={online ? "online" : ""} /> {online ? "Live" : "Unavailable"}
          </span>
          <span>10-second live samples · 30-day history</span>
        </div>
        <Button onClick={onOpenLogs}>
          <TerminalSquare size={14} /> Open logs
        </Button>
      </div>

      <div className="operations-kpis">
        <div>
          <span>Total requests</span>
          <strong>{compact.format(stats.served)}</strong>
          <small>{latest ? `+${latest.requests} latest interval` : "Waiting for traffic"}</small>
        </div>
        <div>
          <span>Success rate</span>
          <strong>{successRate.toFixed(outcomes > 0 ? 1 : 0)}%</strong>
          <small>{compact.format(failures)} failed upstream outcomes</small>
        </div>
        <div>
          <span>In flight</span>
          <strong>{stats.in_flight}</strong>
          <small>Active requests now</small>
        </div>
        <div>
          <span>TTFT p50</span>
          <strong>
            {latencyValue(stats, "p50_ms") ? `${Math.round(latencyValue(stats, "p50_ms"))}ms` : "—"}
          </strong>
          <small>First token latency</small>
        </div>
      </div>

      <Card className="traffic-chart-card">
        <div className="chart-heading">
          <div>
            <span className="kicker">REQUEST ACTIVITY</span>
            <h2>Calls over time</h2>
          </div>
          <div className="chart-meta">
            <div className="chart-legend" aria-label="Request outcome legend">
              <span>
                <i className="success" /> Successful
              </span>
              <span>
                <i className="failed" /> Failed
              </span>
            </div>
            <div className="chart-summary">
              <span>
                Latest <strong>{latest?.requests ?? 0}</strong>
              </span>
              <span>
                Peak <strong>{peak}</strong>
              </span>
            </div>
          </div>
        </div>
        <div className="chart-frame">
          <div className="chart-scale" aria-hidden="true">
            <span>{peak}</span>
            <span>{Math.round(peak / 2)}</span>
            <span>0</span>
          </div>
          <div className="request-chart" role="img" aria-label="Request activity over time">
            <svg viewBox="0 0 100 36" preserveAspectRatio="none">
              <title>Request activity over time</title>
              <defs>
                <linearGradient id="request-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M0 34H100 M0 22H100 M0 10H100" className="chart-grid-lines" />
              <polygon points={`0,34 ${chartPoints(samples)} 100,34`} fill="url(#request-area)" />
              <polyline points={chartPoints(samples)} className="request-line" />
              {samples.length ? (
                <circle cx="100" cy={latestY} r="1.1" className="request-point" />
              ) : null}
            </svg>
            {!samples.some((sample) => sample.requests > 0) ? (
              <span className="chart-empty">Requests will appear here as traffic arrives.</span>
            ) : null}
          </div>
        </div>
        <div className="chart-axis">
          <span>
            {samples.length > 1
              ? new Date(samples[0]?.timestamp ?? 0).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "Earlier"}
          </span>
          <span>Now</span>
        </div>
      </Card>

      <div className="operations-grid">
        <Card className="provider-traffic-card">
          <div className="chart-heading">
            <div>
              <span className="kicker">ROUTING MIX</span>
              <h2>Provider traffic</h2>
            </div>
            <ArrowUpRight size={17} />
          </div>
          <div className="provider-traffic-list">
            {providers.length ? (
              providers.map((provider) => (
                <div key={provider.provider}>
                  <div>
                    <strong>{providerName(provider.provider)}</strong>
                    <span>
                      {compact.format(provider.requests)} calls ·{" "}
                      {provider.requests
                        ? Math.round((provider.successes / provider.requests) * 100)
                        : 100}
                      % success
                    </span>
                  </div>
                  <div className="traffic-track">
                    <i style={{ width: `${(provider.requests / maxProviderRequests) * 100}%` }} />
                  </div>
                </div>
              ))
            ) : (
              <p className="empty">No provider traffic in this process yet.</p>
            )}
          </div>
        </Card>

        <Card className="latency-card">
          <div className="chart-heading">
            <div>
              <span className="kicker">RESPONSE SPEED</span>
              <h2>Latency distribution</h2>
            </div>
            <Clock3 size={17} />
          </div>
          <div className="latency-bars">
            {(["p50_ms", "p90_ms", "p99_ms"] as const).map((key) => {
              const value = latencyValue(stats, key);
              const max = Math.max(1, latencyValue(stats, "p99_ms"));
              return (
                <div key={key}>
                  <span>{key.slice(0, 3).toUpperCase()}</span>
                  <div>
                    <i style={{ width: `${(value / max) * 100}%` }} />
                  </div>
                  <strong>{value ? `${Math.round(value)} ms` : "—"}</strong>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="operations-status-card">
          <span>
            <Activity size={15} /> Current interval
          </span>
          <strong>{latest?.requests ?? 0} calls</strong>
          <small>
            {latest?.successes ?? 0} success · {latest?.failures ?? 0} failed
          </small>
        </Card>
        <Card className="operations-status-card">
          <span>
            <GitFork size={15} /> Failovers
          </span>
          <strong>{stats.failed_over}</strong>
          <small>Account switches since start</small>
        </Card>
        <Card className="operations-status-card">
          <span>
            <Gauge size={15} /> TTFT p90
          </span>
          <strong>
            {latencyValue(stats, "p90_ms")
              ? `${Math.round(latencyValue(stats, "p90_ms"))} ms`
              : "—"}
          </strong>
          <small>Tail first-token latency</small>
        </Card>
      </div>
      <div className="snapshot-note">
        <Badge tone="neutral">30-day retention</Badge>
        Request history is persisted for 30 days and survives gateway and console restarts.
      </div>
    </div>
  );
};

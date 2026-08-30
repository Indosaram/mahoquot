import { useMemo, useState } from "react";
import type { LogRecord } from "../lib/schemas";

export interface LogsSurfaceProps {
  readonly records: readonly LogRecord[];
  readonly logsError?: string | undefined;
  readonly fromMemoryTail?: boolean | undefined;
}

type LogTab = "requests" | "proxy";

const timeOf = (record: LogRecord): string => {
  if (typeof record.timestamp !== "number") return "--:--:--";
  return new Date(record.timestamp * 1000).toLocaleTimeString([], { hour12: false });
};

const bytesLabel = (value: number | undefined): string =>
  typeof value === "number" ? `${value.toLocaleString("en-US")}B` : "-";

const statusClass = (status: number | undefined): string => {
  if (status === undefined) return "badge-neutral";
  if (status < 400) return "badge-ok";
  if (status < 500) return "badge-warn";
  return "badge-bad";
};

export function LogsSurface({ records, logsError, fromMemoryTail }: LogsSurfaceProps) {
  const [tab, setTab] = useState<LogTab>("requests");
  const [providerFilter, setProviderFilter] = useState<string>("all");

  const requests = useMemo(() => records.filter((record) => record.kind === "request"), [records]);
  const proxyEvents = useMemo(() => records.filter((record) => record.kind === "proxy"), [records]);
  const providers = useMemo(
    () => [...new Set(requests.map((record) => record.provider ?? "unknown"))].sort(),
    [requests],
  );
  const visibleRequests = useMemo(
    () =>
      requests.filter(
        (record) => providerFilter === "all" || (record.provider ?? "unknown") === providerFilter,
      ),
    [requests, providerFilter],
  );
  const kpi = useMemo(() => {
    const total = visibleRequests.length;
    const ok = visibleRequests.filter((record) => record.success).length;
    const latencies = visibleRequests
      .map((record) => record["latency-ms"])
      .filter((value): value is number => typeof value === "number");
    const avg = latencies.length
      ? `${Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)}ms`
      : "-";
    const tokenValues = visibleRequests
      .map((record) => record.tokens)
      .filter((value): value is number => typeof value === "number");
    const tokens = tokenValues.length
      ? tokenValues.reduce((sum, value) => sum + value, 0).toLocaleString("en-US")
      : "-";
    return {
      total,
      successPct: total ? `${Math.round((ok / total) * 100)}%` : "-",
      tokens,
      avg,
    };
  }, [visibleRequests]);

  return (
    <div className="content logs-surface">
      <header className="logs-header">
        <div>
          <h2>Gateway logs</h2>
          <p>
            Parsed request outcomes, not a reconstructed request history.
            {fromMemoryTail ? " File logging is off — showing the in-memory tail." : ""}
          </p>
        </div>
        <div className="logs-tabs" role="tablist" aria-label="Log view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "requests"}
            className={tab === "requests" ? "active" : ""}
            onClick={() => setTab("requests")}
          >
            Requests
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "proxy"}
            className={tab === "proxy" ? "active" : ""}
            onClick={() => setTab("proxy")}
          >
            Proxy Logs
          </button>
        </div>
      </header>

      {logsError ? <div className="state-panel warning">{logsError}</div> : null}

      {tab === "requests" ? (
        <>
          <div className="logs-kpi">
            <div>
              <span>Total</span>
              <strong>{kpi.total}</strong>
            </div>
            <div>
              <span>Success</span>
              <strong>{kpi.successPct}</strong>
            </div>
            <div>
              <span>Tokens</span>
              <strong>{kpi.tokens}</strong>
            </div>
            <div>
              <span>Avg Time</span>
              <strong>{kpi.avg}</strong>
            </div>
            <label className="logs-provider-filter">
              <span>Provider</span>
              <select
                value={providerFilter}
                onChange={(event) => setProviderFilter(event.target.value)}
                aria-label="Provider filter"
              >
                <option value="all">All Providers</option>
                {providers.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="logs-table-wrap">
            <table className="logs-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Account</th>
                  <th>Latency</th>
                  <th className="num">Bytes</th>
                </tr>
              </thead>
              <tbody>
                {visibleRequests.map((record, index) => (
                  <tr key={`${record.timestamp}-${index}`}>
                    <td className="dim">{timeOf(record)}</td>
                    <td>
                      <span className={`badge ${statusClass(record.status)}`}>
                        {record.status ?? "-"}
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-neutral">{record.provider ?? "unknown"}</span>
                    </td>
                    <td className="dim">{record.model || "-"}</td>
                    <td className="dim">{record.account ?? "-"}</td>
                    <td className="dim">
                      {typeof record["latency-ms"] === "number" ? `${record["latency-ms"]}ms` : "-"}
                    </td>
                    <td className="num dim">
                      {bytesLabel(record["bytes-in"])} → {bytesLabel(record["bytes-out"])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleRequests.length === 0 ? (
              <div className="logs-empty">No request records.</div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="logs-table-wrap">
          <table className="logs-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {proxyEvents.map((record, index) => (
                <tr key={`${record.timestamp}-${index}`}>
                  <td className="dim">{timeOf(record)}</td>
                  <td>{record.message ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {proxyEvents.length === 0 ? <div className="logs-empty">No proxy events.</div> : null}
        </div>
      )}
    </div>
  );
}

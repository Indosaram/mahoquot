import { type JSX, useState } from "react";
import type { BreakdownRow, OverviewAnalytics } from "../lib/overview-analytics";
import { ProviderGlyph } from "./ProviderGlyph";
import { Button } from "./ui";

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const formatExact = (num: number): string => num.toLocaleString("en-US");

const formatSuccess = (row: BreakdownRow): string => {
  if (row.requests === 0) return "—";
  return `${((row.successes / row.requests) * 100).toFixed(1)}%`;
};

const formatLatency = (row: BreakdownRow): string => {
  if (row.requests === 0) return "—";
  return `${compact.format(row.avgLatencyMs)} ms`;
};

const formatLatencyExact = (row: BreakdownRow): string => {
  if (row.requests === 0) return "—";
  return `${formatExact(row.avgLatencyMs)} ms`;
};

const formatCost = (val: number): string =>
  `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface OverviewBreakdownTableProps {
  readonly analytics: OverviewAnalytics;
  readonly maxRows?: number;
}

export const OverviewBreakdownTable = ({
  analytics,
  maxRows = 8,
}: OverviewBreakdownTableProps): JSX.Element => {
  const [expanded, setExpanded] = useState(false);

  const hasMore = analytics.rows.length > maxRows;
  const visibleRows = expanded || !hasMore ? analytics.rows : analytics.rows.slice(0, maxRows);

  return (
    <section className="overview-breakdown" aria-label="Usage breakdown">
      <header>
        <h2>Usage breakdown</h2>
        <div className="overview-token-header-meta">
          {analytics.isTokenPartial ? (
            <span className="overview-token-partial-badge">Partial</span>
          ) : null}
          <span>{analytics.range}</span>
        </div>
      </header>

      {analytics.rows.length === 0 ? (
        <div className="overview-token-empty">
          <span>No usage in this window</span>
        </div>
      ) : (
        <div className="overview-token-accounts">
          <div className="overview-token-table-wrapper">
            <table className="overview-token-table" aria-label="Usage breakdown">
              <thead>
                <tr>
                  <th scope="col" className="overview-token-col-account">
                    Name
                  </th>
                  <th scope="col" className="overview-token-col-num">
                    Requests
                  </th>
                  <th scope="col" className="overview-token-col-num">
                    Success
                  </th>
                  <th scope="col" className="overview-token-col-num">
                    Input
                  </th>
                  <th scope="col" className="overview-token-col-num">
                    Output
                  </th>
                  <th scope="col" className="overview-token-col-num">
                    Total
                  </th>
                  <th scope="col" className="overview-token-col-num">
                    Avg latency
                  </th>
                  {analytics.hasCostData ? (
                    <th scope="col" className="overview-token-col-num">
                      Cost
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr
                    key={row.key}
                    className={
                      row.isOther
                        ? "overview-breakdown-row-other overview-token-row-unclassified"
                        : undefined
                    }
                  >
                    <td className="overview-token-col-account">
                      <div className="overview-token-account-info">
                        <ProviderGlyph provider={row.provider} />
                        <span className="overview-token-account-name" title={row.label}>
                          {row.label}
                        </span>
                        {row.isUnlinked ? <span className="badge badge-warn">Unlinked</span> : null}
                      </div>
                    </td>
                    <td className="overview-token-col-num" title={formatExact(row.requests)}>
                      {compact.format(row.requests)}
                    </td>
                    <td
                      className="overview-token-col-num"
                      title={row.requests === 0 ? "—" : formatSuccess(row)}
                    >
                      {formatSuccess(row)}
                    </td>
                    <td className="overview-token-col-num" title={formatExact(row.inputTokens)}>
                      {compact.format(row.inputTokens)}
                    </td>
                    <td className="overview-token-col-num" title={formatExact(row.outputTokens)}>
                      {compact.format(row.outputTokens)}
                    </td>
                    <td
                      className="overview-token-col-num overview-token-total"
                      title={formatExact(row.totalTokens)}
                    >
                      <strong>
                        {analytics.isTokenPartial
                          ? `~${compact.format(row.totalTokens)}`
                          : compact.format(row.totalTokens)}
                      </strong>
                    </td>
                    <td className="overview-token-col-num" title={formatLatencyExact(row)}>
                      {formatLatency(row)}
                    </td>
                    {analytics.hasCostData ? (
                      <td className="overview-token-col-num" title={formatCost(row.costUsd)}>
                        {formatCost(row.costUsd)}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore ? (
            <div className="overview-breakdown-actions flex justify-center py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setExpanded((prev) => !prev)}
                aria-label={expanded ? "Show fewer" : "Show all"}
              >
                {expanded ? "Show fewer" : "Show all"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
};

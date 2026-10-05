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

// Latency is unknown — not zero — when the gateway omitted both optional
// latency fields (history rows fall back to 0) or the telemetry fallback
// hardcodes 0 (degraded mode is exactly when history is failing); only a
// measured positive value is a latency. Printing "0 ms" as fact was wrong (F-M6).
const hasLatency = (row: BreakdownRow): boolean => row.requests > 0 && row.avgLatencyMs > 0;

const formatLatency = (row: BreakdownRow): string => {
  if (!hasLatency(row)) return "—";
  return `${compact.format(row.avgLatencyMs)} ms`;
};

const formatLatencyExact = (row: BreakdownRow): string => {
  if (!hasLatency(row)) return "—";
  return `${formatExact(row.avgLatencyMs)} ms`;
};

const formatCost = (val: number): string =>
  `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Rows per page of the usage breakdown pager. Kept small enough that a
 * laptop sees navigation without scrolling, large enough that one page reads
 * as a table rather than a sample. */
const PAGE_SIZE = 8;

export interface OverviewBreakdownTableProps {
  readonly analytics: OverviewAnalytics;
  /** Row key the dashboard is narrowed to, or null when showing everything. */
  readonly focusKey?: string | null;
  /** Omitted by callers that want a read-only table. */
  readonly onFocusChange?: (key: string | null) => void;
  /** True while the owning hook fetches this window: show that instead of
   * the empty-state claim or the previous window's rows (F-M1). */
  readonly loading?: boolean;
}

export const OverviewBreakdownTable = ({
  analytics,
  focusKey = null,
  onFocusChange,
  loading = false,
}: OverviewBreakdownTableProps): JSX.Element => {
  // allRows carries every aggregate row; legacy/mocked analytics objects that
  // predate it fall back to rows so their behavior is unchanged.
  const rows = analytics.allRows ?? analytics.rows;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const [page, setPage] = useState(0);

  // The rows identity is the pagination contract: a group-by, range, sort, or
  // filter change that alters the row set rewinds to the first page, and a
  // shrink below the current page clamps instead of stranding an empty view.
  const rowSignature = rows.map((row) => row.key).join("\u0000");
  const [prevRowSignature, setPrevRowSignature] = useState(rowSignature);
  if (prevRowSignature !== rowSignature) {
    setPrevRowSignature(rowSignature);
    setPage(0);
  }
  const currentPage = Math.min(page, pageCount - 1);
  if (page !== currentPage) {
    setPage(currentPage);
  }

  const pageStart = currentPage * PAGE_SIZE;
  const visibleRows = rows.slice(pageStart, pageStart + PAGE_SIZE);

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

      {loading ? (
        <div className="overview-token-empty">
          <span>Loading usage…</span>
        </div>
      ) : rows.length === 0 ? (
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
                {visibleRows.map((row) => {
                  // The folded row stands for many entities at once, so there is
                  // nothing single for it to narrow to.
                  const canFocus = Boolean(onFocusChange) && !row.isOther;
                  const isFocused = canFocus && row.key === focusKey;
                  const toggle = () => onFocusChange?.(isFocused ? null : row.key);
                  return (
                    <tr
                      key={row.key}
                      className={
                        [
                          row.isOther
                            ? "overview-breakdown-row-other overview-token-row-unclassified"
                            : "",
                          canFocus ? "overview-breakdown-row-selectable" : "",
                          isFocused ? "is-focused" : "",
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                      onClick={canFocus ? toggle : undefined}
                      onKeyDown={
                        canFocus
                          ? (event) => {
                              // The row is a click target for the whole width; the
                              // account button inside it is the focusable handle, so
                              // keyboard activation arrives here only when the row
                              // itself holds focus.
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                toggle();
                              }
                            }
                          : undefined
                      }
                    >
                      <td className="overview-token-col-account">
                        <div className="overview-token-account-info">
                          <ProviderGlyph provider={row.provider} />
                          {canFocus ? (
                            <button
                              type="button"
                              className="overview-token-account-name overview-breakdown-focus"
                              title={
                                isFocused
                                  ? `Showing ${row.label} only — click to show all`
                                  : `Show ${row.label} only`
                              }
                              aria-pressed={isFocused}
                              onClick={(event) => {
                                // The row handler already toggles; without this the
                                // click would toggle twice and cancel itself out.
                                event.stopPropagation();
                                toggle();
                              }}
                            >
                              {row.label}
                            </button>
                          ) : (
                            <span className="overview-token-account-name" title={row.label}>
                              {row.label}
                            </span>
                          )}
                          {row.isUnlinked ? (
                            <span className="badge badge-warn">Unlinked</span>
                          ) : null}
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
                  );
                })}
              </tbody>
            </table>
          </div>
          {pageCount > 1 ? (
            <div className="overview-breakdown-pagination">
              <span className="overview-breakdown-page-status">
                {pageStart + 1}–{pageStart + visibleRows.length} of {rows.length} rows · page{" "}
                {currentPage + 1}/{pageCount}
              </span>
              <div className="overview-breakdown-page-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Previous breakdown page"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous page
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Next breakdown page"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next page
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
};

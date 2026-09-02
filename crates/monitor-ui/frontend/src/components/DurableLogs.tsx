import { useEffect, useMemo, useState } from "react";
import type { HistoryStatsQuery } from "../lib/api";
import type {
  HistoryEvent,
  HistoryEventsResponse,
  HistoryHealth,
  HistoryStatsResponse,
  LogRecord,
} from "../lib/schemas";
import { Button, Card, Input } from "./ui";

export interface DurableLogsProps {
  readonly records: readonly LogRecord[];
  readonly historyStats?: HistoryStatsResponse | null;
  readonly historyHealth?: HistoryHealth | null;
  readonly historyLoading?: boolean;
  readonly historyError?: string;
  readonly fromMemoryTail?: boolean;
  readonly onHistoryQuery?: (query: HistoryStatsQuery) => void | Promise<void>;
  readonly loadHistory?: (query: HistoryStatsQuery) => Promise<HistoryEventsResponse>;
  readonly loadHistoryDetail?: (eventId: string) => Promise<HistoryEvent>;
  readonly countHistory?: (query: HistoryStatsQuery) => Promise<number>;
  readonly clearHistory?: (query: HistoryStatsQuery) => Promise<number>;
  readonly exportHistory?: (
    format: "csv" | "json",
    query: HistoryStatsQuery,
  ) => Promise<Blob | undefined>;
}

type DraftFilters = {
  readonly start: string;
  readonly end: string;
  readonly account: string;
  readonly provider: string;
  readonly model: string;
  readonly keyLabel: string;
  readonly status: string;
  readonly outcome: "" | "succeeded" | "failed";
  readonly search: string;
  readonly limit: number;
};

const EMPTY_FILTERS: DraftFilters = {
  start: "",
  end: "",
  account: "",
  provider: "",
  model: "",
  keyLabel: "",
  status: "",
  outcome: "",
  search: "",
  limit: 50,
};

const splitText = (value: string): readonly string[] | undefined => {
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
};

const splitStatuses = (value: string): readonly number[] | undefined => {
  const values = (splitText(value) ?? [])
    .map(Number)
    .filter((status) => Number.isInteger(status) && status >= 100 && status <= 599);
  return values.length ? values : undefined;
};

const timestampMs = (value: string): number | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
};

const queryOf = (filters: DraftFilters, cursor?: number): HistoryStatsQuery => ({
  startMs: timestampMs(filters.start),
  endMs: timestampMs(filters.end),
  accounts: splitText(filters.account),
  providers: splitText(filters.provider),
  models: splitText(filters.model),
  keyLabels: splitText(filters.keyLabel),
  statusCodes: splitStatuses(filters.status),
  outcomes: filters.outcome ? [filters.outcome] : undefined,
  search: filters.search.trim() || undefined,
  limit: filters.limit,
  cursor,
});

const toHistoryEvent = (record: LogRecord, index: number): HistoryEvent => ({
  "event-id":
    typeof (record as Record<string, unknown>)["request-id"] === "string"
      ? String((record as Record<string, unknown>)["request-id"])
      : `live-${record.timestamp ?? 0}-${index}`,
  "occurred-at-ms": Math.round((record.timestamp ?? 0) * 1000),
  account: record.account ?? "-",
  provider: record.provider ?? "unknown",
  model: record.model ?? "-",
  "key-label":
    typeof (record as Record<string, unknown>)["key-label"] === "string"
      ? String((record as Record<string, unknown>)["key-label"])
      : null,
  status: record.status ?? 0,
  succeeded: record.success ?? false,
  "input-tokens": 0,
  "output-tokens": record.tokens ?? 0,
  "cached-input-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": record.tokens ?? 0,
  "latency-ms": record["latency-ms"] ?? 0,
  "estimated-cost-usd": 0,
  "price-version": null,
});

const formatTime = (occurredAtMs: number): string =>
  occurredAtMs > 0 ? new Date(occurredAtMs).toLocaleString() : "-";

const formatCost = (value: number): string => `$${value.toFixed(2)}`;

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export function DurableLogs({
  records,
  historyStats = null,
  historyHealth = null,
  historyLoading = false,
  historyError,
  fromMemoryTail = false,
  onHistoryQuery,
  loadHistory,
  loadHistoryDetail,
  countHistory,
  clearHistory,
  exportHistory,
}: DurableLogsProps) {
  const [tab, setTab] = useState<"requests" | "proxy">("requests");
  const [draft, setDraft] = useState<DraftFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<DraftFilters>(EMPTY_FILTERS);
  const initialEvents = useMemo(
    () => records.filter((record) => record.kind === "request").map(toHistoryEvent),
    [records],
  );
  const [events, setEvents] = useState<readonly HistoryEvent[]>(initialEvents);
  const [nextCursor, setNextCursor] = useState<number | null>(() =>
    records.some((record) => record.kind === "request") ? 1 : null,
  );
  const [pageHistory, setPageHistory] = useState<
    readonly {
      readonly events: readonly HistoryEvent[];
      readonly nextCursor: number | null;
      readonly loadedBefore: number;
    }[]
  >([]);
  const [loadedBefore, setLoadedBefore] = useState(0);
  const [selected, setSelected] = useState<HistoryEvent | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearCount, setClearCount] = useState<number | null>(null);
  const [lastClearedCount, setLastClearedCount] = useState<number | null>(null);
  const [emptyAfterClear, setEmptyAfterClear] = useState(false);
  const [pending, setPending] = useState<"load" | "clear" | "csv" | "json" | "">("");
  const [actionError, setActionError] = useState("");

  const proxyRecords = useMemo(
    () =>
      records
        .filter((record) => record.kind === "proxy")
        .slice()
        .reverse(),
    [records],
  );

  useEffect(() => {
    if (loadHistory || emptyAfterClear) return;
    setEvents(initialEvents);
    setNextCursor(initialEvents.length ? 1 : null);
  }, [emptyAfterClear, initialEvents, loadHistory]);

  useEffect(() => {
    if (!loadHistory || historyError) return;
    let active = true;
    setPending("load");
    void loadHistory(queryOf(EMPTY_FILTERS))
      .then((page) => {
        if (!active) return;
        setEvents(page.events);
        setNextCursor(page["next-cursor"]);
        setLoadedBefore(0);
        setPageHistory([]);
        setEmptyAfterClear(false);
      })
      .catch((error: unknown) => {
        if (active) setActionError(error instanceof Error ? error.message : "History unavailable");
      })
      .finally(() => {
        if (active) setPending("");
      });
    return () => {
      active = false;
    };
  }, [loadHistory, historyError]);

  const applyFilters = async () => {
    const query = queryOf(draft);
    setApplied(draft);
    setSelected(null);
    setEmptyAfterClear(false);
    setPageHistory([]);
    setActionError("");
    onHistoryQuery?.(query);
    if (!loadHistory) {
      setNextCursor(events.length ? 1 : null);
      return;
    }
    setPending("load");
    try {
      const page = await loadHistory(query);
      setEvents(page.events);
      setNextCursor(page["next-cursor"]);
      setLoadedBefore(0);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "History unavailable");
    } finally {
      setPending("");
    }
  };

  const loadMore = async () => {
    if (nextCursor === null) return;
    const query = queryOf(applied, nextCursor);
    onHistoryQuery?.(query);
    if (!loadHistory) return;
    setPending("load");
    setActionError("");
    try {
      const page = await loadHistory(query);
      setPageHistory((history) => [...history, { events, nextCursor, loadedBefore }]);
      setEvents(page.events);
      setLoadedBefore((current) => current + events.length);
      setNextCursor(page["next-cursor"]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "History unavailable");
    } finally {
      setPending("");
    }
  };

  const loadPrevious = () => {
    const previous = pageHistory.at(-1);
    if (!previous) return;
    setEvents(previous.events);
    setNextCursor(previous.nextCursor);
    setLoadedBefore(previous.loadedBefore);
    setPageHistory((history) => history.slice(0, -1));
  };

  const openDetail = async (event: HistoryEvent) => {
    setActionError("");
    if (!loadHistoryDetail) {
      setSelected(event);
      return;
    }
    try {
      setSelected(await loadHistoryDetail(event["event-id"]));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Request detail unavailable");
    }
  };

  const requestClearConfirmation = async () => {
    setActionError("");
    try {
      const count = countHistory
        ? await countHistory({ ...queryOf(applied), cursor: null })
        : (historyStats?.totals.requests ?? events.length);
      setClearCount(count);
      setConfirmClear(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "History count unavailable");
    }
  };

  const confirmHistoryClear = async () => {
    setPending("clear");
    setActionError("");
    try {
      const deleted = await clearHistory?.({ ...queryOf(applied), cursor: null });
      setLastClearedCount(deleted ?? clearCount ?? 0);
      setEvents([]);
      setNextCursor(null);
      setLoadedBefore(0);
      setPageHistory([]);
      setSelected(null);
      setEmptyAfterClear(true);
      setConfirmClear(false);
      await onHistoryQuery?.(queryOf(applied));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "History could not be cleared");
    } finally {
      setPending("");
    }
  };

  const runExport = async (format: "csv" | "json") => {
    if (!exportHistory) return;
    setPending(format);
    setActionError("");
    try {
      const blob = await exportHistory(format, { ...queryOf(applied), cursor: null });
      if (blob) downloadBlob(blob, `mahoquot-request-history.${format}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "History export failed");
    } finally {
      setPending("");
    }
  };

  const totals = historyStats?.totals;
  const totalCount = totals?.requests ?? events.length;
  const firstVisible = events.length ? loadedBefore + 1 : 0;
  const lastVisible = loadedBefore + events.length;
  const averageLatency =
    totals?.["average-latency-ms"] ??
    (events.length
      ? Math.round(events.reduce((sum, event) => sum + event["latency-ms"], 0) / events.length)
      : 0);
  const tokenTotal =
    totals?.["total-tokens"] ?? events.reduce((sum, event) => sum + event["total-tokens"], 0);
  const costTotal =
    totals?.["estimated-cost-usd"] ??
    events.reduce((sum, event) => sum + event["estimated-cost-usd"], 0);

  return (
    <div className="durable-logs">
      <Card className="durable-logs-console">
        <header className="durable-logs-head">
          <div>
            <span className="eyebrow">REQUEST LEDGER</span>
            <h2>Gateway logs</h2>
            <p>
              Parsed request outcomes, not a reconstructed request history. Durable rows are
              cursor-paged from the gateway history store.
              {fromMemoryTail ? " File logging is off — showing the in-memory tail." : ""}
            </p>
          </div>
          <div className="durable-logs-actions">
            <Button
              disabled={!exportHistory || pending === "csv"}
              onClick={() => void runExport("csv")}
            >
              {pending === "csv" ? "Exporting…" : "Export CSV"}
            </Button>
            <Button
              disabled={!exportHistory || pending === "json"}
              onClick={() => void runExport("json")}
            >
              {pending === "json" ? "Exporting…" : "Export JSON"}
            </Button>
            <Button
              className="danger"
              disabled={!clearHistory || pending === "clear"}
              onClick={() => void requestClearConfirmation()}
            >
              Clear history
            </Button>
          </div>
        </header>

        <div className="durable-logs-tabs" role="tablist" aria-label="Durable log view">
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

        {actionError || historyError ? (
          <div className="state-panel warning">
            {historyError ? <strong>Request history unavailable</strong> : null}
            <p>{historyError || actionError}</p>
          </div>
        ) : null}

        {tab === "requests" ? (
          <section aria-label="Request history">
            <div className="durable-logs-filter-grid">
              <label htmlFor="history-start">
                <span>Start</span>
                <Input
                  id="history-start"
                  type="datetime-local"
                  aria-label="History start"
                  value={draft.start}
                  onChange={(event) => setDraft({ ...draft, start: event.target.value })}
                />
              </label>
              <label htmlFor="history-end">
                <span>End</span>
                <Input
                  id="history-end"
                  type="datetime-local"
                  aria-label="History end"
                  value={draft.end}
                  onChange={(event) => setDraft({ ...draft, end: event.target.value })}
                />
              </label>
              <label htmlFor="history-account">
                <span>Account</span>
                <Input
                  id="history-account"
                  aria-label="History account"
                  value={draft.account}
                  onChange={(event) => setDraft({ ...draft, account: event.target.value })}
                />
              </label>
              <label htmlFor="history-provider">
                <span>Provider</span>
                <Input
                  id="history-provider"
                  aria-label="History provider"
                  value={draft.provider}
                  onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
                />
              </label>
              <label htmlFor="history-model">
                <span>Model</span>
                <Input
                  id="history-model"
                  aria-label="History model"
                  value={draft.model}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                />
              </label>
              <label htmlFor="history-key">
                <span>Inbound key</span>
                <Input
                  id="history-key"
                  aria-label="History inbound key"
                  value={draft.keyLabel}
                  onChange={(event) => setDraft({ ...draft, keyLabel: event.target.value })}
                />
              </label>
              <label htmlFor="history-status">
                <span>Status</span>
                <Input
                  id="history-status"
                  aria-label="History status"
                  value={draft.status}
                  placeholder="200,429"
                  onChange={(event) => setDraft({ ...draft, status: event.target.value })}
                />
              </label>
              <label htmlFor="history-outcome">
                <span>Outcome</span>
                <select
                  id="history-outcome"
                  className="input"
                  aria-label="History outcome"
                  value={draft.outcome}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      outcome:
                        event.target.value === "succeeded"
                          ? "succeeded"
                          : event.target.value === "failed"
                            ? "failed"
                            : "",
                    })
                  }
                >
                  <option value="">All outcomes</option>
                  <option value="succeeded">Succeeded</option>
                  <option value="failed">Failed</option>
                </select>
              </label>
              <label className="durable-logs-search-field" htmlFor="history-search">
                <span>Search</span>
                <Input
                  id="history-search"
                  aria-label="Search"
                  value={draft.search}
                  placeholder="event, account, provider, model, key"
                  onChange={(event) => setDraft({ ...draft, search: event.target.value })}
                />
              </label>
              <label htmlFor="history-page-size">
                <span>Page size</span>
                <select
                  id="history-page-size"
                  className="input"
                  aria-label="Page size"
                  value={draft.limit}
                  onChange={(event) => setDraft({ ...draft, limit: Number(event.target.value) })}
                >
                  {[25, 50, 100].map((limit) => (
                    <option value={limit} key={limit}>
                      {limit}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={pending === "load" || historyLoading}
                onClick={() => void applyFilters()}
              >
                {pending === "load" || historyLoading ? "Loading…" : "Apply history filters"}
              </Button>
            </div>

            {!historyError ? (
              <section className="durable-logs-summary" aria-label="Request history totals">
                <div>
                  <span>Total</span>
                  <strong>{totalCount.toLocaleString("en-US")}</strong>
                </div>
                <div>
                  <span>Success</span>
                  <strong>
                    {totals
                      ? totals["successful-requests"].toLocaleString("en-US")
                      : events.filter((event) => event.succeeded).length.toLocaleString("en-US")}
                  </strong>
                </div>
                <div>
                  <span>Failed</span>
                  <strong>
                    {totals
                      ? totals["failed-requests"].toLocaleString("en-US")
                      : events.filter((event) => !event.succeeded).length.toLocaleString("en-US")}
                  </strong>
                </div>
                <div>
                  <span>Avg Time</span>
                  <strong>{averageLatency.toLocaleString("en-US")} ms</strong>
                </div>
                <div>
                  <span>Tokens</span>
                  <strong>{tokenTotal.toLocaleString("en-US")}</strong>
                </div>
                <div>
                  <span>Estimated cost</span>
                  <strong>{formatCost(costTotal)}</strong>
                </div>
                <div>
                  <span>Store</span>
                  <strong
                    className={historyHealth?.degraded ? "warn" : historyHealth ? "ok" : undefined}
                  >
                    {historyHealth ? (historyHealth.degraded ? "Degraded" : "Ready") : "Unknown"}
                  </strong>
                </div>
              </section>
            ) : null}

            {lastClearedCount !== null ? (
              <output
                className="state-panel durable-logs-clear-result"
                data-history-clear-deleted={lastClearedCount}
              >
                Cleared {lastClearedCount.toLocaleString("en-US")} request records. Dashboard
                history for this scope was removed; proxy file logs were not affected.
              </output>
            ) : null}

            <div className="durable-logs-table-wrap">
              {events.length === 0 && historyStats?.groups.length ? (
                <table className="history-breakdown">
                  <tbody>
                    {historyStats.groups.map((group, index) => (
                      <tr key={`${group.account}-${group.model}-${index}`}>
                        <td>{group.account}</td>
                        <td>{group.provider}</td>
                        <td>{group.model}</td>
                        <td>{group["key-label"]}</td>
                        <td>{group.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              <table className="durable-logs-table history-events-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Status</th>
                    <th>Provider / account</th>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Latency</th>
                    <th>Cost</th>
                    <th>Event</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event["event-id"]}>
                      <td className="dim">{formatTime(event["occurred-at-ms"])}</td>
                      <td>
                        <span className={`badge ${event.succeeded ? "badge-ok" : "badge-bad"}`}>
                          {event.status || "-"}
                        </span>
                      </td>
                      <td>
                        <strong>{event.provider}</strong>
                        <small>{event.account}</small>
                      </td>
                      <td className="mono">{event.model}</td>
                      <td className="num">{event["total-tokens"].toLocaleString("en-US")}</td>
                      <td className="num">{event["latency-ms"].toLocaleString("en-US")} ms</td>
                      <td className="num">{formatCost(event["estimated-cost-usd"])}</td>
                      <td>
                        <button
                          type="button"
                          className="durable-log-detail-trigger"
                          aria-label={`View ${event["event-id"]} details`}
                          onClick={() => void openDetail(event)}
                        >
                          {event["event-id"]}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {events.length === 0 || emptyAfterClear ? (
                <div className="logs-empty">
                  <span>No request records.</span>
                  <small>No durable request history.</small>
                </div>
              ) : null}
            </div>

            {events.length || nextCursor !== null ? (
              <div className="durable-logs-pagination">
                <span>
                  {firstVisible.toLocaleString("en-US")}–{lastVisible.toLocaleString("en-US")} of{" "}
                  {totalCount.toLocaleString("en-US")}
                </span>
                <div className="durable-logs-page-actions">
                  <Button
                    aria-label="Previous history page"
                    disabled={pending === "load" || pageHistory.length === 0}
                    onClick={loadPrevious}
                  >
                    Previous page
                  </Button>
                  <Button
                    aria-label="Next history page — Next page"
                    disabled={pending === "load" || nextCursor === null}
                    onClick={() => void loadMore()}
                  >
                    Next page
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        ) : (
          <div className="durable-proxy-tail" role="log" aria-label="Proxy memory tail">
            {fromMemoryTail ? (
              <div className="state-panel">
                File logging is disabled. Showing the bounded memory tail.
              </div>
            ) : null}
            {proxyRecords.map((record, index) => {
              const event = (record as Record<string, unknown>).event;
              return (
                <article key={`${record.timestamp ?? 0}-${index}`}>
                  <time>
                    {record.timestamp
                      ? new Date(record.timestamp * 1000).toLocaleTimeString()
                      : "-"}
                  </time>
                  {typeof event === "string" ? <strong>{event}</strong> : null}
                  <span>{record.message ?? "-"}</span>
                </article>
              );
            })}
            {proxyRecords.length === 0 ? <div className="logs-empty">No proxy events.</div> : null}
          </div>
        )}
      </Card>

      {selected ? (
        <section className="durable-log-detail" aria-label="Request detail">
          <header>
            <div>
              <span className="eyebrow">REQUEST DETAIL</span>
              <h2>{selected["event-id"]}</h2>
            </div>
            <Button aria-label="Close request detail" onClick={() => setSelected(null)}>
              Close
            </Button>
          </header>
          <dl>
            <div>
              <dt>Account</dt>
              <dd>{selected.account}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>{selected.provider}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{selected.model}</dd>
            </div>
            <div>
              <dt>Inbound key</dt>
              <dd>{selected["key-label"] ?? "-"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{selected.status}</dd>
            </div>
            <div>
              <dt>Occurred</dt>
              <dd>{formatTime(selected["occurred-at-ms"])}</dd>
            </div>
            <div>
              <dt>Input tokens</dt>
              <dd>{selected["input-tokens"].toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{selected["output-tokens"].toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt>Latency</dt>
              <dd>{selected["latency-ms"].toLocaleString("en-US")} ms</dd>
            </div>
            <div>
              <dt>Estimated cost</dt>
              <dd>{formatCost(selected["estimated-cost-usd"])}</dd>
            </div>
            <div>
              <dt>Price version</dt>
              <dd>{selected["price-version"] ?? "-"}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {confirmClear ? (
        <div className="durable-log-dialog-backdrop">
          <dialog open className="durable-log-dialog" aria-label="Clear request history">
            <span className="eyebrow">DESTRUCTIVE ACTION</span>
            <h2>Clear request history</h2>
            <p>
              This permanently removes {clearCount?.toLocaleString("en-US") ?? "the selected"}{" "}
              request records and their dashboard history. It cannot be undone. Proxy file logs are
              not affected.
            </p>
            <div>
              <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
              <Button className="danger" onClick={() => void confirmHistoryClear()}>
                Clear history
              </Button>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  );
}

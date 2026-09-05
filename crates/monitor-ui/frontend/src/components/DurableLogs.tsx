
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryStatsQuery } from "../lib/api";
import type { HistoryEvent, HistoryEventsResponse, HistoryTotals, LogRecord } from "../lib/schemas";
import { Button } from "./ui";

export interface DurableLogsProps {
  readonly records: readonly LogRecord[];
  readonly fromMemoryTail?: boolean;
  readonly loadHistory?: (query: HistoryStatsQuery) => Promise<HistoryEventsResponse>;
  readonly loadHistoryDetail?: (eventId: string) => Promise<HistoryEvent>;
  /** Increments when the gateway streams a new request line. */
  readonly liveTick?: number;
}

const PAGE_LIMIT = 50;

type HistoryPage = {
  readonly events: readonly HistoryEvent[];
  readonly nextCursor: number | null;
  readonly loadedBefore: number;
};

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

const formatTime = (occurredAtMs: number): string => {
  if (occurredAtMs <= 0) return "-";
  return new Date(occurredAtMs).toLocaleTimeString([], { hour12: false });
};

const formatDateTime = (occurredAtMs: number): string =>
  occurredAtMs > 0 ? new Date(occurredAtMs).toLocaleString() : "-";

const formatCost = (value: number): string => `$${value.toFixed(2)}`;

const totalsOf = (events: readonly HistoryEvent[]): HistoryTotals => {
  const latencies = events.map((event) => event["latency-ms"]);
  const totalLatency = latencies.reduce((sum, value) => sum + value, 0);
  return {
    requests: events.length,
    "successful-requests": events.filter((event) => event.succeeded).length,
    "failed-requests": events.filter((event) => !event.succeeded).length,
    "input-tokens": 0,
    "output-tokens": events.reduce((sum, event) => sum + event["output-tokens"], 0),
    "cached-input-tokens": 0,
    "reasoning-tokens": 0,
    "total-tokens": events.reduce((sum, event) => sum + event["total-tokens"], 0),
    "total-latency-ms": totalLatency,
    "average-latency-ms": events.length ? totalLatency / events.length : 0,
    "estimated-cost-usd": events.reduce((sum, event) => sum + event["estimated-cost-usd"], 0),
  };
};

export function DurableLogs({
  records,
  fromMemoryTail = false,
  loadHistory,
  loadHistoryDetail,
  liveTick = 0,
}: DurableLogsProps) {
  const [tab, setTab] = useState<"requests" | "proxy">("requests");
  const [provider, setProvider] = useState("all");
  const initialEvents = useMemo(
    () => records.filter((record) => record.kind === "request").map(toHistoryEvent),
    [records],
  );
  const [events, setEvents] = useState<readonly HistoryEvent[]>(initialEvents);
  const [totals, setTotals] = useState<HistoryTotals | null>(null);
  const [providerOptions, setProviderOptions] = useState<readonly string[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(() =>
    records.some((record) => record.kind === "request") ? 1 : null,
  );
  const [pageHistory, setPageHistory] = useState<readonly HistoryPage[]>([]);
  const [loadedBefore, setLoadedBefore] = useState(0);
  const [selected, setSelected] = useState<HistoryEvent | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");

  const pageHistoryRef = useRef(pageHistory);
  pageHistoryRef.current = pageHistory;

  const providerRef = useRef(provider);
  providerRef.current = provider;

  // The initial load and each liveTick refresh race on the same endpoint, so a
  // slower earlier response could land last and overwrite newer rows. Only the
  // most recently issued request is allowed to publish its result.
  const requestSeqRef = useRef(0);

  const proxyRecords = useMemo(
    () =>
      records
        .filter((record) => record.kind === "proxy")
        .slice()
        .reverse(),
    [records],
  );

  const fetchLatestPage = useCallback(
    async (isBackground = false) => {
      if (!loadHistory) return;
      if (!isBackground) setPending(true);
      else setRefreshing(true);
      requestSeqRef.current += 1;
      const seq = requestSeqRef.current;
      try {
        const page = await loadHistory({
          providers: providerRef.current === "all" ? undefined : [providerRef.current],
          limit: PAGE_LIMIT,
        });
        if (seq !== requestSeqRef.current) return;
        // Only update the event list if user is still on the first page
        if (pageHistoryRef.current.length === 0) {
          setEvents(page.events);
          setNextCursor(page["next-cursor"]);
          setLoadedBefore(0);
        }
        setTotals(page.totals);
        setProviderOptions((prev) => {
          const distinct = new Set([...prev, ...page.events.map((e) => e.provider)]);
          return [...distinct].sort();
        });
      } catch (error) {
        if (!isBackground && seq === requestSeqRef.current) {
          setActionError(error instanceof Error ? error.message : "History unavailable");
        }
      } finally {
        if (!isBackground) setPending(false);
        else setRefreshing(false);
      }
    },
    [loadHistory],
  );

  useEffect(() => {
    if (loadHistory) return;
    setEvents(initialEvents);
    setNextCursor(initialEvents.length ? 1 : null);
    setProviderOptions([...new Set(initialEvents.map((event) => event.provider))].sort());
  }, [initialEvents, loadHistory]);

  // Initial load
  useEffect(() => {
    if (!loadHistory) return;
    setPageHistory([]);
    setLoadedBefore(0);
    void fetchLatestPage(false);
  }, [fetchLatestPage, loadHistory]);

  // The gateway pushes each new request line, so the first page refreshes from
  // the stream instead of a timer. Paged-back views stay frozen on purpose.
  useEffect(() => {
    if (!loadHistory || !liveTick) return;
    if (pageHistoryRef.current.length !== 0) return;
    void fetchLatestPage(true);
  }, [fetchLatestPage, liveTick, loadHistory]);

  const applyProvider = async (next: string) => {
    setProvider(next);
    setSelected(null);
    setPageHistory([]);
    setLoadedBefore(0);
    setActionError("");
    if (!loadHistory) return;
    setPending(true);
    requestSeqRef.current += 1;
    const seq = requestSeqRef.current;
    try {
      const page = await loadHistory({
        providers: next === "all" ? undefined : [next],
        limit: PAGE_LIMIT,
      });
      if (seq !== requestSeqRef.current) return;
      setEvents(page.events);
      setTotals(page.totals);
      setNextCursor(page["next-cursor"]);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      setActionError(error instanceof Error ? error.message : "History unavailable");
    } finally {
      if (seq === requestSeqRef.current) setPending(false);
    }
  };

  const loadMore = async () => {
    if (!loadHistory || nextCursor === null) return;
    setPending(true);
    setActionError("");
    requestSeqRef.current += 1;
    const seq = requestSeqRef.current;
    try {
      const page = await loadHistory({
        providers: provider === "all" ? undefined : [provider],
        limit: PAGE_LIMIT,
        cursor: nextCursor,
      });
      if (seq !== requestSeqRef.current) return;
      setPageHistory((history) => [...history, { events, nextCursor, loadedBefore }]);
      setEvents(page.events);
      setTotals(page.totals);
      setLoadedBefore((current) => current + events.length);
      setNextCursor(page["next-cursor"]);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      setActionError(error instanceof Error ? error.message : "History unavailable");
    } finally {
      if (seq === requestSeqRef.current) setPending(false);
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

  const visibleEvents =
    loadHistory || provider === "all"
      ? events
      : events.filter((event) => event.provider === provider);
  const activeTotals = totals ?? totalsOf(visibleEvents);
  const totalCount = activeTotals.requests;
  const firstVisible = visibleEvents.length ? loadedBefore + 1 : 0;
  const lastVisible = loadedBefore + visibleEvents.length;

  return (
    <div className="durable-logs">
      <section className="durable-logs-console">
        <header className="durable-logs-head">
          <div>
            <h2>Gateway logs</h2>
            <p>
              Parsed request outcomes, not a reconstructed request history.
              {fromMemoryTail ? " File logging is off — showing the in-memory tail." : ""}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span className="logs-live-indicator" role="status">
              <span className={`logs-live-dot${refreshing ? " active" : ""}`} aria-hidden="true" />
              Live
            </span>
            <label className="logs-provider-filter">
              <span>Provider</span>
              <select
                className="input"
                aria-label="Log provider filter"
                value={provider}
                onChange={(event) => void applyProvider(event.target.value)}
              >
                <option value="all">All providers</option>
                {providerOptions.map((item) => (
                  <option value={item} key={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>

        <div className="durable-logs-tabs" role="tablist" aria-label="Log view">
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

        {actionError ? (
          <div className="state-panel warning">
            <strong>Request history unavailable</strong>
            <p>{actionError}</p>
          </div>
        ) : null}

        {tab === "requests" ? (
          <section aria-label="Request history">
            {!actionError ? (
              <section className="durable-logs-summary" aria-label="Request totals">
                <div>
                  <span>Total</span>
                  <strong>{totalCount.toLocaleString("en-US")}</strong>
                </div>
                <div>
                  <span>Success</span>
                  <strong>{activeTotals["successful-requests"].toLocaleString("en-US")}</strong>
                </div>
                <div>
                  <span>Failed</span>
                  <strong>{activeTotals["failed-requests"].toLocaleString("en-US")}</strong>
                </div>
                <div>
                  <span>Avg Time</span>
                  <strong>
                    {Math.round(activeTotals["average-latency-ms"] ?? 0).toLocaleString("en-US")} ms
                  </strong>
                </div>
                <div>
                  <span>Tokens</span>
                  <strong>{activeTotals["total-tokens"].toLocaleString("en-US")}</strong>
                </div>
              </section>
            ) : null}

            <div className="durable-logs-table-wrap">
              <table className="durable-logs-table history-events-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Status</th>
                    <th>Provider / account</th>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Latency</th>
                    <th>Event</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEvents.map((event) => (
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
              {visibleEvents.length === 0 && !actionError ? (
                <div className="logs-empty">
                  <span>No request records.</span>
                  <small>No durable request history.</small>
                </div>
              ) : null}
            </div>

            {visibleEvents.length || nextCursor !== null ? (
              <div className="durable-logs-pagination">
                <span>
                  {firstVisible.toLocaleString("en-US")}–{lastVisible.toLocaleString("en-US")} of{" "}
                  {totalCount.toLocaleString("en-US")}
                </span>
                <div className="durable-logs-page-actions">
                  <Button
                    aria-label="Previous history page"
                    disabled={pending || pageHistory.length === 0}
                    onClick={loadPrevious}
                  >
                    Previous page
                  </Button>
                  <Button
                    aria-label="Next history page"
                    disabled={pending || nextCursor === null}
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
      </section>

      {selected ? (
        <section className="durable-log-detail" aria-label="Request detail">
          <header>
            <h2>Request detail</h2>
            <Button aria-label="Close request detail" onClick={() => setSelected(null)}>
              Close
            </Button>
          </header>
          <dl>
            <div>
              <dt>Event</dt>
              <dd>{selected["event-id"]}</dd>
            </div>
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
              <dd>{formatDateTime(selected["occurred-at-ms"])}</dd>
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
          </dl>
        </section>
      ) : null}
    </div>
  );
}

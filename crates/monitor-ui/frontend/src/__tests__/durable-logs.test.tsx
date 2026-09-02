import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DurableLogs, type DurableLogsProps } from "../components/DurableLogs";

const START_MS = Date.UTC(2026, 8, 1, 0, 0, 0);
const END_MS = Date.UTC(2026, 8, 2, 0, 0, 0);

const totals = {
  requests: 2,
  "successful-requests": 1,
  "failed-requests": 1,
  "input-tokens": 120,
  "output-tokens": 30,
  "cached-input-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 150,
  "estimated-cost-usd": 0.42,
};

const requestRecords = [
  {
    kind: "request",
    timestamp: 1_788_192_000,
    account: "account-a",
    provider: "codex",
    model: "gpt-5.6-sol",
    "key-label": "key-prod",
    status: 200,
    success: true,
    tokens: 100,
    "latency-ms": 87,
    method: "POST",
    path: "/v1/responses",
    "request-id": "req-success",
  },
  {
    kind: "request",
    timestamp: 1_788_192_060,
    account: "account-b",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    "key-label": "key-batch",
    status: 429,
    success: false,
    tokens: 50,
    "latency-ms": 140,
    method: "POST",
    path: "/v1/messages",
    "request-id": "req-failed",
    error: "rate limited",
  },
] as const;

const historyStats = {
  totals,
  groups: [
    {
      "bucket-start-ms": START_MS,
      account: "account-a",
      provider: "codex",
      model: "gpt-5.6-sol",
      "key-label": "key-prod",
      status: 200,
      totals,
    },
  ],
};

const historyHealth = {
  ready: true,
  degraded: false,
  "queue-capacity": 1024,
  "queue-depth": 0,
  "enqueued-events": 2,
  "written-events": 2,
  "dropped-events": 0,
  "database-failures": 0,
  "last-error": null,
};

const localDateTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
};

const renderLogs = (overrides: Partial<DurableLogsProps> = {}) => {
  const onHistoryQuery = vi.fn();
  const loadHistoryDetail = vi.fn(async () => ({
    "event-id": "req-failed",
    "occurred-at-ms": requestRecords[1].timestamp * 1000,
    account: "account-b",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    "key-label": "key-batch",
    status: 429,
    succeeded: false,
    "input-tokens": 40,
    "output-tokens": 10,
    "cached-input-tokens": 0,
    "reasoning-tokens": 0,
    "total-tokens": 50,
    "latency-ms": 140,
    "estimated-cost-usd": 0.12,
    "price-version": "2026-09",
  }));
  const countHistory = vi.fn(async () => totals.requests);
  const clearHistory = vi.fn(async () => totals.requests);
  const exportHistory = vi.fn(async () => undefined);
  render(
    <DurableLogs
      records={requestRecords as never}
      historyStats={historyStats as never}
      historyHealth={historyHealth}
      historyLoading={false}
      onHistoryQuery={onHistoryQuery}
      loadHistoryDetail={loadHistoryDetail}
      countHistory={countHistory}
      clearHistory={clearHistory}
      exportHistory={exportHistory}
      {...overrides}
    />,
  );
  return { onHistoryQuery, loadHistoryDetail, countHistory, clearHistory, exportHistory };
};

describe("Todo 15 durable logs", () => {
  it("requests paged durable history with cursor, limit, and every history filter", () => {
    const { onHistoryQuery } = renderLogs();

    fireEvent.change(screen.getByLabelText("Start"), {
      target: { value: localDateTime(START_MS) },
    });
    fireEvent.change(screen.getByLabelText("End"), {
      target: { value: localDateTime(END_MS) },
    });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "account-a" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-sol" } });
    fireEvent.change(screen.getByLabelText(/key/i), { target: { value: "key-prod" } });
    fireEvent.change(screen.getByLabelText(/status/i), { target: { value: "200,429" } });
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "failed" } });
    fireEvent.change(screen.getByLabelText(/page size/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /apply history filters/i }));

    expect(onHistoryQuery).toHaveBeenLastCalledWith({
      startMs: START_MS,
      endMs: END_MS,
      accounts: ["account-a"],
      providers: ["codex"],
      models: ["gpt-5.6-sol"],
      keyLabels: ["key-prod"],
      statusCodes: [200, 429],
      outcomes: ["failed"],
      limit: 50,
    });

    fireEvent.click(screen.getByRole("button", { name: /next history page/i }));
    expect(onHistoryQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: expect.any(Number), limit: 50 }),
    );
  });

  it("opens a selectable request detail view", async () => {
    const { loadHistoryDetail } = renderLogs();

    fireEvent.click(screen.getByText("req-failed"));

    const detail = await screen.findByRole("region", { name: /request detail/i });
    expect(loadHistoryDetail).toHaveBeenCalledWith("req-failed");
    expect(within(detail).getByText("req-failed")).toBeInTheDocument();
    expect(within(detail).getByText("account-b")).toBeInTheDocument();
    expect(within(detail).getByText("claude-sonnet-4-5")).toBeInTheDocument();
  });

  it("requires explicit confirmation before clearing history and then shows the empty state", async () => {
    const { countHistory, clearHistory } = renderLogs();

    fireEvent.click(screen.getByRole("button", { name: /clear history/i }));
    expect(clearHistory).not.toHaveBeenCalled();
    const confirmation = await screen.findByRole("dialog", { name: /clear request history/i });
    expect(countHistory).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }));
    expect(within(confirmation).getByText(/2 request records/i)).toBeInTheDocument();
    expect(within(confirmation).getByText(/cannot be undone/i)).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole("button", { name: /^clear history$/i }));

    expect(clearHistory).toHaveBeenCalledWith(expect.objectContaining({ cursor: null }));
    expect(await screen.findByText(/no durable request history/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-history-clear-deleted", "2");
  });

  it("offers CSV and JSON export actions", async () => {
    const { exportHistory } = renderLogs();

    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    fireEvent.click(screen.getByRole("button", { name: /export json/i }));
    await waitFor(() => {
      expect(exportHistory).toHaveBeenNthCalledWith(
        1,
        "csv",
        expect.objectContaining({ cursor: null }),
      );
      expect(exportHistory).toHaveBeenNthCalledWith(
        2,
        "json",
        expect.objectContaining({ cursor: null }),
      );
    });
  });

  it("keeps memory-tail operational events visible when file logging is off", () => {
    renderLogs({
      fromMemoryTail: true,
      records: [
        ...requestRecords,
        {
          kind: "proxy",
          timestamp: 1_788_192_120,
          event: "upstream_failover",
          provider: "codex",
          message: "account-a failed over to account-b",
        },
      ] as never,
    });

    expect(screen.getByText(/memory tail/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /proxy logs/i }));
    expect(screen.getByText("upstream_failover")).toBeInTheDocument();
    expect(screen.getByText("account-a failed over to account-b")).toBeInTheDocument();
  });
});

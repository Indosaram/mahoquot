import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DurableLogs } from "../components/DurableLogs";
import type { HistoryStatsQuery } from "../lib/api";
import type { HistoryEvent, HistoryEventsResponse } from "../lib/schemas";

const START_MS = Date.UTC(2026, 8, 1, 0, 0, 0);
const END_MS = Date.UTC(2026, 8, 2, 0, 0, 0);

const totals = {
  requests: 120,
  "successful-requests": 100,
  "failed-requests": 20,
  "input-tokens": 12_000,
  "output-tokens": 2_400,
  "cached-input-tokens": 600,
  "reasoning-tokens": 240,
  "total-tokens": 14_400,
  "total-latency-ms": 14_400,
  "average-latency-ms": 120,
  "estimated-cost-usd": 1.2,
};

const event = (index: number): HistoryEvent => ({
  "event-id": `todo15-${index}`,
  "occurred-at-ms": START_MS + index * 1_000,
  account: "account-alpha",
  provider: "codex",
  model: "gpt-5.6-focused",
  "key-label": "key-focused",
  status: 429,
  succeeded: false,
  "input-tokens": 100 + index,
  "output-tokens": 20 + index,
  "cached-input-tokens": index % 5,
  "reasoning-tokens": index % 3,
  "total-tokens": 120 + index * 2,
  "latency-ms": 50 + index,
  "estimated-cost-usd": index / 1_000,
  "price-version": "2026-09",
});

const page = (start: number, count: number, nextCursor: number | null): HistoryEventsResponse => ({
  events: Array.from({ length: count }, (_, offset) => event(start + offset)),
  "next-cursor": nextCursor,
  totals,
});

const historyStats = { totals, groups: [] };
const historyHealth = {
  ready: true,
  degraded: false,
  "queue-capacity": 1_024,
  "queue-depth": 0,
  "enqueued-events": 120,
  "written-events": 120,
  "dropped-events": 0,
  "database-failures": 0,
  "last-error": null,
};

const localDateTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
};

const renderHistory = (options?: {
  loadHistory?: (query: HistoryStatsQuery) => Promise<HistoryEventsResponse>;
  loadHistoryDetail?: (eventId: string) => Promise<HistoryEvent>;
  countHistory?: (query: HistoryStatsQuery) => Promise<number>;
  clearHistory?: (query: HistoryStatsQuery) => Promise<number>;
  exportHistory?: (format: "csv" | "json", query: HistoryStatsQuery) => Promise<Blob | undefined>;
  onHistoryQuery?: (query: HistoryStatsQuery) => void | Promise<void>;
  records?: readonly Record<string, unknown>[];
  fromMemoryTail?: boolean;
}) =>
  render(
    <DurableLogs
      records={(options?.records ?? []) as never}
      historyStats={historyStats}
      historyHealth={historyHealth}
      loadHistory={options?.loadHistory}
      loadHistoryDetail={options?.loadHistoryDetail}
      countHistory={options?.countHistory}
      clearHistory={options?.clearHistory}
      exportHistory={options?.exportHistory}
      onHistoryQuery={options?.onHistoryQuery}
      fromMemoryTail={options?.fromMemoryTail}
    />,
  );

describe("Todo 15 focused durable Logs contract", () => {
  it("pages bounded history with exact cursor and limit and can return to the previous page", async () => {
    const loadHistory = vi
      .fn<(query: HistoryStatsQuery) => Promise<HistoryEventsResponse>>()
      .mockResolvedValueOnce(page(0, 50, 50))
      .mockResolvedValueOnce(page(50, 50, 100));

    renderHistory({ loadHistory });

    expect(await screen.findByText("todo15-0")).toBeInTheDocument();
    expect(document.querySelectorAll(".history-events-table tbody tr")).toHaveLength(50);
    expect(loadHistory).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 50 }));

    fireEvent.click(screen.getByRole("button", { name: /next history page/i }));
    expect(await screen.findByText("todo15-50")).toBeInTheDocument();
    expect(document.querySelectorAll(".history-events-table tbody tr")).toHaveLength(50);
    expect(loadHistory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 50, limit: 50 }),
    );

    fireEvent.click(screen.getByRole("button", { name: /previous history page/i }));
    expect(await screen.findByText("todo15-0")).toBeInTheDocument();
  });

  it("sends every exact intersecting history filter", async () => {
    const onHistoryQuery = vi.fn();
    const loadHistory = vi.fn(async () => page(0, 20, null));
    renderHistory({ loadHistory, onHistoryQuery });
    await screen.findByText("todo15-0");

    fireEvent.change(screen.getByLabelText("History start"), {
      target: { value: localDateTime(START_MS) },
    });
    fireEvent.change(screen.getByLabelText("History end"), {
      target: { value: localDateTime(END_MS) },
    });
    fireEvent.change(screen.getByLabelText("History account"), {
      target: { value: "account-alpha" },
    });
    fireEvent.change(screen.getByLabelText("History provider"), {
      target: { value: "codex" },
    });
    fireEvent.change(screen.getByLabelText("History model"), {
      target: { value: "gpt-5.6-focused" },
    });
    fireEvent.change(screen.getByLabelText("History inbound key"), {
      target: { value: "key-focused" },
    });
    fireEvent.change(screen.getByLabelText("History status"), { target: { value: "429" } });
    fireEvent.change(screen.getByLabelText("History outcome"), { target: { value: "failed" } });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "todo15-" } });
    fireEvent.change(screen.getByLabelText("Page size"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply history filters" }));

    const expected = {
      startMs: START_MS,
      endMs: END_MS,
      accounts: ["account-alpha"],
      providers: ["codex"],
      models: ["gpt-5.6-focused"],
      keyLabels: ["key-focused"],
      statusCodes: [429],
      outcomes: ["failed"],
      search: "todo15-",
      limit: 25,
    };
    await waitFor(() => expect(onHistoryQuery).toHaveBeenLastCalledWith(expected));
    expect(loadHistory).toHaveBeenLastCalledWith(expected);
  });

  it("loads a selectable request detail", async () => {
    const loadHistory = vi.fn(async () => page(0, 1, null));
    const loadHistoryDetail = vi.fn(async () => ({ ...event(0), "input-tokens": 777 }));
    renderHistory({ loadHistory, loadHistoryDetail });

    fireEvent.click(await screen.findByRole("button", { name: "View todo15-0 details" }));
    const detail = await screen.findByRole("region", { name: "Request detail" });
    expect(loadHistoryDetail).toHaveBeenCalledWith("todo15-0");
    expect(within(detail).getByText("777")).toBeInTheDocument();
  });

  it("requires explicit clear confirmation and reports a post-clear empty result", async () => {
    const loadHistory = vi.fn(async () => page(0, 1, null));
    const countHistory = vi.fn(async () => 1);
    const clearHistory = vi.fn(async () => 1);
    renderHistory({ loadHistory, countHistory, clearHistory });
    await screen.findByText("todo15-0");

    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(clearHistory).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Clear request history" });
    expect(countHistory).toHaveBeenCalledWith(expect.objectContaining({ cursor: null, limit: 50 }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));

    await waitFor(() => expect(clearHistory).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll(".history-events-table tbody tr")).toHaveLength(0);
    expect(document.querySelector('[data-history-clear-deleted="1"]')).not.toBeNull();
  });

  it("offers both CSV and JSON export actions for the selected scope", async () => {
    const exportHistory = vi.fn(async () => undefined);
    renderHistory({ exportHistory });

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));

    await waitFor(() => expect(exportHistory).toHaveBeenCalledTimes(2));
    expect(exportHistory).toHaveBeenNthCalledWith(
      1,
      "csv",
      expect.objectContaining({ cursor: null, limit: 50 }),
    );
    expect(exportHistory).toHaveBeenNthCalledWith(
      2,
      "json",
      expect.objectContaining({ cursor: null, limit: 50 }),
    );
  });

  it("keeps operational memory-tail events visible when file logging is off", () => {
    renderHistory({
      fromMemoryTail: true,
      records: [
        {
          kind: "proxy",
          timestamp: START_MS / 1_000,
          event: "memory_tail_operational_event",
          message: "todo15-memory-tail-sentinel",
        },
      ],
    });

    fireEvent.click(screen.getByRole("tab", { name: "Proxy Logs" }));
    const tail = screen.getByRole("log", { name: "Proxy memory tail" });
    expect(within(tail).getByText("memory_tail_operational_event")).toBeInTheDocument();
    expect(within(tail).getByText("todo15-memory-tail-sentinel")).toBeInTheDocument();
  });
});

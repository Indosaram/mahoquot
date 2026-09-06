import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DurableLogs } from "../components/DurableLogs";
import type { HistoryStatsQuery } from "../lib/api";
import type { HistoryEvent, HistoryEventsResponse } from "../lib/schemas";

const START_MS = Date.UTC(2026, 8, 1, 0, 0, 0);

const totals = {
  requests: 120,
  "successful-requests": 100,
  "failed-requests": 20,
  "input-tokens": 12_000,
  "output-tokens": 2_400,
  "cached-input-tokens": 600,
  "cache-write-tokens": 0,
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
  "cache-write-tokens": 0,
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

const renderHistory = (options?: {
  loadHistory?: (query: HistoryStatsQuery) => Promise<HistoryEventsResponse>;
  loadHistoryDetail?: (eventId: string) => Promise<HistoryEvent>;
  records?: readonly Record<string, unknown>[];
  fromMemoryTail?: boolean;
}) =>
  render(
    <DurableLogs
      records={(options?.records ?? []) as never}
      loadHistory={options?.loadHistory}
      loadHistoryDetail={options?.loadHistoryDetail}
      fromMemoryTail={options?.fromMemoryTail}
    />,
  );

describe("Durable Logs presentation contract", () => {
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

  it("loads a selectable request detail", async () => {
    const loadHistory = vi.fn(async () => page(0, 1, null));
    const loadHistoryDetail = vi.fn(async () => ({ ...event(0), "input-tokens": 777 }));
    renderHistory({ loadHistory, loadHistoryDetail });

    fireEvent.click(await screen.findByRole("button", { name: "View todo15-0 details" }));
    const detail = await screen.findByRole("region", { name: "Request detail" });
    expect(loadHistoryDetail).toHaveBeenCalledWith("todo15-0");
    expect(within(detail).getByText("777")).toBeInTheDocument();
    expect(within(detail).queryByText(/estimated cost/i)).toBeInTheDocument();
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

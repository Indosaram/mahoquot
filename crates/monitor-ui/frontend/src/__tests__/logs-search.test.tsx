import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DurableLogs } from "../components/DurableLogs";
import type { HistoryEvent, HistoryEventsResponse, LogRecord } from "../lib/schemas";

const event = (patch: Partial<HistoryEvent>): HistoryEvent => ({
  "event-id": "req-alpha",
  "occurred-at-ms": 1_788_192_000_000,
  account: "account-a",
  provider: "codex",
  model: "gpt-search",
  "key-label": null,
  status: 200,
  succeeded: true,
  "input-tokens": 10,
  "output-tokens": 20,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "cached-input-tokens-known": false,
  "cache-write-tokens-known": false,
  "reasoning-tokens": 0,
  "total-tokens": 30,
  "latency-ms": 10,
  "estimated-cost-usd": 0,
  "price-version": null,
  ...patch,
});
const events = [
  event({}),
  event({
    "event-id": "req-beta",
    provider: "anthropic",
    model: "claude-search",
    status: 429,
    succeeded: false,
    "total-tokens": 50,
    "latency-ms": 30,
  }),
];
const page = (rows = events, nextCursor: number | null = null): HistoryEventsResponse => ({
  events: rows,
  "next-cursor": nextCursor,
  totals: {
    requests: 100,
    "successful-requests": 80,
    "failed-requests": 20,
    "input-tokens": 1000,
    "output-tokens": 2000,
    "cached-input-tokens": 0,
    "cache-write-tokens": 0,
    "reasoning-tokens": 0,
    "total-tokens": 3000,
    "average-latency-ms": 100,
    "estimated-cost-usd": 0,
  },
});
const search = (query: string) =>
  fireEvent.change(screen.getByRole("searchbox", { name: "Search loaded requests" }), {
    target: { value: query },
  });
const renderHistory = async () => {
  const loadHistory = vi.fn(async () => page());
  await act(async () => {
    render(<DurableLogs records={[]} loadHistory={loadHistory} />);
  });
  return loadHistory;
};
const rowIds = () =>
  within(screen.getByRole("table"))
    .queryAllByRole("button")
    .map((button) => button.textContent);

describe("Logs loaded-page search", () => {
  it.each([
    ["REQ-ALPHA", "req-alpha"],
    ["ANTHROPIC", "req-beta"],
    ["CLAUDE", "req-beta"],
    ["429", "req-beta"],
    ["failed", "req-beta"],
  ])("filters loaded rows by %s without fetching", async (query, expected) => {
    const loadHistory = await renderHistory();
    search(query);
    expect(rowIds()).toEqual([expected]);
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1–1 of 1 matches on this page")).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "Request totals" });
    const total = within(summary).getByText("Total").parentElement;
    expect(total).toHaveTextContent("Total1");
  });

  it("offers query-specific recovery rather than the no-data state", async () => {
    await renderHistory();
    search("missing-request");
    expect(screen.getByText(/No requests match/)).toHaveTextContent("missing-request");
    expect(screen.queryByText("No request records.")).not.toBeInTheDocument();
    expect(rowIds()).toEqual([]);
    expect(screen.getByRole("button", { name: "Clear search" })).toBeEnabled();
  });

  it("clearing restores all loaded rows and server-wide totals", async () => {
    await renderHistory();
    search("claude");
    fireEvent.click(screen.getByRole("button", { name: "Clear log search" }));
    expect(screen.getByRole("searchbox", { name: "Search loaded requests" })).toHaveValue("");
    expect(rowIds()).toEqual(["req-alpha", "req-beta"]);
    expect(screen.queryByRole("button", { name: "Clear log search" })).not.toBeInTheDocument();
    expect(screen.getByText("1–2 of 100")).toBeInTheDocument();
  });

  it("composes with the memory-tail provider filter and preserves tabs and details", () => {
    const records: LogRecord[] = events.map((row) => ({
      kind: "request",
      provider: row.provider,
      model: row.model,
      status: row.status,
      success: row.succeeded,
      "request-id": row["event-id"],
    }));
    render(<DurableLogs records={records} />);
    fireEvent.change(screen.getByLabelText("Log provider filter"), {
      target: { value: "codex" },
    });
    search("claude");
    expect(rowIds()).toEqual([]);
    search("gpt");
    expect(rowIds()).toEqual(["req-alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "View req-alpha details" }));
    expect(screen.getByRole("region", { name: "Request detail" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Proxy Logs" }));
    expect(screen.getByRole("log", { name: "Proxy memory tail" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Requests" }));
    expect(rowIds()).toEqual(["req-alpha"]);
  });

  it("keeps paging available with no matches and resets query counts on later pages", async () => {
    const loadHistory = vi
      .fn<() => Promise<HistoryEventsResponse>>()
      .mockResolvedValueOnce(page(events, 2))
      .mockResolvedValueOnce(page([events[1]]));
    await act(async () => {
      render(<DurableLogs records={[]} loadHistory={loadHistory} />);
    });
    search("claude");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next history page" }));
    });
    expect(screen.getByText("1–1 of 1 matches on this page")).toBeInTheDocument();
    // The KPI strip keeps describing the reported window even while a query is
    // active: a filter must never make 24k requests read as "0".
    const summary = screen.getByRole("region", { name: "Request totals" });
    expect(within(summary).getByText("Tokens").parentElement).toHaveTextContent("Tokens3,000");
    expect(within(summary).getByText("Cache Write").parentElement).toHaveTextContent("Unavailable");
    search("missing-request");
    expect(screen.getByText("0–0 of 0 matches on this page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous history page" }));
    expect(screen.getByRole("button", { name: "Next history page" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear log search" }));
    expect(rowIds()).toEqual(["req-alpha", "req-beta"]);
    expect(screen.getByText("1–2 of 100")).toBeInTheDocument();
  });
});

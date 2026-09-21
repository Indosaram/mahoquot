import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DurableLogs } from "../components/DurableLogs";
import type { HistoryEvent, HistoryEventsResponse, HistoryTotals } from "../lib/schemas";

const baseTotals: HistoryTotals = {
  requests: 2,
  "successful-requests": 2,
  "failed-requests": 0,
  "input-tokens": 200,
  "output-tokens": 40,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 240,
  "average-latency-ms": 20,
  "estimated-cost-usd": 0.2,
};

const baseEvent = (patch: Partial<HistoryEvent> = {}): HistoryEvent => ({
  "event-id": "evt-1",
  "occurred-at-ms": 1_788_192_000_000,
  account: "account-a",
  provider: "codex",
  model: "gpt-5.6",
  "key-label": null,
  status: 200,
  succeeded: true,
  "input-tokens": 100,
  "output-tokens": 20,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 120,
  "latency-ms": 10,
  "estimated-cost-usd": 0.1,
  "price-version": null,
  ...patch,
});

const renderLogs = (page: HistoryEventsResponse) => {
  const loadHistory = vi.fn(async () => page);
  render(<DurableLogs records={[]} loadHistory={loadHistory} />);
  return loadHistory;
};

describe("DurableLogs cache token availability", () => {
  it("shows the summary cache write total as unavailable when no request reported it", async () => {
    renderLogs({
      events: [baseEvent({ "cache-write-tokens-known": false })],
      "next-cursor": null,
      totals: { ...baseTotals, "cache-write-tokens-known-requests": 0 },
    });

    const summary = await screen.findByRole("region", { name: /request totals/i });
    const cell = within(summary).getByText("Cache Write").closest("div") as HTMLElement;
    expect(within(cell).getByText("Unavailable")).toBeInTheDocument();
    expect(within(cell).queryByText("0")).not.toBeInTheDocument();
  });

  it("shows a measured zero cache write total as zero, not unavailable", async () => {
    renderLogs({
      events: [baseEvent({ "cache-write-tokens-known": true })],
      "next-cursor": null,
      totals: {
        ...baseTotals,
        "cache-write-tokens": 0,
        "cache-write-tokens-known-requests": 2,
      },
    });

    const summary = await screen.findByRole("region", { name: /request totals/i });
    const cell = within(summary).getByText("Cache Write").closest("div") as HTMLElement;
    expect(within(cell).getByText("0")).toBeInTheDocument();
    expect(within(cell).queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("marks a partially measured cache write total as covering only part of the requests", async () => {
    renderLogs({
      events: [baseEvent()],
      "next-cursor": null,
      totals: {
        ...baseTotals,
        "cache-write-tokens": 120,
        "cache-write-tokens-known-requests": 1,
      },
    });

    const summary = await screen.findByRole("region", { name: /request totals/i });
    const cell = within(summary).getByText("Cache Write").closest("div") as HTMLElement;
    expect(within(cell).getByText("120")).toBeInTheDocument();
    expect(within(cell).getByText("1 of 2 requests")).toBeInTheDocument();
  });

  it("reports an unavailable cache write value in the request detail instead of a fake zero", async () => {
    const event = baseEvent({
      "event-id": "evt-unknown-cache",
      "cache-write-tokens": 0,
      "cache-write-tokens-known": false,
    });
    const loadHistoryDetail = vi.fn(async () => event);
    const loadHistory = vi.fn(async () => ({
      events: [event],
      "next-cursor": null,
      totals: baseTotals,
    }));
    render(
      <DurableLogs records={[]} loadHistory={loadHistory} loadHistoryDetail={loadHistoryDetail} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /view evt-unknown-cache details/i }));

    const detail = await screen.findByRole("region", { name: /request detail/i });
    const writeRow = within(detail).getByText("Cache write tokens").closest("div") as HTMLElement;
    expect(within(writeRow).getByText("Unavailable")).toBeInTheDocument();
  });

  it("shows a measured zero cache write value in the request detail", async () => {
    const event = baseEvent({
      "event-id": "evt-known-zero-cache",
      "cache-write-tokens": 0,
      "cache-write-tokens-known": true,
    });
    const loadHistoryDetail = vi.fn(async () => event);
    const loadHistory = vi.fn(async () => ({
      events: [event],
      "next-cursor": null,
      totals: baseTotals,
    }));
    render(
      <DurableLogs records={[]} loadHistory={loadHistory} loadHistoryDetail={loadHistoryDetail} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /view evt-known-zero-cache details/i }),
    );

    const detail = await screen.findByRole("region", { name: /request detail/i });
    const writeRow = within(detail).getByText("Cache write tokens").closest("div") as HTMLElement;
    expect(within(writeRow).getByText("0")).toBeInTheDocument();
    expect(within(writeRow).queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("reports cache totals as unavailable when synthesized from the in-memory tail", () => {
    render(
      <DurableLogs
        records={[
          {
            kind: "request",
            timestamp: 1_788_192_000,
            provider: "codex",
            account: "account-a",
            model: "gpt-5.6",
            status: 200,
            success: true,
            tokens: 42,
            "latency-ms": 12,
            "request-id": "tail-1",
          },
        ]}
        fromMemoryTail
      />,
    );

    const summary = screen.getByRole("region", { name: /request totals/i });
    const cell = within(summary).getByText("Cache Write").closest("div") as HTMLElement;
    expect(within(cell).getByText("Unavailable")).toBeInTheDocument();
  });
});

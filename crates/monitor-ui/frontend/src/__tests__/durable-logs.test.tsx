import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DurableLogs, type DurableLogsProps } from "../components/DurableLogs";

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

const durableEvents = [
  {
    "event-id": "req-success",
    "occurred-at-ms": 1_788_192_000_000,
    account: "account-a",
    provider: "codex",
    model: "gpt-5.6-sol",
    "key-label": "key-prod",
    status: 200,
    succeeded: true,
    "input-tokens": 90,
    "output-tokens": 30,
    "cached-input-tokens": 0,
    "reasoning-tokens": 0,
    "total-tokens": 120,
    "latency-ms": 87,
    "estimated-cost-usd": 0.3,
    "price-version": "2026-09",
  },
  {
    "event-id": "req-failed",
    "occurred-at-ms": 1_788_192_060_000,
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
  },
] as const;

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

const renderLogs = (overrides: Partial<DurableLogsProps> = {}) => {
  const loadHistory = vi.fn(async () => ({
    events: durableEvents as never,
    "next-cursor": 2,
    totals,
  }));
  const loadHistoryDetail = vi.fn(async () => ({
    ...durableEvents[1],
    "estimated-cost-usd": 0.12,
    "price-version": "2026-09",
  }));
  render(
    <DurableLogs
      records={requestRecords as never}
      loadHistory={loadHistory}
      loadHistoryDetail={loadHistoryDetail}
      {...overrides}
    />,
  );
  return { loadHistory, loadHistoryDetail };
};

describe("Durable logs surface", () => {
  it("pages durable history through the provider filter and cursor", async () => {
    const { loadHistory } = renderLogs();

    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith({ limit: 50 }));
    expect(await screen.findByText("req-success")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Log provider filter"), {
      target: { value: "codex" },
    });
    await waitFor(() =>
      expect(loadHistory).toHaveBeenLastCalledWith({ providers: ["codex"], limit: 50 }),
    );

    const next = await screen.findByRole("button", { name: /next history page/i });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    await waitFor(() =>
      expect(loadHistory).toHaveBeenLastCalledWith({
        providers: ["codex"],
        limit: 50,
        cursor: 2,
      }),
    );

    const summary = screen.getByRole("region", { name: /request totals/i });
    expect(within(summary).getByText("Total")).toBeInTheDocument();
    expect(within(summary).getByText("150")).toBeInTheDocument();
  });


  it("keeps a provider-filtered page when a slower background request resolves late", async () => {
    const staleGate = Promise.withResolvers<void>();
    const loadHistory = vi.fn(async (query: { providers?: string[] }) => {
      if (query.providers?.[0] === "anthropic") {
        return { events: [{"event-id":"FRESH-ANTHROPIC","occurred-at-ms":1_788_192_000_000,account:"acct","provider":"anthropic","model":"claude","key-label":"k",status:200,succeeded:true,"input-tokens":1,"output-tokens":1,"cached-input-tokens":0,"reasoning-tokens":0,"total-tokens":2,"latency-ms":5,"estimated-cost-usd":0.1,"price-version":"2026-09"}] as never, "next-cursor": null, totals };
      }
      if (loadHistory.mock.calls.length > 1) {
        await staleGate.promise;
        return { events: [{"event-id":"STALE-ALL","occurred-at-ms":1_788_192_000_000,account:"acct","provider":"codex","model":"gpt","key-label":"k",status:200,succeeded:true,"input-tokens":1,"output-tokens":1,"cached-input-tokens":0,"reasoning-tokens":0,"total-tokens":2,"latency-ms":5,"estimated-cost-usd":0.1,"price-version":"2026-09"}] as never, "next-cursor": 9, totals };
      }
      return { events: durableEvents as never, "next-cursor": 2, totals };
    });
    const { rerender } = render(
      <DurableLogs records={requestRecords as never} loadHistory={loadHistory as never} liveTick={0} />,
    );
    expect(await screen.findByText("req-success")).toBeInTheDocument();

    rerender(
      <DurableLogs records={requestRecords as never} loadHistory={loadHistory as never} liveTick={1} />,
    );
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText("Log provider filter"), {
      target: { value: "anthropic" },
    });
    expect(await screen.findByText("FRESH-ANTHROPIC")).toBeInTheDocument();

    staleGate.resolve();
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText("STALE-ALL")).not.toBeInTheDocument();
    expect(screen.getByText("FRESH-ANTHROPIC")).toBeInTheDocument();
  });

  it("opens the request detail view without cost or eyebrow decoration", async () => {
    const { loadHistoryDetail } = renderLogs();

    fireEvent.click(await screen.findByRole("button", { name: /view req-failed details/i }));

    const detail = await screen.findByRole("region", { name: /request detail/i });
    expect(loadHistoryDetail).toHaveBeenCalledWith("req-failed");
    expect(within(detail).getByText("req-failed")).toBeInTheDocument();
    expect(within(detail).getByText("account-b")).toBeInTheDocument();
    expect(within(detail).getByText("claude-sonnet-4-5")).toBeInTheDocument();
    expect(screen.queryByText(/REQUEST LEDGER/i)).not.toBeInTheDocument();
  });

  it("falls back to the in-memory tail with a client-side provider filter", () => {
    renderLogs({ loadHistory: undefined });

    expect(screen.getByText("req-success")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Log provider filter"), {
      target: { value: "anthropic" },
    });
    expect(screen.queryByText("req-success")).not.toBeInTheDocument();
    expect(screen.getByText("req-failed")).toBeInTheDocument();
  });

  it("keeps memory-tail operational events visible when file logging is off", () => {
    renderLogs({
      loadHistory: undefined,
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

describe("DurableLogs stale response ordering", () => {
  it("does not let a slow earlier request overwrite a newer one", async () => {
    // The initial load and the liveTick refresh both call loadHistory. Without a
    // sequencing guard the slower FIRST response lands last and overwrites the
    // newer page, showing operators stale rows that never self-correct.
    const staleEvent = {
      ...durableEvents[0],
      "event-id": "stale-row",
      model: "STALE-MODEL",
    };
    const freshEvent = {
      ...durableEvents[0],
      "event-id": "fresh-row",
      model: "FRESH-MODEL",
    };

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let call = 0;
    const loadHistory = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await firstGate;
        return { events: [staleEvent] as never, "next-cursor": null, totals };
      }
      return { events: [freshEvent] as never, "next-cursor": null, totals };
    });

    const view = render(
      <DurableLogs
        records={[] as never}
        loadHistory={loadHistory}
        loadHistoryDetail={vi.fn()}
      />,
    );

    // The newer refresh resolves first.
    view.rerender(
      <DurableLogs
        records={[] as never}
        loadHistory={loadHistory}
        loadHistoryDetail={vi.fn()}
        liveTick={1}
      />,
    );
    await waitFor(() => expect(screen.getByText("FRESH-MODEL")).toBeTruthy());

    // Now the original, older request finally resolves.
    releaseFirst?.();
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));

    await waitFor(() => {
      expect(
        screen.queryByText("STALE-MODEL"),
        "a slower earlier response overwrote the newer page",
      ).toBeNull();
    });
    expect(screen.getByText("FRESH-MODEL")).toBeTruthy();
  });
});

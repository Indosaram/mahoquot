import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewBreakdownTable } from "../components/OverviewBreakdownTable";
import type { BreakdownRow, OverviewAnalytics } from "../lib/overview-analytics";

const makeRow = (overrides: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key: "row-1",
  label: "Anthropic Claude 3.5 Sonnet",
  provider: "claude",
  requests: 1200,
  successes: 1150,
  failures: 50,
  inputTokens: 45000,
  outputTokens: 15000,
  totalTokens: 60000,
  avgLatencyMs: 350,
  costUsd: 0,
  share: 0.5,
  isOther: false,
  isUnlinked: false,
  ...overrides,
});

const makeAnalytics = (overrides: Partial<OverviewAnalytics> = {}): OverviewAnalytics => ({
  source: "history",
  dimension: "model",
  metric: "requests",
  range: "1d",
  bucketMs: 3600000,
  totals: {
    requests: 2500,
    successes: 2420,
    failures: 80,
    inputTokens: 80000,
    outputTokens: 26000,
    totalTokens: 106000,
    avgLatencyMs: 320,
    costUsd: 0,
  },
  rows: [
    makeRow({
      key: "anthropic/claude-3-5-sonnet",
      label: "Claude 3.5 Sonnet",
      provider: "claude",
      requests: 1200,
      successes: 1150,
      failures: 50,
      inputTokens: 45000,
      outputTokens: 15000,
      totalTokens: 60000,
      avgLatencyMs: 350,
    }),
    makeRow({
      key: "openai/gpt-4o",
      label: "GPT-4o",
      provider: "openai",
      requests: 800,
      successes: 780,
      failures: 20,
      inputTokens: 25000,
      outputTokens: 8000,
      totalTokens: 33000,
      avgLatencyMs: 280,
    }),
    makeRow({
      key: "google/gemini-1-5-pro",
      label: "Gemini 1.5 Pro",
      provider: "google",
      requests: 500,
      successes: 490,
      failures: 10,
      inputTokens: 10000,
      outputTokens: 3000,
      totalTokens: 13000,
      avgLatencyMs: 400,
    }),
  ],
  series: [],
  seriesKeys: ["anthropic/claude-3-5-sonnet", "openai/gpt-4o", "google/gemini-1-5-pro"],
  hasCostData: false,
  isTokenPartial: false,
  supportsModelDimension: true,
  ...overrides,
});

describe("OverviewBreakdownTable", () => {
  it("renders three rows with labels and compact numbers, and Total cell title carries the exact integer string", () => {
    const analytics = makeAnalytics();
    render(<OverviewBreakdownTable analytics={analytics} />);

    expect(screen.getByRole("heading", { level: 2, name: "Usage breakdown" })).toBeInTheDocument();
    expect(screen.getByText("1d")).toBeInTheDocument();

    expect(screen.getByText("Claude 3.5 Sonnet")).toBeInTheDocument();
    expect(screen.getByText("GPT-4o")).toBeInTheDocument();
    expect(screen.getByText("Gemini 1.5 Pro")).toBeInTheDocument();

    expect(screen.getByText("1.2K")).toBeInTheDocument();
    expect(screen.getByText("45K")).toBeInTheDocument();
    expect(screen.getByText("15K")).toBeInTheDocument();
    expect(screen.getByText("60K")).toBeInTheDocument();

    const totalCell = screen.getByTitle("60,000");
    expect(totalCell).toBeInTheDocument();
    expect(totalCell).toHaveTextContent("60K");

    expect(screen.getByTitle("33,000")).toBeInTheDocument();
    expect(screen.getByTitle("13,000")).toBeInTheDocument();
  });

  it("hasCostData false hides the Cost column; true shows it", () => {
    const { rerender } = render(
      <OverviewBreakdownTable analytics={makeAnalytics({ hasCostData: false })} />,
    );
    expect(screen.queryByRole("columnheader", { name: "Cost" })).not.toBeInTheDocument();

    rerender(
      <OverviewBreakdownTable
        analytics={makeAnalytics({
          hasCostData: true,
          rows: [
            makeRow({
              key: "row-cost",
              label: "Paid Model",
              costUsd: 12.34,
            }),
          ],
        })}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Cost" })).toBeInTheDocument();
    expect(screen.getByText("$12.34")).toBeInTheDocument();
  });

  it("isTokenPartial true prefixes the total with '~' and renders the Partial badge", () => {
    render(
      <OverviewBreakdownTable
        analytics={makeAnalytics({
          isTokenPartial: true,
        })}
      />,
    );

    const badge = screen.getByText("Partial");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("overview-token-partial-badge");

    expect(screen.getByText("~60K")).toBeInTheDocument();
    expect(screen.getByText("~33K")).toBeInTheDocument();
    expect(screen.getByText("~13K")).toBeInTheDocument();
  });

  it("ten rows with default maxRows show 8 rows plus a 'Show all' button, and clicking it reveals all ten", () => {
    const tenRows = Array.from({ length: 10 }, (_, i) =>
      makeRow({
        key: `row-${i}`,
        label: `Model ${i + 1}`,
        requests: 100 * (10 - i),
        totalTokens: 1000 * (10 - i),
      }),
    );

    render(<OverviewBreakdownTable analytics={makeAnalytics({ rows: tenRows })} />);

    expect(screen.getAllByRole("row")).toHaveLength(9);
    expect(screen.getByText("Model 1")).toBeInTheDocument();
    expect(screen.getByText("Model 8")).toBeInTheDocument();
    expect(screen.queryByText("Model 9")).not.toBeInTheDocument();
    expect(screen.queryByText("Model 10")).not.toBeInTheDocument();

    const showAllBtn = screen.getByRole("button", { name: "Show all" });
    expect(showAllBtn).toBeInTheDocument();

    fireEvent.click(showAllBtn);
    expect(screen.getAllByRole("row")).toHaveLength(11);
    expect(screen.getByText("Model 9")).toBeInTheDocument();
    expect(screen.getByText("Model 10")).toBeInTheDocument();

    const showFewerBtn = screen.getByRole("button", { name: "Show fewer" });
    expect(showFewerBtn).toBeInTheDocument();

    fireEvent.click(showFewerBtn);
    expect(screen.getAllByRole("row")).toHaveLength(9);
    expect(screen.queryByText("Model 9")).not.toBeInTheDocument();
  });

  it("renders 'Unlinked' text when row has isUnlinked true", () => {
    render(
      <OverviewBreakdownTable
        analytics={makeAnalytics({
          rows: [
            makeRow({
              key: "unlinked-account",
              label: "cline-oauth · 783d9565…",
              isUnlinked: true,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("Unlinked")).toBeInTheDocument();
    expect(screen.getByText("cline-oauth · 783d9565…")).toBeInTheDocument();
  });

  it("renders semantic table with the required scope='col' headers", () => {
    render(<OverviewBreakdownTable analytics={makeAnalytics()} />);

    const table = screen.getByRole("table", { name: "Usage breakdown" });
    expect(table).toBeInTheDocument();

    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(7);
    expect(headers[0]).toHaveTextContent("Name");
    expect(headers[1]).toHaveTextContent("Requests");
    expect(headers[2]).toHaveTextContent("Success");
    expect(headers[3]).toHaveTextContent("Input");
    expect(headers[4]).toHaveTextContent("Output");
    expect(headers[5]).toHaveTextContent("Total");
    expect(headers[6]).toHaveTextContent("Avg latency");

    for (const h of headers) {
      expect(h).toHaveAttribute("scope", "col");
    }
  });

  it("renders success as percentage with 1 decimal and '—' when requests is 0", () => {
    render(
      <OverviewBreakdownTable
        analytics={makeAnalytics({
          rows: [
            makeRow({
              key: "row-active",
              label: "Active Model",
              requests: 1000,
              successes: 995,
            }),
            makeRow({
              key: "row-idle",
              label: "Idle Model",
              requests: 0,
              successes: 0,
              avgLatencyMs: 0,
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("99.5%")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("renders 'No usage in this window' when rows is empty", () => {
    render(<OverviewBreakdownTable analytics={makeAnalytics({ rows: [] })} />);

    expect(screen.getByText("No usage in this window")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

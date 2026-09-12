import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewBreakdownTable } from "../components/OverviewBreakdownTable";
import { OverviewDashboard } from "../components/OverviewDashboard";
import type { NormalizedAccount } from "../lib/accounts";
import type { OverviewAnalytics } from "../lib/overview-analytics";
import type { AdminStats } from "../lib/schemas";
import { appendTelemetrySample, persistedTelemetrySamples } from "../lib/telemetry";

const stats = {
  uptime_secs: 3600,
  in_flight: 2,
  served: 10,
  failed_over: 0,
  refreshed: 0,
  ttft: { p50_ms: 120, p90_ms: 250, p99_ms: 500, samples: 10 },
  accounts: [],
} as unknown as AdminStats;

const account = {
  id: "acc-1",
  label: "Team Prod",
  provider: "openai",
  email: "test@example.com",
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  runtimeId: "acc-1",
  isCredentialOnly: false,
} as unknown as NormalizedAccount;

const createMockAnalytics = (overrides: Partial<OverviewAnalytics> = {}): OverviewAnalytics => ({
  source: "history",
  dimension: "account",
  metric: "tokens",
  range: "1d",
  bucketMs: 3600000,
  totals: {
    requests: 10,
    successes: 10,
    failures: 0,
    inputTokens: 50_000,
    outputTokens: 12_000,
    totalTokens: 62_000,
    avgLatencyMs: 120,
    costUsd: 0,
  },
  rows: [
    {
      key: "acc-1",
      label: "Team Prod",
      provider: "openai",
      requests: 10,
      successes: 10,
      failures: 0,
      inputTokens: 50_000,
      outputTokens: 12_000,
      totalTokens: 62_000,
      avgLatencyMs: 120,
      costUsd: 0,
      share: 1,
      isOther: false,
      isUnlinked: false,
    },
  ],
  series: [
    {
      startMs: Date.now() - 3600000,
      total: 62000,
      values: { "acc-1": 62000 },
    },
  ],
  seriesKeys: ["acc-1"],
  hasCostData: false,
  isTokenPartial: false,
  supportsModelDimension: true,
  ...overrides,
});

describe("Overview breakdown token semantics (migrated to OverviewBreakdownTable)", () => {
  it("renders total tokens and account breakdown correctly", () => {
    const analytics = createMockAnalytics({
      rows: [
        {
          key: "acc-1",
          label: "Team Prod",
          provider: "openai",
          requests: 10,
          successes: 10,
          failures: 0,
          inputTokens: 50_000,
          outputTokens: 12_000,
          totalTokens: 62_000,
          avgLatencyMs: 120,
          costUsd: 0,
          share: 1,
          isOther: false,
          isUnlinked: false,
        },
      ],
    });

    render(<OverviewBreakdownTable analytics={analytics} />);

    expect(screen.getByRole("heading", { name: "Usage breakdown" })).toBeInTheDocument();
    expect(screen.getByText("50K")).toBeInTheDocument();
    expect(screen.getByText("12K")).toBeInTheDocument();
    expect(screen.getByText("62K")).toBeInTheDocument();
    expect(screen.getByText("Team Prod")).toBeInTheDocument();
  });

  it("renders semantic table with proper table headers and column scopes", () => {
    const analytics = createMockAnalytics();
    render(<OverviewBreakdownTable analytics={analytics} />);

    const table = screen.getByRole("table", { name: "Usage breakdown" });
    expect(table).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader");
    expect(headers.length).toBeGreaterThanOrEqual(4);
    expect(headers[0]).toHaveTextContent("Name");
    expect(headers[3]).toHaveTextContent("Input");
    expect(headers[4]).toHaveTextContent("Output");
    expect(headers[5]).toHaveTextContent("Total");
    for (const h of headers) {
      expect(h).toHaveAttribute("scope", "col");
    }
  });

  it("R3 regression: renders unavailable state when hasTokenData is false", () => {
    const analytics = createMockAnalytics({
      rows: [],
    });
    render(<OverviewBreakdownTable analytics={analytics} />);

    expect(screen.getByText("No usage in this window")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("R3 regression: renders zero tokens when hasTokenData is true and activity is 0", () => {
    const analytics = createMockAnalytics({
      rows: [
        {
          key: "acc-1",
          label: "Team Prod",
          provider: "openai",
          requests: 0,
          successes: 0,
          failures: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          avgLatencyMs: 0,
          costUsd: 0,
          share: 0,
          isOther: false,
          isUnlinked: false,
        },
      ],
    });
    render(<OverviewBreakdownTable analytics={analytics} />);

    expect(screen.getByText("Team Prod")).toBeInTheDocument();
    expect(screen.getAllByText("0")).toHaveLength(4); // Requests, Input, Output, Total
    expect(screen.getAllByText("—")).toHaveLength(2); // Success, Avg latency
  });

  it("R3 regression: renders message when total tokens exist but account breakdown is empty", () => {
    const analytics = createMockAnalytics({
      totals: {
        requests: 5,
        successes: 5,
        failures: 0,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        avgLatencyMs: 0,
        costUsd: 0,
      },
      rows: [
        {
          key: "__other__",
          label: "Other",
          provider: "other",
          requests: 5,
          successes: 5,
          failures: 0,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          avgLatencyMs: 0,
          costUsd: 0,
          share: 1,
          isOther: true,
          isUnlinked: false,
        },
      ],
    });
    render(<OverviewBreakdownTable analytics={analytics} />);

    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
  });

  it("R3 regression: renders unclassified row when account totals do not sum to total tokens", () => {
    const analytics = createMockAnalytics({
      totals: {
        requests: 7,
        successes: 7,
        failures: 0,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        avgLatencyMs: 0,
        costUsd: 0,
      },
      rows: [
        {
          key: "acc-1",
          label: "Team Prod",
          provider: "openai",
          requests: 5,
          successes: 5,
          failures: 0,
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
          avgLatencyMs: 0,
          costUsd: 0,
          share: 100 / 150,
          isOther: false,
          isUnlinked: false,
        },
        {
          key: "__other__",
          label: "Other",
          provider: "other",
          requests: 2,
          successes: 2,
          failures: 0,
          inputTokens: 20,
          outputTokens: 30,
          totalTokens: 50,
          avgLatencyMs: 0,
          costUsd: 0,
          share: 50 / 150,
          isOther: true,
          isUnlinked: false,
        },
      ],
    });
    render(<OverviewBreakdownTable analytics={analytics} />);

    expect(screen.getByText("Team Prod")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
    const unclassifiedRow = document.querySelector(".overview-token-row-unclassified");
    expect(unclassifiedRow).toBeInTheDocument();
    expect(within(unclassifiedRow as HTMLElement).getByText("50")).toBeInTheDocument();
  });

  it("R6 regression: renders em dash for unknown account token fields and partial total", () => {
    const analytics = createMockAnalytics({
      isTokenPartial: true,
      rows: [
        {
          key: "acc-1",
          label: "Team Prod",
          provider: "openai",
          requests: 0,
          successes: 0,
          failures: 0,
          inputTokens: 100,
          outputTokens: 0,
          totalTokens: 100,
          avgLatencyMs: 0,
          costUsd: 0,
          share: 1,
          isOther: false,
          isUnlinked: false,
        },
      ],
    });
    render(<OverviewBreakdownTable analytics={analytics} />);

    expect(screen.getByText("Team Prod")).toBeInTheDocument();
    expect(screen.getByText("Partial")).toBeInTheDocument();
    expect(screen.getByText("~100")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2); // Success and Avg latency
  });
});

describe("OverviewDashboard unified filtering", () => {
  it("calls onRangeChange when user switches the range filter", () => {
    const onRangeChange = vi.fn();
    const samples = persistedTelemetrySamples([
      {
        minute_unix: Math.floor(Date.now() / 1000) - 60,
        requests: 5,
        successes: 5,
        failures: 0,
        input_tokens: 1_000,
        output_tokens: 200,
        providers: [{ provider: "openai", requests: 5, successes: 5, failures: 0 }],
        accounts: [
          {
            account: "acc-1",
            requests: 5,
            successes: 5,
            failures: 0,
            input_tokens: 1_000,
            output_tokens: 200,
          },
        ],
      },
    ]);

    render(
      <OverviewDashboard
        stats={stats}
        samples={samples}
        accounts={[account]}
        range="1d"
        onRangeChange={onRangeChange}
      />,
    );

    const radio7d = screen.getByRole("radio", { name: "7d" });
    fireEvent.click(radio7d);
    expect(onRangeChange).toHaveBeenCalledWith("7d");
  });

  it("renders 0 tokens and no activity message when history is supported but empty", () => {
    render(
      <OverviewDashboard
        stats={{ ...stats, history: [] }}
        samples={[]}
        accounts={[account]}
        range="1h"
        asOfMs={Date.now()}
      />,
    );

    const usageSection = screen.getByRole("region", { name: "Usage breakdown" });
    expect(within(usageSection).getByText("No usage in this window")).toBeInTheDocument();
    const kpis = document.querySelector(".minimal-kpis") as HTMLElement;
    expect(within(kpis).getAllByText("0")).toHaveLength(2);
  });

  it("renders unavailable when samples has requests but no token telemetry fields", () => {
    const samplesWithoutTokens = persistedTelemetrySamples([
      {
        minute_unix: Math.floor(Date.now() / 1000) - 60,
        requests: 5,
        successes: 5,
        failures: 0,
        // no input_tokens, no output_tokens
        providers: [],
        accounts: [],
      },
    ]);

    render(
      <OverviewDashboard
        stats={{ ...stats, history: undefined }}
        samples={samplesWithoutTokens}
        accounts={[account]}
        range="1h"
        asOfMs={Date.now()}
      />,
    );

    const usageSection = screen.getByRole("region", { name: "Usage breakdown" });
    expect(within(usageSection).getByText("No usage in this window")).toBeInTheDocument();
    const kpis = document.querySelector(".minimal-kpis") as HTMLElement;
    expect(within(kpis).getByText("5")).toBeInTheDocument();
  });

  it("renders unavailable when window has requests but none have token fields even if older history has tokens", () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    const twoMinutesAgo = Math.floor(Date.now() / 1000) - 120;
    const samples = persistedTelemetrySamples([
      {
        minute_unix: twoHoursAgo,
        requests: 5,
        successes: 5,
        failures: 0,
        input_tokens: 100,
        output_tokens: 20,
        providers: [],
        accounts: [],
      },
      {
        minute_unix: twoMinutesAgo,
        requests: 1,
        successes: 1,
        failures: 0,
        // no tokens
        providers: [],
        accounts: [],
      },
    ]);

    render(
      <OverviewDashboard
        stats={stats}
        samples={samples}
        accounts={[account]}
        range="1h"
        asOfMs={Date.now()}
      />,
    );

    const usageSection = screen.getByRole("region", { name: "Usage breakdown" });
    expect(within(usageSection).getByText("No usage in this window")).toBeInTheDocument();
    const kpis = document.querySelector(".minimal-kpis") as HTMLElement;
    expect(within(kpis).getByText("1")).toBeInTheDocument();
  });

  it("P2 regression: active interval without tokens followed by idle rebaseline zero renders unavailable, not no-activity", () => {
    const twoMinutesAgo = Math.floor(Date.now() / 1000) - 120;
    const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60;
    const samples = persistedTelemetrySamples([
      {
        minute_unix: twoMinutesAgo,
        requests: 1,
        successes: 1,
        failures: 0,
        // no tokens for this active request
        providers: [],
        accounts: [],
      },
      {
        minute_unix: oneMinuteAgo,
        requests: 0,
        successes: 0,
        failures: 0,
        input_tokens: 0,
        output_tokens: 0, // idle rebaseline
        providers: [],
        accounts: [],
      },
    ]);

    render(
      <OverviewDashboard
        stats={stats}
        samples={samples}
        accounts={[account]}
        range="1h"
        asOfMs={Date.now()}
      />,
    );

    const usageSection = screen.getByRole("region", { name: "Usage breakdown" });
    expect(within(usageSection).getByText("Partial")).toBeInTheDocument();
  });

  it("P2 regression: carries per-field availability into empty-window fallback instead of inventing output support", () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    const historySamples = persistedTelemetrySamples([
      {
        minute_unix: twoHoursAgo,
        requests: 1,
        successes: 1,
        failures: 0,
        input_tokens: 100,
        // no output tokens ever provided
        providers: [],
        accounts: [],
      },
    ]);

    render(
      <OverviewDashboard
        stats={{ ...stats, history: undefined }}
        samples={historySamples}
        accounts={[account]}
        range="30m" // 30m window is empty
        asOfMs={Date.now()}
      />,
    );

    const usageSection = screen.getByRole("region", { name: "Usage breakdown" });
    expect(within(usageSection).getByText("No usage in this window")).toBeInTheDocument();
    const kpis = document.querySelector(".minimal-kpis") as HTMLElement;
    expect(within(kpis).getAllByText("0")).toHaveLength(2);
  });

  it("P2 regression: mixed active/idle polling case renders unavailable when active account is unmeasured", () => {
    // Account A: 1 request, unmeasured tokens (undefined)
    // Account B: 0 requests, measured zero delta (0)
    const s1: AdminStats = {
      uptime_secs: 10,
      in_flight: 0,
      served: 0,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        { id: "a", provider: "openai", health: "healthy", ok: 0, fails: 0 },
        {
          id: "b",
          provider: "anthropic",
          health: "healthy",
          ok: 0,
          fails: 0,
          input_tokens: 100,
          output_tokens: 50,
        },
      ],
    };
    const s2: AdminStats = {
      uptime_secs: 20,
      in_flight: 0,
      served: 1,
      failed_over: 0,
      refreshed: 0,
      accounts: [
        { id: "a", provider: "openai", health: "healthy", ok: 1, fails: 0 }, // 1 request, no tokens
        {
          id: "b",
          provider: "anthropic",
          health: "healthy",
          ok: 0,
          fails: 0,
          input_tokens: 100,
          output_tokens: 50,
        }, // 0 requests, delta 0
      ],
    };
    const p1 = appendTelemetrySample([], s1, 1_000);
    const p2 = appendTelemetrySample(p1, s2, 2_000);

    render(
      <OverviewDashboard
        stats={s2}
        samples={p2}
        accounts={[
          { id: "a", provider: "openai", status: "ok" } as unknown as NormalizedAccount,
          { id: "b", provider: "anthropic", status: "ok" } as unknown as NormalizedAccount,
        ]}
        range="1h"
        asOfMs={2_500}
      />,
    );

    const usageSection = screen.getByRole("region", { name: "Usage breakdown" });
    expect(within(usageSection).getByText("Partial")).toBeInTheDocument();
  });

  it("P2 regression: account-only persisted bucket with idle zero account renders unavailable when active account has no tokens", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 1,
        successes: 1,
        failures: 0,
        // no bucket-level tokens
        providers: [],
        accounts: [
          { account: "a", requests: 1, successes: 1, failures: 0 }, // active, no tokens
          {
            account: "b",
            requests: 0,
            successes: 0,
            failures: 0,
            input_tokens: 0,
            output_tokens: 0,
          }, // idle zero
        ],
      },
    ]);

    render(
      <OverviewDashboard
        stats={{ ...stats, history: undefined }}
        samples={samples}
        accounts={[
          { id: "a", provider: "openai", status: "ok" } as unknown as NormalizedAccount,
          { id: "b", provider: "anthropic", status: "ok" } as unknown as NormalizedAccount,
        ]}
        range="1h"
        asOfMs={1_800 * 1000 + 1000}
      />,
    );

    const usageSection = screen.getByRole("region", { name: "Usage breakdown" });
    expect(within(usageSection).getByText("Partial")).toBeInTheDocument();
  });

  it("P2 control: authoritative server zero totals render measured zeros, not unavailable", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 1,
        successes: 1,
        failures: 0,
        input_tokens: 0,
        output_tokens: 0, // authoritative server zeros
        providers: [],
        accounts: [
          { account: "a", requests: 1, successes: 1, failures: 0 }, // account token fields omitted to isolate authoritative server branch
        ],
      },
    ]);

    render(
      <OverviewDashboard
        stats={{ ...stats, history: undefined }}
        samples={samples}
        accounts={[{ id: "a", provider: "openai", status: "ok" } as unknown as NormalizedAccount]}
        range="1h"
        asOfMs={1_800 * 1000 + 1000}
      />,
    );

    const usageSection = screen.getByRole("region", { name: "Usage breakdown" });
    expect(within(usageSection).queryByText("Partial")).not.toBeInTheDocument();
    expect(within(usageSection).queryByText("~0")).not.toBeInTheDocument();
  });

  it("P2 control: genuinely measured zero-token active request renders measured zeros", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: 1_800,
        requests: 1,
        successes: 1,
        failures: 0,
        // account-only derivation
        providers: [],
        accounts: [
          {
            account: "a",
            requests: 1,
            successes: 1,
            failures: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        ],
      },
    ]);

    render(
      <OverviewDashboard
        stats={{ ...stats, history: undefined }}
        samples={samples}
        accounts={[{ id: "a", provider: "openai", status: "ok" } as unknown as NormalizedAccount]}
        dimension="account"
        range="1h"
        asOfMs={1_800 * 1000 + 1000}
      />,
    );

    const usageSection = screen.getByRole("region", { name: "Usage breakdown" });
    expect(within(usageSection).queryByText("Partial")).not.toBeInTheDocument();
    expect(within(usageSection).queryByText("~0")).not.toBeInTheDocument();
    const row = within(usageSection).getByRole("row", { name: /\ba\b/ });
    expect(within(row).getAllByTitle("0").length).toBeGreaterThanOrEqual(1);
  });
});

describe("OverviewDashboard recomposition and token breakdown", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders compact token formatting, exact-value titles, and per-account row label via OverviewDashboard composition", () => {
    render(
      <OverviewDashboard
        stats={stats}
        samples={[]}
        accounts={[account]}
        analytics={createMockAnalytics()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Usage breakdown" })).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Usage breakdown" });
    expect(within(table).getByText("Team Prod")).toBeInTheDocument();

    expect(within(table).getByText("50K")).toBeInTheDocument();
    expect(within(table).getByText("12K")).toBeInTheDocument();
    expect(within(table).getByText("62K")).toBeInTheDocument();

    expect(within(table).getByTitle("50,000")).toBeInTheDocument();
    expect(within(table).getByTitle("12,000")).toBeInTheDocument();
    expect(within(table).getByTitle("62,000")).toBeInTheDocument();
  });

  it("renders partial '~' behavior and badge when isTokenPartial is true", () => {
    render(
      <OverviewDashboard
        stats={stats}
        samples={[]}
        accounts={[account]}
        analytics={createMockAnalytics({ isTokenPartial: true })}
      />,
    );

    const badge = screen.getByText("Partial");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass("overview-token-partial-badge");

    const table = screen.getByRole("table", { name: "Usage breakdown" });
    expect(within(table).getByText("~62K")).toBeInTheDocument();
  });

  it("clicking the 'Model' radio persists 'model' to localStorage key 'mahoquot.overview.dimension' and changes the mix heading to 'Model mix'", () => {
    render(<OverviewDashboard stats={stats} samples={[]} accounts={[account]} />);

    expect(screen.getByRole("heading", { name: "Provider mix" })).toBeInTheDocument();

    const modelRadio = screen.getByRole("radio", { name: "Model" });
    fireEvent.click(modelRadio);

    expect(localStorage.getItem("mahoquot.overview.dimension")).toBe("model");
    expect(screen.getByRole("heading", { name: "Model mix" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Provider mix" })).not.toBeInTheDocument();
  });

  it("clicking the 'Account' radio persists 'account' to localStorage and updates mix heading to 'Account mix'", () => {
    render(<OverviewDashboard stats={stats} samples={[]} accounts={[account]} />);

    const accountRadio = screen.getByRole("radio", { name: "Account" });
    fireEvent.click(accountRadio);

    expect(localStorage.getItem("mahoquot.overview.dimension")).toBe("account");
    expect(screen.getByRole("heading", { name: "Account mix" })).toBeInTheDocument();
  });

  it("clicking the 'Tokens' metric radio persists 'tokens' to localStorage", () => {
    render(<OverviewDashboard stats={stats} samples={[]} accounts={[account]} />);

    const tokensRadio = screen.getByRole("radio", { name: "Tokens" });
    fireEvent.click(tokensRadio);

    expect(localStorage.getItem("mahoquot.overview.metric")).toBe("tokens");
  });

  it("calls onRangeChange when user switches the range filter", () => {
    const onRangeChange = vi.fn();
    render(
      <OverviewDashboard
        stats={stats}
        samples={[]}
        accounts={[account]}
        range="1d"
        onRangeChange={onRangeChange}
      />,
    );

    const radio7d = screen.getByRole("radio", { name: "7d" });
    fireEvent.click(radio7d);
    expect(onRangeChange).toHaveBeenCalledWith("7d");
  });

  it("renders visible analytics error notice without replacing the dashboard", () => {
    render(
      <OverviewDashboard
        stats={stats}
        samples={[]}
        accounts={[account]}
        analyticsError="History worker degraded"
      />,
    );

    expect(screen.getByText("History worker degraded")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Request activity" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Usage breakdown" })).toBeInTheDocument();
  });

  it("derives analytics locally using telemetryAnalytics when analytics prop is not supplied", () => {
    const samples = persistedTelemetrySamples([
      {
        minute_unix: Math.floor(Date.now() / 1000) - 60,
        requests: 5,
        successes: 5,
        failures: 0,
        input_tokens: 50_000,
        output_tokens: 12_000,
        providers: [{ provider: "openai", requests: 5, successes: 5, failures: 0 }],
        accounts: [
          {
            account: "acc-1",
            requests: 5,
            successes: 5,
            failures: 0,
            input_tokens: 50_000,
            output_tokens: 12_000,
          },
        ],
      },
    ]);

    render(
      <OverviewDashboard
        stats={stats}
        samples={samples}
        accounts={[account]}
        dimension="account"
        range="1d"
        asOfMs={Date.now()}
      />,
    );

    const table = screen.getByRole("table", { name: "Usage breakdown" });
    expect(within(table).getByText("Team Prod")).toBeInTheDocument();
    expect(within(table).getByText("50K")).toBeInTheDocument();
    expect(within(table).getByText("12K")).toBeInTheDocument();
    expect(within(table).getByText("62K")).toBeInTheDocument();
  });

  it("renders KPI cards reading Requests / Success / Failed from analytics.totals and In flight / p50 / p90 from stats", () => {
    const analytics = createMockAnalytics({
      totals: {
        requests: 1234,
        successes: 1200,
        failures: 34,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        avgLatencyMs: 120,
        costUsd: 0,
      },
    });

    render(<OverviewDashboard stats={stats} samples={[]} analytics={analytics} />);

    const kpis = document.querySelector(".minimal-kpis") as HTMLElement;
    expect(kpis).toBeInTheDocument();
    expect(within(kpis).getByText("1.2K")).toBeInTheDocument();
    expect(within(kpis).getByText("97.2%")).toBeInTheDocument();
    expect(within(kpis).getByText("34")).toBeInTheDocument();
    expect(within(kpis).getByText("2")).toBeInTheDocument();
    expect(within(kpis).getByText("120 ms")).toBeInTheDocument();
    expect(within(kpis).getByText("250 ms")).toBeInTheDocument();
  });
});

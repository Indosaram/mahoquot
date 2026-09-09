import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewDashboard } from "../components/OverviewDashboard";
import { OverviewTokenUsage } from "../components/OverviewTokenUsage";
import type { NormalizedAccount } from "../lib/accounts";
import type { AdminStats } from "../lib/schemas";
import { appendTelemetrySample, persistedTelemetrySamples } from "../lib/telemetry";

const stats = {
  uptime_secs: 3600,
  in_flight: 0,
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

describe("OverviewTokenUsage component", () => {
  it("renders total tokens and account breakdown correctly", () => {
    render(
      <OverviewTokenUsage
        range="1d"
        tokenTotals={{ inputTokens: 50_000, outputTokens: 12_000, totalTokens: 62_000 }}
        accountTokens={[
          { id: "acc-1", inputTokens: 50_000, outputTokens: 12_000, totalTokens: 62_000 },
        ]}
        accounts={[account]}
        hasTokenData={true}
      />,
    );

    expect(screen.getByText("Token usage")).toBeInTheDocument();
    expect(screen.getAllByText("50K")).toHaveLength(2);
    expect(screen.getAllByText("12K")).toHaveLength(2);
    expect(screen.getAllByText("62K")).toHaveLength(2);
    expect(screen.getByText("Team Prod")).toBeInTheDocument();
  });

  it("renders semantic table with proper table headers and column scopes", () => {
    render(
      <OverviewTokenUsage
        range="1d"
        tokenTotals={{ inputTokens: 50_000, outputTokens: 12_000, totalTokens: 62_000 }}
        accountTokens={[
          { id: "acc-1", inputTokens: 50_000, outputTokens: 12_000, totalTokens: 62_000 },
        ]}
        accounts={[account]}
        hasTokenData={true}
      />,
    );

    const table = screen.getByRole("table", { name: "Account token breakdown" });
    expect(table).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(4);
    expect(headers[0]).toHaveTextContent("Account");
    expect(headers[1]).toHaveTextContent("Input");
    expect(headers[2]).toHaveTextContent("Output");
    expect(headers[3]).toHaveTextContent("Total");
  });

  it("R3 regression: renders unavailable state when hasTokenData is false", () => {
    render(
      <OverviewTokenUsage
        range="1h"
        tokenTotals={{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }}
        accountTokens={[]}
        accounts={[account]}
        hasTokenData={false}
      />,
    );

    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.getByText("Token telemetry unavailable in this window")).toBeInTheDocument();
  });

  it("R3 regression: renders zero tokens when hasTokenData is true and activity is 0", () => {
    render(
      <OverviewTokenUsage
        range="1h"
        tokenTotals={{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }}
        accountTokens={[]}
        accounts={[account]}
        hasTokenData={true}
      />,
    );

    expect(screen.getAllByText("0")).toHaveLength(3);
    expect(screen.getByText("No token activity in this window")).toBeInTheDocument();
  });

  it("R3 regression: renders message when total tokens exist but account breakdown is empty", () => {
    render(
      <OverviewTokenUsage
        range="1d"
        tokenTotals={{ inputTokens: 100, outputTokens: 20, totalTokens: 120 }}
        accountTokens={[]}
        accounts={[account]}
        hasTokenData={true}
      />,
    );

    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("No per-account token breakdown available")).toBeInTheDocument();
  });

  it("R3 regression: renders unclassified row when account totals do not sum to total tokens", () => {
    render(
      <OverviewTokenUsage
        range="1d"
        tokenTotals={{ inputTokens: 100, outputTokens: 50, totalTokens: 150 }}
        accountTokens={[
          { id: "acc-1", inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        ]}
        accounts={[account]}
        hasTokenData={true}
      />,
    );

    expect(screen.getByText("Team Prod")).toBeInTheDocument();
    expect(screen.getByText("Unclassified")).toBeInTheDocument();
    expect(screen.getAllByText("50")).toHaveLength(2);
  });

  it("R6 regression: renders em dash for unknown account token fields and partial total", () => {
    render(
      <OverviewTokenUsage
        range="1d"
        tokenTotals={{ inputTokens: 100, outputTokens: 0, totalTokens: 100, isOutputSupported: false, isPartial: true }}
        accountTokens={[
          { id: "acc-1", inputTokens: 100, outputTokens: undefined, totalTokens: 100, isInputSupported: true, isOutputSupported: false, isPartial: true },
        ]}
        accounts={[account]}
        hasTokenData={true}
      />,
    );

    expect(screen.getByText("Team Prod")).toBeInTheDocument();
    // 2 em dashes: 1 for Output KPI, 1 for Output column in account row
    expect(screen.getAllByText("—")).toHaveLength(2);
    // 2 partial totals: 1 in Total KPI, 1 in Total column in account row
    expect(screen.getAllByText("~100")).toHaveLength(2);
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

    const radio7d = screen.getByLabelText("7d");
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

    const usageSection = screen.getByLabelText("Token usage");
    expect(within(usageSection).getAllByText("0")).toHaveLength(3);
    expect(within(usageSection).getByText("No token activity in this window")).toBeInTheDocument();
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

    const usageSection = screen.getByLabelText("Token usage");
    expect(within(usageSection).getAllByText("—")).toHaveLength(3);
    expect(within(usageSection).getByText("Token telemetry unavailable in this window")).toBeInTheDocument();
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

    const usageSection = screen.getByLabelText("Token usage");
    expect(within(usageSection).getAllByText("—")).toHaveLength(3);
    expect(within(usageSection).getByText("Token telemetry unavailable in this window")).toBeInTheDocument();
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

    const usageSection = screen.getByLabelText("Token usage");
    expect(within(usageSection).getAllByText("—")).toHaveLength(3);
    expect(within(usageSection).getByText("Token telemetry unavailable in this window")).toBeInTheDocument();
    expect(within(usageSection).queryByText("No token activity in this window")).not.toBeInTheDocument();
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

    const usageSection = screen.getByLabelText("Token usage");
    // Input is 0 (title "0")
    expect(within(usageSection).getByTitle("0")).toBeInTheDocument();
    // Output is "—" (title "Unavailable")
    expect(within(usageSection).getByTitle("Unavailable")).toBeInTheDocument();
    // Total is "~0" (title "Partial: 0")
    expect(within(usageSection).getByTitle("Partial: 0")).toBeInTheDocument();
    expect(within(usageSection).getByText("No token activity in this window")).toBeInTheDocument();
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
        { id: "b", provider: "anthropic", health: "healthy", ok: 0, fails: 0, input_tokens: 100, output_tokens: 50 },
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
        { id: "b", provider: "anthropic", health: "healthy", ok: 0, fails: 0, input_tokens: 100, output_tokens: 50 }, // 0 requests, delta 0
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

    const usageSection = screen.getByLabelText("Token usage");
    expect(within(usageSection).getAllByText("—")).toHaveLength(3);
    expect(within(usageSection).getByText("Token telemetry unavailable in this window")).toBeInTheDocument();
    expect(within(usageSection).queryByText("No token activity in this window")).not.toBeInTheDocument();
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
          { account: "b", requests: 0, successes: 0, failures: 0, input_tokens: 0, output_tokens: 0 }, // idle zero
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

    const usageSection = screen.getByLabelText("Token usage");
    expect(within(usageSection).getAllByText("—")).toHaveLength(3);
    expect(within(usageSection).getByText("Token telemetry unavailable in this window")).toBeInTheDocument();
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

    const usageSection = screen.getByLabelText("Token usage");
    // All 3 render measured 0
    expect(within(usageSection).getAllByText("0")).toHaveLength(3);
    expect(within(usageSection).getByText("No token activity in this window")).toBeInTheDocument();
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
          { account: "a", requests: 1, successes: 1, failures: 0, input_tokens: 0, output_tokens: 0 },
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

    const usageSection = screen.getByLabelText("Token usage");
    // All 3 render measured 0 (since account 'a' handled requests and had input 0 / output 0)
    expect(within(usageSection).getAllByText("0")).toHaveLength(3);
    expect(within(usageSection).getByText("No token activity in this window")).toBeInTheDocument();
  });
});

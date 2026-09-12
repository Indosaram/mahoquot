import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewBreakdownChart } from "../components/OverviewBreakdownChart";
import type { OverviewAnalytics } from "../lib/overview-analytics";

function createMockAnalytics(overrides: Partial<OverviewAnalytics> = {}): OverviewAnalytics {
  return {
    source: "history",
    dimension: "provider",
    metric: "requests",
    range: "1h",
    bucketMs: 60000,
    totals: {
      requests: 30,
      successes: 30,
      failures: 0,
      inputTokens: 1500,
      outputTokens: 500,
      totalTokens: 2000,
      avgLatencyMs: 120,
      costUsd: 0,
    },
    rows: [
      {
        key: "openai",
        label: "OpenAI",
        provider: "openai",
        requests: 20,
        successes: 20,
        failures: 0,
        inputTokens: 1000,
        outputTokens: 300,
        totalTokens: 1300,
        avgLatencyMs: 100,
        costUsd: 0,
        share: 20 / 30,
        isOther: false,
        isUnlinked: false,
      },
      {
        key: "anthropic",
        label: "Anthropic",
        provider: "anthropic",
        requests: 10,
        successes: 10,
        failures: 0,
        inputTokens: 500,
        outputTokens: 200,
        totalTokens: 700,
        avgLatencyMs: 160,
        costUsd: 0,
        share: 10 / 30,
        isOther: false,
        isUnlinked: false,
      },
    ],
    series: [
      { startMs: 1000, total: 10, values: { openai: 7, anthropic: 3 } },
      { startMs: 2000, total: 12, values: { openai: 8, anthropic: 4 } },
      { startMs: 3000, total: 8, values: { openai: 5, anthropic: 3 } },
    ],
    seriesKeys: ["openai", "anthropic"],
    hasCostData: false,
    isTokenPartial: false,
    supportsModelDimension: true,
    ...overrides,
  };
}

describe("OverviewBreakdownChart", () => {
  it("renders both series labels in the legend given two series keys and three points", () => {
    const analytics = createMockAnalytics();
    render(<OverviewBreakdownChart analytics={analytics} />);

    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    const wrapper = document.querySelector(".overview-breakdown-chart");
    expect(wrapper).toBeInTheDocument();
    expect(wrapper).toHaveAttribute("aria-label", "Activity by provider");
    expect(document.querySelector("canvas")).toBeInTheDocument();
  });

  it("renders 'No traffic in this window' and no canvas given empty series", () => {
    const analytics = createMockAnalytics({
      series: [],
      seriesKeys: [],
      rows: [],
      totals: { ...createMockAnalytics().totals, requests: 0 },
    });
    const { container } = render(<OverviewBreakdownChart analytics={analytics} />);

    expect(screen.getByText("No traffic in this window")).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBeNull();
    const wrapper = container.querySelector(".overview-breakdown-chart");
    expect(wrapper).toBeInTheDocument();
    expect(wrapper).toHaveAttribute("aria-label", "Activity by provider");
  });

  it("renders 'No traffic in this window' and no canvas when every point total is 0", () => {
    const analytics = createMockAnalytics({
      series: [
        { startMs: 1000, total: 0, values: { openai: 0, anthropic: 0 } },
        { startMs: 2000, total: 0, values: { openai: 0, anthropic: 0 } },
        { startMs: 3000, total: 0, values: { openai: 0, anthropic: 0 } },
      ],
    });
    const { container } = render(<OverviewBreakdownChart analytics={analytics} />);

    expect(screen.getByText("No traffic in this window")).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("renders 'Model breakdown needs request history' when dimension is model and supportsModelDimension is false", () => {
    const analytics = createMockAnalytics({
      dimension: "model",
      supportsModelDimension: false,
      series: [],
      seriesKeys: [],
      rows: [],
    });
    const { container } = render(<OverviewBreakdownChart analytics={analytics} />);

    expect(screen.getByText("Model breakdown needs request history")).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBeNull();
    const wrapper = container.querySelector(".overview-breakdown-chart");
    expect(wrapper).toBeInTheDocument();
    expect(wrapper).toHaveAttribute("aria-label", "Activity by model");
  });

  it("handles transition from unsupported to supported model dimension without breaking rules of hooks", () => {
    const analyticsUnsupported = createMockAnalytics({
      dimension: "model",
      supportsModelDimension: false,
      series: [],
      seriesKeys: [],
      rows: [],
    });

    const analyticsSupported = createMockAnalytics({
      dimension: "model",
      supportsModelDimension: true,
      seriesKeys: ["google/gemini-3.8-flash-high"],
      rows: [
        {
          key: "google/gemini-3.8-flash-high",
          label: "gemini-3.8-flash-high",
          provider: "google",
          requests: 20,
          successes: 20,
          failures: 0,
          inputTokens: 1000,
          outputTokens: 300,
          totalTokens: 1300,
          avgLatencyMs: 120,
          costUsd: 0,
          share: 1,
          isOther: false,
          isUnlinked: false,
        },
      ],
      series: [
        {
          startMs: 1000,
          total: 20,
          values: { "google/gemini-3.8-flash-high": 20 },
        },
      ],
    });

    const { rerender } = render(<OverviewBreakdownChart analytics={analyticsSupported} />);
    expect(screen.getByText("gemini-3.8-flash-high")).toBeInTheDocument();
    expect(document.querySelector("canvas")).toBeInTheDocument();

    // Re-rendering with unsupported returns early: hooks must not be violated
    rerender(<OverviewBreakdownChart analytics={analyticsUnsupported} />);
    expect(screen.getByText("Model breakdown needs request history")).toBeInTheDocument();
    expect(document.querySelector("canvas")).toBeNull();

    // Re-rendering back to supported
    rerender(<OverviewBreakdownChart analytics={analyticsSupported} />);
    expect(screen.getByText("gemini-3.8-flash-high")).toBeInTheDocument();
    expect(document.querySelector("canvas")).toBeInTheDocument();
  });

  it("renders 6 distinct swatch colours for 6 provider series", () => {
    const providers = ["antigravity", "zcode", "cline", "codex", "claude", "kiro"];
    const rows = providers.map((p) => ({
      key: p,
      label: p.toUpperCase(),
      provider: p,
      requests: 10,
      successes: 10,
      failures: 0,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      avgLatencyMs: 80,
      costUsd: 0,
      share: 1 / 6,
      isOther: false,
      isUnlinked: false,
    }));
    const seriesPointValues = Object.fromEntries(providers.map((p) => [p, 10]));
    const analytics = createMockAnalytics({
      dimension: "provider",
      seriesKeys: providers,
      rows,
      series: [{ startMs: 1000, total: 60, values: seriesPointValues }],
    });

    render(<OverviewBreakdownChart analytics={analytics} />);

    const swatches = Array.from(
      document.querySelectorAll(".overview-breakdown-chart ul li span:first-child"),
    ) as HTMLElement[];
    expect(swatches).toHaveLength(6);

    const swatchColors = swatches.map((s) => s.style.backgroundColor);
    const uniqueColors = new Set(swatchColors);
    // All 6 provider swatches must have distinct palette seed colors
    expect(uniqueColors.size).toBe(6);

    // In particular, antigravity, zcode, and cline must NOT collide on blue
    const [antigravityColor, zcodeColor, clineColor] = swatchColors.slice(0, 3);
    expect(antigravityColor).not.toBe(zcodeColor);
    expect(zcodeColor).not.toBe(clineColor);
    expect(antigravityColor).not.toBe(clineColor);
  });

  it("renders model name (e.g. gemini-3.8-flash-high) as legend text when dimension is model", () => {
    const analytics = createMockAnalytics({
      dimension: "model",
      seriesKeys: ["google/gemini-3.8-flash-high", "anthropic/claude-3-5-sonnet"],
      rows: [
        {
          key: "google/gemini-3.8-flash-high",
          label: "gemini-3.8-flash-high",
          provider: "google",
          requests: 25,
          successes: 25,
          failures: 0,
          inputTokens: 2000,
          outputTokens: 800,
          totalTokens: 2800,
          avgLatencyMs: 150,
          costUsd: 0,
          share: 25 / 35,
          isOther: false,
          isUnlinked: false,
        },
        {
          key: "anthropic/claude-3-5-sonnet",
          label: "claude-3-5-sonnet",
          provider: "anthropic",
          requests: 10,
          successes: 10,
          failures: 0,
          inputTokens: 1000,
          outputTokens: 400,
          totalTokens: 1400,
          avgLatencyMs: 200,
          costUsd: 0,
          share: 10 / 35,
          isOther: false,
          isUnlinked: false,
        },
      ],
      series: [
        {
          startMs: 1000,
          total: 35,
          values: {
            "google/gemini-3.8-flash-high": 25,
            "anthropic/claude-3-5-sonnet": 10,
          },
        },
      ],
    });

    render(<OverviewBreakdownChart analytics={analytics} />);

    expect(screen.getByText("gemini-3.8-flash-high")).toBeInTheDocument();
    expect(screen.getByText("claude-3-5-sonnet")).toBeInTheDocument();
    const wrapper = document.querySelector(".overview-breakdown-chart");
    expect(wrapper).toHaveAttribute("aria-label", "Activity by model");
  });

  it("applies default height 250 and respects custom height prop", () => {
    const analytics = createMockAnalytics();
    const { rerender } = render(<OverviewBreakdownChart analytics={analytics} />);

    let wrapper = document.querySelector(".overview-breakdown-chart") as HTMLElement;
    expect(wrapper.style.height).toBe("250px");

    rerender(<OverviewBreakdownChart analytics={analytics} height={320} />);
    wrapper = document.querySelector(".overview-breakdown-chart") as HTMLElement;
    expect(wrapper.style.height).toBe("320px");
  });

  it("respects reduced motion media query", () => {
    const matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const analytics = createMockAnalytics();
    render(<OverviewBreakdownChart analytics={analytics} />);

    expect(matchMediaSpy).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    matchMediaSpy.mockRestore();
  });
});

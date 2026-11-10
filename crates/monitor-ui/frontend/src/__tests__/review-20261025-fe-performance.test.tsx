import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { BarCanvas } from "../components/dither-kit/bar-canvas";
import { CartesianCanvas } from "../components/dither-kit/cartesian-canvas";
import { PieCanvas } from "../components/dither-kit/pie-canvas";
import { ChartContext, useChartController } from "../components/dither-kit/chart-context";
import { PolarChartContext, usePolarController } from "../components/dither-kit/polar-context";
import { useOverviewAnalytics, type UseOverviewAnalyticsArgs } from "../hooks/useOverviewAnalytics";
import { mergeAccountsAndCredentials } from "../lib/accounts";
import type { GatewayClients } from "../lib/api";
import * as builders from "../lib/overview-analytics";
import type { AccountStats, AdminStats, AuthFileItem, HistoryStatsResponse } from "../lib/schemas";
import { ABSENT_ACCOUNT_BASELINE_LIMIT, ABSENT_ACCOUNT_BASELINE_POLLS, appendTelemetrySample, persistedTelemetrySamples, type TelemetrySample } from "../lib/telemetry";

const account = (id: string, provider = "codex"): AccountStats => ({ id, provider, health: "healthy", ok: 1, fails: 0, input_tokens: 100 });
const stats = (accounts: AccountStats[]): AdminStats => ({ accounts, uptime_secs: 1, in_flight: 0, served: 1, failed_over: 0, refreshed: 0 });
const credential = (name: string, type = "codex", email = name): AuthFileItem => ({ name, label: name, type, email, size: 1, path: name, auth_index: name, disabled: false, unavailable: false, runtime_only: false });

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded fallback baselines", () => {
  it("retains only newest metadata through churn and expires omissions", () => {
    let samples: readonly TelemetrySample[] = [];
    for (let i = 0; i < 200; i++) {
      samples = appendTelemetrySample(samples, stats([account(`id-${i}`)]), i);
      expect(samples.slice(0, -1).every((s) => s.cumulativeAccounts === undefined)).toBe(true);
      expect(samples.at(-1)?.cumulativeAccounts?.length).toBeLessThanOrEqual(ABSENT_ACCOUNT_BASELINE_POLLS + 1);
    }
    for (let i = 0; i <= ABSENT_ACCOUNT_BASELINE_POLLS; i++) samples = appendTelemetrySample(samples, stats([]), 201 + i);
    expect(samples.at(-1)?.cumulativeAccounts).toEqual([]);
    const returning = appendTelemetrySample(samples, stats([account("id-199")]), 300);
    expect(returning.at(-1)?.accounts[0].inputTokens).toBeUndefined();
  });

  it("preserves immediate return and independent missing-field semantics", () => {
    const first = appendTelemetrySample([], stats([account("a")]), 1);
    const missing = appendTelemetrySample(first, stats([]), 2);
    const returned = appendTelemetrySample(missing, stats([{ ...account("a"), input_tokens: 900 }]), 3);
    expect(returned.at(-1)?.accounts[0]).toMatchObject({ requests: 0, inputTokens: 0 });
    const omitted = appendTelemetrySample(returned, stats([{ ...account("a"), input_tokens: undefined, output_tokens: 20 }]), 4);
    const restored = appendTelemetrySample(omitted, stats([{ ...account("a"), input_tokens: 950, output_tokens: 25 }]), 5);
    expect(restored.at(-1)?.accounts[0]).toMatchObject({ inputTokens: 0, outputTokens: 5 });
    expect(first[0].cumulativeAccounts).toHaveLength(1);
  });

  it("caps absent cardinality, sample count, and resets history baselines", () => {
    const first = appendTelemetrySample([], stats(Array.from({ length: ABSENT_ACCOUNT_BASELINE_LIMIT + 10 }, (_, i) => account(`a${i}`))), 1);
    const omitted = appendTelemetrySample(first, stats([]), 2);
    expect(omitted.at(-1)?.cumulativeAccounts).toHaveLength(ABSENT_ACCOUNT_BASELINE_LIMIT);
    const capped = appendTelemetrySample(Array(43_200).fill({ ...first[0], cumulativeAccounts: undefined }), stats([]), 3);
    expect(capped).toHaveLength(43_200);
    const history = persistedTelemetrySamples([{ minute_unix: 1, requests: 1, successes: 1, failures: 0, providers: [], accounts: [] }]);
    expect(appendTelemetrySample(history, stats([account("a")]), 4).at(-1)?.accounts[0].inputTokens).toBeUndefined();
  });
});

describe("ordered pairing indexes", () => {
  it("preserves credential order, aliases, duplicate identities and Devin slug precedence", () => {
    const runtime = [account("a@example.test", "openai"), account("codex-a@example.test"), account("slug", "devin"), account("other", "devin")];
    const credentials = [credential("first.json", "codex", "a@example.test"), credential("second.json", "openai", "a@example.test"), { ...credential("slug.json", "devin"), identity_slug: "other" }, { ...credential("devin-second.json", "devin"), identity_slug: "slug" }];
    const pairs = (files: AuthFileItem[]) => new Map(mergeAccountsAndCredentials(runtime, files).map((a) => [a.runtimeId, a.credentialName]));
    expect(pairs(credentials).get("a@example.test")).toBe("first.json");
    expect(pairs([...credentials].reverse()).get("a@example.test")).toBe("second.json");
    expect(pairs(credentials).get("slug")).toBe("devin-second.json");
    expect(pairs(credentials).get("other")).toBe("slug.json");
  });

  it.each([100, 1000, 2000, 4000])("bounds credential reads for %i ambiguous accounts", (size) => {
    let reads = 0;
    const runtime = Array.from({ length: size }, (_, i) => account(`opaque-${i}`));
    const credentials = Array.from({ length: size }, (_, i) => ({ ...credential(`file-${i}.json`), get email() { reads++; return `unmatched-${i}@example.test`; } }));
    const result = mergeAccountsAndCredentials(runtime, credentials);
    expect(result.filter((a) => a.runtimeId && a.credentialName)).toHaveLength(0);
    expect(reads).toBeLessThanOrEqual(size * 3);
    const prior = appendTelemetrySample([], stats(runtime), 1);
    let idReads = 0;
    const observed = prior[0].accounts.map((a) => ({ ...a, get id() { idReads++; return a.id; } }));
    appendTelemetrySample([{ ...prior[0], accounts: observed }], stats(runtime), 2);
    expect(idReads).toBeLessThanOrEqual(size * 2);
  });
});

const response: HistoryStatsResponse = { groups: [], totals: { requests: 0, "successful-requests": 0, "failed-requests": 0, "input-tokens": 0, "output-tokens": 0, "cached-input-tokens": 0, "cache-write-tokens": 0, "reasoning-tokens": 0, "total-tokens": 0, "estimated-cost-usd": 0 } };
const args = (historyStats: ReturnType<typeof vi.fn>): UseOverviewAnalyticsArgs => ({ clients: { management: { historyStats } } as unknown as GatewayClients, range: "30m", dimension: "account", metric: "requests", accounts: mergeAccountsAndCredentials([account("a")], []), samples: [], enabled: false, nowMs: 100_000 });

describe("analytics pre-build guards", () => {
  it("skips equivalent and disabled builds, rebuilds labels and metrics without refetch", async () => {
    const build = vi.spyOn(builders, "buildAnalytics");
    const request = vi.fn().mockResolvedValue(response);
    let props = args(request);
    const hook = renderHook((p) => useOverviewAnalytics(p), { initialProps: props });
    props = { ...props, enabled: true };
    hook.rerender(props);
    await act(async () => { await hook.result.current.refresh(); });
    build.mockClear(); request.mockClear();
    const cached = hook.result.current.analytics;
    hook.rerender({ ...props, accounts: props.accounts.map((a) => ({ ...a })) });
    expect(build).not.toHaveBeenCalled();
    expect(hook.result.current.analytics).toBe(cached);
    props = { ...props, accounts: props.accounts.map((a) => ({ ...a, label: "changed" })) };
    hook.rerender(props);
    expect(build).toHaveBeenCalledTimes(1);
    hook.rerender({ ...props, metric: "tokens" });
    expect(request).not.toHaveBeenCalled();
    build.mockClear();
    props = { ...props, enabled: false, accounts: props.accounts.map((a) => ({ ...a, label: "latest" })) };
    hook.rerender(props);
    expect(build).not.toHaveBeenCalled();
    request.mockImplementation(() => new Promise(() => {}));
    hook.rerender({ ...props, enabled: true });
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][0].accounts?.[0].label).toBe("latest");
  });

  it("combines fallback invalidations and suppresses a late disabled round", async () => {
    const fallback = vi.spyOn(builders, "telemetryAnalytics");
    const request = vi.fn().mockRejectedValue(new Error("fixture"));
    let props = { ...args(request), enabled: true };
    const hook = renderHook((p) => useOverviewAnalytics(p), { initialProps: props });
    await act(async () => { await hook.result.current.refresh(); });
    fallback.mockClear();
    props = { ...props, accounts: [...props.accounts], samples: appendTelemetrySample([], stats([account("a")]), 99_000) };
    hook.rerender(props);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(hook.result.current.analytics.source).toBe("telemetry");
    fallback.mockClear();
    let reject!: (reason: Error) => void;
    request.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    let round!: Promise<void>;
    act(() => { round = hook.result.current.refresh(); });
    hook.rerender({ ...props, enabled: false });
    await act(async () => { reject(new Error("late")); await round; });
    expect(fallback).not.toHaveBeenCalled();
  });
});

const data = [{ x: 0, value: 2 }, { x: 1, value: 4 }];
const config = { value: { color: "blue" as const } };
const dimensions = { width: 40, height: 24 };
const margins = { top: 0, bottom: 0, left: 0, right: 0 };
function CartesianFixture({ kind, hover, marker = 0 }: { kind: "bar" | "area"; hover: boolean; marker?: number }) {
  const ctx = useChartController({ chartType: kind, data, config, dimensions, margins, stackType: "default", animationDuration: 100, hovered: hover, markerIndex: marker, bloom: "off" });
  return <ChartContext value={{ ...ctx, isMouseInChart: hover, hoverIndex: hover ? marker : null }}>{kind === "bar" ? <BarCanvas /> : <CartesianCanvas />}</ChartContext>;
}
const pieData = [{ name: "value", value: 2 }];
function PieFixture({ hover }: { hover: boolean }) {
  const ctx = usePolarController({ chartType: "pie", data: pieData, config, dimensions, margins, dataKey: "value", nameKey: "name", innerRadiusRatio: 0, animationDuration: 100 });
  return <PolarChartContext value={{ ...ctx, isMouseInChart: hover, hoverIndex: hover ? 0 : null }}><PieCanvas /></PolarChartContext>;
}

describe("settled canvas frame ownership", () => {
  it.each(["bar", "pie", "reduced-area", "area"] as const)("settles or intentionally twinkles: %s", (kind) => {
    const pending = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { pending.set(++sequence, callback); return sequence; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
    vi.stubGlobal("matchMedia", () => ({ matches: kind === "reduced-area" }));
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const draws: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      const node = this;
      return { clearRect: () => {}, fillRect: () => draws.push("paint"), drawImage: (source: unknown) => draws.push(source === node.previousElementSibling ? "bloom" : "copy"), set fillStyle(_value: string) {} } as unknown as CanvasRenderingContext2D;
    });
    const view = (hover: boolean) => <StrictMode>{kind === "pie" ? <PieFixture hover={hover} /> : <CartesianFixture kind={kind === "bar" ? "bar" : "area"} hover={hover} />}</StrictMode>;
    const mounted = render(view(true));
    const advance = (start: number) => { for (let i = 1; i <= 240; i++) act(() => { const batch = [...pending.values()]; pending.clear(); batch.forEach((callback) => callback(start + i * 16)); }); };
    advance(0);
    expect(pending.size).toBe(kind === "area" ? 1 : 0);
    expect(draws).toContain("paint");
    expect(draws.at(-1)).toBe("bloom");
    mounted.rerender(view(false));
    expect(pending.size).toBe(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    advance(4000);
    expect(pending.size).toBe(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(pending.size).toBe(1);
    advance(8000);
    expect(pending.size).toBe(0);
    mounted.unmount();
    expect(pending.size).toBe(0);
    for (const [event, listener] of add.mock.calls.filter(([event]) => event === "visibilitychange")) expect(remove).toHaveBeenCalledWith(event, listener);
  });
});

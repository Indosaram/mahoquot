import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrayPanel } from "../components/TrayPanel";
import type { NormalizedAccount } from "../lib/accounts";

const account = (overrides: {
  provider: string;
  email: string;
  plan: string | null;
  primary: number | null;
  secondary?: number | null;
  limitName?: string;
  totals?: { requests: number; tokens: number; total_cost_usd: number };
  windows?: { label: string; requests: number }[];
}): NormalizedAccount =>
  ({
    id: `${overrides.provider}-${overrides.email}`,
    runtimeId: null,
    credentialName: null,
    authIndex: null,
    provider: overrides.provider,
    email: overrides.email,
    label: overrides.email,
    health: "available",
    healthRaw: "available",
    cooldownUntilUnixMs: null,
    cooldownRemainingSecs: null,
    ok: 0,
    fails: 0,
    failureRate: 0,
    p50Ms: null,
    lastError: null,
    usage: {
      totals: overrides.totals ?? null,
      windows: overrides.windows ?? null,
      plan_type: overrides.plan,
      primary: {
        used_percent: overrides.primary,
        window_minutes: 300,
        reset_after_seconds: 15_120,
        limit_name: overrides.limitName ?? null,
      },
      secondary:
        overrides.secondary === undefined
          ? null
          : {
              used_percent: overrides.secondary,
              window_minutes: 10_080,
              reset_after_seconds: 594_000,
              limit_name: "Weekly",
            },
    },
    quotaCapability: "supported",
    isCredentialOnly: false,
    canReset: true,
    resetCreditsAvailable: 0,
  }) as unknown as NormalizedAccount;

describe("TrayPanel", () => {
  it("renders provider chips, plan badges, and quota tiles per account", () => {
    render(
      <TrayPanel
        accounts={[
          account({
            provider: "codex",
            email: "user@example.com-plus",
            plan: "plus",
            primary: 46,
            secondary: 82,
            totals: { requests: 7005, tokens: 1_184_368_836, total_cost_usd: 3990.364061 },
            windows: [
              { label: "3h", requests: 350 },
              { label: "24h", requests: 550 },
            ],
          }),
          account({
            provider: "antigravity",
            email: "weekly@gmail.com",
            plan: "prolite",
            primary: 100,
          }),
        ]}
        proxyUrl="http://127.0.0.1:18801"
        online
        fetchedAgoSecs={12}
        refreshing
        showRemaining
        onRefresh={vi.fn()}
        onOpenConsole={vi.fn()}
        onQuit={vi.fn()}
        onStartGateway={vi.fn()}
        onStopGateway={vi.fn()}
        gatewayLifecycle="running"
      />,
    );

    expect(screen.getByText("http://127.0.0.1:18801")).toBeTruthy();
    expect(screen.getByLabelText("Stop gateway")).toBeTruthy();
    expect(screen.getAllByTestId("provider-logo-codex").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Plus")).toBeTruthy();
    expect(screen.getByText("Pro 5x")).toBeTruthy();
    expect(screen.getAllByText("Session").length).toBe(2);
    expect(screen.getByText("54% left")).toBeTruthy();
    expect(screen.getByTestId("tray-totals").textContent).toContain("7,005 req");
    expect(screen.getByTestId("tray-totals").textContent).toContain("1.18B tok");
    expect(screen.getByTestId("tray-totals").textContent).toContain("$3,990.36");
    expect(screen.getByTestId("tray-windows").textContent).toContain("3h: 350 req");
    expect(screen.getByTestId("tray-windows").textContent).toContain("24h: 550 req");
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("0% left")).toBeTruthy();
    expect(screen.getAllByText("12 seconds ago").length).toBe(2);
    const spinners = screen
      .getAllByRole("button")
      .filter((button) => button.querySelector(".tray-spin"));
    expect(spinners.length).toBeGreaterThanOrEqual(2);
  });

  it("filters cards down to the selected provider chip", () => {
    render(
      <TrayPanel
        accounts={[
          account({
            provider: "codex",
            email: "codex@example.test",
            plan: "plus",
            primary: 46,
          }),
          account({
            provider: "claude",
            email: "claude@example.test",
            plan: null,
            primary: 100,
          }),
        ]}
        proxyUrl="http://127.0.0.1:18801"
        online
        fetchedAgoSecs={null}
        refreshing={false}
        showRemaining={false}
        onRefresh={vi.fn()}
        onOpenConsole={vi.fn()}
        onQuit={vi.fn()}
        onStartGateway={vi.fn()}
        onStopGateway={vi.fn()}
        gatewayLifecycle="running"
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
    expect(screen.getByText("claude@example.test")).toBeTruthy();
    expect(screen.queryByText("codex@example.test")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(screen.getByText("codex@example.test")).toBeTruthy();
  });
});

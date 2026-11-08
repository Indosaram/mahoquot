import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotchSurface } from "../components/NotchSurface";
import type { NormalizedAccount } from "../lib/accounts";

const account = (overrides: {
  id: string;
  provider: string;
  email?: string;
  usedPercent?: number | null;
  health?: NormalizedAccount["health"];
  cooldownRemainingSecs?: number | null;
  resetCreditsAvailable?: number;
  errorStatus?: number;
}): NormalizedAccount =>
  ({
    id: overrides.id,
    runtimeId: null,
    credentialName: null,
    authIndex: null,
    provider: overrides.provider,
    plan: null,
    email: overrides.email ?? `${overrides.id}@example.test`,
    label: overrides.email ?? `${overrides.id}@example.test`,
    health: overrides.health ?? "healthy",
    healthRaw: overrides.health ?? "healthy",
    cooldownUntilUnixMs: null,
    cooldownRemainingSecs: overrides.cooldownRemainingSecs ?? null,
    ok: 0,
    fails: 0,
    failureRate: 0,
    p50Ms: null,
    lastError:
      overrides.errorStatus === undefined ? null : { status: overrides.errorStatus, message: "" },
    usage:
      overrides.usedPercent === undefined
        ? null
        : {
            totals: null,
            windows: null,
            plan_type: null,
            primary: {
              used_percent: overrides.usedPercent,
              window_minutes: 300,
              reset_after_seconds: 15_120,
              limit_name: "Session",
            },
            secondary: null,
          },
    quotaCapability: "supported",
    isCredentialOnly: false,
    canReset: (overrides.resetCreditsAvailable ?? 0) > 0,
    resetCreditsAvailable: overrides.resetCreditsAvailable ?? 0,
  }) as unknown as NormalizedAccount;

describe("NotchSurface ring sizing", () => {
  it("renders at most seven providers so data-count matches the DOM", () => {
    const providers = [
      "codex",
      "claude",
      "antigravity",
      "cline",
      "openrouter",
      "deepseek",
      "kimi",
      "kiro",
      "groq",
    ];
    const { container } = render(
      <NotchSurface
        accounts={providers.map((provider, index) => account({ id: `acct-${index}`, provider }))}
        loadState="online"
        showRemaining={false}
        notchExpanded={false}
        nativeCursor={null}
      />,
    );

    const surface = container.querySelector(".notch-surface");
    expect(surface?.getAttribute("data-count")).toBe("7");
    expect(container.querySelectorAll(".notch-ring-item")).toHaveLength(7);
    expect(screen.getByTestId("notch-ring-codex")).toBeTruthy();
    expect(screen.queryByTestId("notch-ring-groq")).toBeNull();
  });
});

describe("NotchSurface empty ring states", () => {
  it("reports loading instead of claiming no accounts are connected", () => {
    render(
      <NotchSurface
        accounts={[]}
        loadState="loading"
        showRemaining={false}
        notchExpanded={false}
        nativeCursor={null}
      />,
    );

    const tooltip = screen.getByTestId("notch-tooltip-empty");
    expect(tooltip.getAttribute("data-empty-state")).toBe("loading");
    expect(tooltip.textContent).not.toMatch(/No accounts connected/);
  });

  it("reports a stopped gateway even when accounts exist upstream", () => {
    render(
      <NotchSurface
        accounts={[
          account({ id: "a1", provider: "codex", email: "one@example.test", usedPercent: 40 }),
        ]}
        loadState="stopped"
        showRemaining={false}
        notchExpanded={false}
        nativeCursor={null}
      />,
    );

    const tooltip = screen.getByTestId("notch-tooltip-empty");
    expect(tooltip.getAttribute("data-empty-state")).toBe("stopped");
    expect(tooltip.textContent).not.toMatch(/No accounts connected/);
    expect(screen.queryByTestId("notch-ring-codex")).toBeNull();
  });

  it("keeps the onboarding copy for a true empty state", () => {
    render(
      <NotchSurface
        accounts={[]}
        loadState="online"
        showRemaining={false}
        notchExpanded={false}
        nativeCursor={null}
      />,
    );

    const tooltip = screen.getByTestId("notch-tooltip-empty");
    expect(tooltip.getAttribute("data-empty-state")).toBe("empty");
    expect(tooltip.textContent).toMatch(/No accounts connected/);
  });
});

describe("NotchSurface tooltip structure", () => {
  it("keeps the tooltip out of the ring button", () => {
    render(
      <NotchSurface
        accounts={[
          account({ id: "a1", provider: "codex", email: "one@example.test", usedPercent: 40 }),
        ]}
        loadState="online"
        showRemaining={false}
        notchExpanded={false}
        nativeCursor={null}
      />,
    );

    const ring = screen.getByTestId("notch-ring-codex");
    const tooltip = screen.getByTestId("notch-tooltip-codex");
    expect(ring.contains(tooltip)).toBe(false);
    expect(ring.querySelector(".notch-tooltip")).toBeNull();
    expect(ring.querySelector("div")).toBeNull();
    expect(tooltip.closest(".notch-ring-cell")).toBe(ring.parentElement);
  });

  it("keys pooled tooltip accounts uniquely when labels collide", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <NotchSurface
          accounts={[
            account({
              id: "cred-a",
              provider: "codex",
              email: "same@example.test",
              usedPercent: 10,
            }),
            account({
              id: "cred-b",
              provider: "codex",
              email: "same@example.test",
              usedPercent: 90,
            }),
          ]}
          loadState="online"
          showRemaining={false}
          notchExpanded={false}
          nativeCursor={null}
        />,
      );

      const testIds = [...document.querySelectorAll(".notch-tooltip-account")].map((element) =>
        element.getAttribute("data-testid"),
      );
      expect(testIds).toHaveLength(2);
      expect(new Set(testIds).size).toBe(2);
      const duplicateKeyWarning = errorSpy.mock.calls.some((args) =>
        args.some((arg) => String(arg).toLowerCase().includes("same key")),
      );
      expect(duplicateKeyWarning).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("NotchSurface dial label clamp", () => {
  it("does not pin a multi-account provider dial at 0% left when serving accounts remain", () => {
    const { container } = render(
      <NotchSurface
        accounts={[
          account({ id: "spent", provider: "claude", usedPercent: 100 }),
          account({ id: "serving-a", provider: "claude", usedPercent: 68 }),
          account({ id: "serving-b", provider: "claude", usedPercent: 20 }),
        ]}
        loadState="online"
        showRemaining
        notchExpanded={false}
        nativeCursor={null}
      />,
    );

    // Worst serving account is 68% used -> 32% left on the dial, not 0% left.
    expect(container.querySelector(".notch-dial-label")?.textContent).toBe("32%");
  });

  it("clamps over-100% usage to match the arc", () => {
    const { container } = render(
      <NotchSurface
        accounts={[account({ id: "a1", provider: "codex", usedPercent: 105 })]}
        loadState="online"
        showRemaining={false}
        notchExpanded={false}
        nativeCursor={null}
      />,
    );

    expect(container.querySelector(".notch-dial-label")?.textContent).toBe("100%");
  });

  it("clamps negative remaining to zero under showRemaining", () => {
    const { container } = render(
      <NotchSurface
        accounts={[account({ id: "a1", provider: "codex", usedPercent: 105 })]}
        loadState="online"
        showRemaining
        notchExpanded={false}
        nativeCursor={null}
      />,
    );

    expect(container.querySelector(".notch-dial-label")?.textContent).toBe("0%");
  });
});

describe("NotchSurface reachability and reset copy", () => {
  const renderGroup = (accounts: readonly NormalizedAccount[]) =>
    render(
      <NotchSurface
        accounts={accounts}
        loadState="online"
        showRemaining
        notchExpanded
        nativeCursor={null}
      />,
    );

  it("surfaces cooldown as a status line without touching the quota arc", () => {
    const { container } = renderGroup([
      account({
        id: "cool",
        provider: "antigravity",
        usedPercent: 12,
        health: "cooldown",
        cooldownRemainingSecs: 300,
      }),
    ]);

    const status = container.querySelector(".notch-tooltip-status");
    expect(status?.textContent).toBe("Cooling down · 5m left");
    expect(status?.getAttribute("data-tone")).toBe("warn");
    // Quota still comes from the measured usage, so an unreachable lane never
    // silently reads as an exhausted one.
    expect(container.querySelector(".notch-dial-label")?.textContent).toBe("88%");
    expect(container.querySelector(".notch-health-dot")?.getAttribute("data-tone")).toBe("warn");
  });

  it("names the failing status code for an errored lane", () => {
    const { container } = renderGroup([
      account({ id: "err", provider: "codex", usedPercent: 40, health: "error", errorStatus: 429 }),
    ]);

    expect(container.querySelector(".notch-tooltip-status")?.textContent).toBe(
      "Last request failed (429)",
    );
    expect(container.querySelector(".notch-tooltip-status")?.getAttribute("data-tone")).toBe("bad");
    expect(container.querySelector(".notch-health-dot")?.getAttribute("data-tone")).toBe("bad");
  });

  it("states how many lanes are serving when the pool is partly unreachable", () => {
    const { container } = renderGroup([
      account({ id: "a1", provider: "claude", usedPercent: 20 }),
      account({
        id: "a2",
        provider: "claude",
        usedPercent: 30,
        health: "auth_required",
      }),
    ]);

    expect(container.querySelector(".notch-tooltip-count")?.textContent).toBe(
      "2 accounts · 1 serving",
    );
    // One dot per provider dial, reporting the worst lane in the pool.
    const dots = container.querySelectorAll(".notch-health-dot");
    expect(dots).toHaveLength(1);
    expect(dots[0]?.getAttribute("data-tone")).toBe("bad");
  });

  it("shows banked reset credits and omits the line when there are none", () => {
    const { container } = renderGroup([
      account({ id: "a1", provider: "codex", usedPercent: 20, resetCreditsAvailable: 2 }),
      account({ id: "a2", provider: "claude", usedPercent: 20 }),
    ]);

    const credits = container.querySelectorAll(".notch-tooltip-credits");
    expect(credits).toHaveLength(1);
    expect(credits[0]?.textContent).toBe("2 resets");
  });

  it("prints a reset only when the gateway reported one", () => {
    const { container } = render(
      <NotchSurface
        accounts={[account({ id: "a1", provider: "codex", usedPercent: 20 })]}
        loadState="online"
        showRemaining
        notchExpanded
        nativeCursor={null}
      />,
    );

    expect(container.querySelector(".notch-tooltip-meta")?.textContent).toBe("Resets 4h 12m");
    expect(container.textContent).not.toMatch(/Resets later/);
  });
});

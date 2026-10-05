import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotchSurface } from "../components/NotchSurface";
import type { NormalizedAccount } from "../lib/accounts";

const account = (overrides: {
  id: string;
  provider: string;
  email?: string;
  usedPercent?: number | null;
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
    health: "available",
    healthRaw: "available",
    cooldownUntilUnixMs: null,
    cooldownRemainingSecs: null,
    ok: 0,
    fails: 0,
    failureRate: 0,
    p50Ms: null,
    lastError: null,
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
    canReset: true,
    resetCreditsAvailable: 0,
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
    render(<NotchSurface accounts={[]} loadState="loading" showRemaining={false} />);

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
      />,
    );

    const tooltip = screen.getByTestId("notch-tooltip-empty");
    expect(tooltip.getAttribute("data-empty-state")).toBe("stopped");
    expect(tooltip.textContent).not.toMatch(/No accounts connected/);
    expect(screen.queryByTestId("notch-ring-codex")).toBeNull();
  });

  it("keeps the onboarding copy for a true empty state", () => {
    render(<NotchSurface accounts={[]} loadState="online" showRemaining={false} />);

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
  it("clamps over-100% usage to match the arc", () => {
    const { container } = render(
      <NotchSurface
        accounts={[account({ id: "a1", provider: "codex", usedPercent: 105 })]}
        loadState="online"
        showRemaining={false}
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
      />,
    );

    expect(container.querySelector(".notch-dial-label")?.textContent).toBe("0%");
  });
});

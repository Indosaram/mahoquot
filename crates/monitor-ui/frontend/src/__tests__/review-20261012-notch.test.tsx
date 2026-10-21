import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NotchLocalPoint, NotchSurface } from "../components/NotchSurface";
import type { NormalizedAccount } from "../lib/accounts";

const codex = {
  id: "a1",
  runtimeId: null,
  credentialName: null,
  authIndex: null,
  provider: "codex",
  plan: null,
  email: "one@example.test",
  label: "one@example.test",
  health: "available",
  healthRaw: "available",
  cooldownUntilUnixMs: null,
  cooldownRemainingSecs: null,
  ok: 0,
  fails: 0,
  failureRate: 0,
  p50Ms: null,
  lastError: null,
  usage: null,
  quotaCapability: "supported",
  isCredentialOnly: false,
  canReset: true,
  resetCreditsAvailable: 0,
} as unknown as NormalizedAccount;

const renderNotch = (props: { notchExpanded: boolean; nativeCursor: NotchLocalPoint | null }) => (
  <NotchSurface accounts={[codex]} loadState="online" showRemaining={false} {...props} />
);

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "__TAURI__");
});

describe("NotchSurface native hover is prop-driven (C4)", () => {
  it("expands from the notchExpanded prop only", () => {
    const { container, rerender } = render(
      renderNotch({ notchExpanded: false, nativeCursor: null }),
    );
    expect(container.querySelector(".notch-shell")).not.toHaveClass("expanded");

    rerender(renderNotch({ notchExpanded: true, nativeCursor: null }));
    expect(container.querySelector(".notch-shell")).toHaveClass("expanded", "open");
    expect(container.querySelector(".notch-surface")).toHaveClass("expanded");
  });

  it("subscribes to no window or Tauri hover/cursor events itself", () => {
    const listen = vi.fn(() => Promise.resolve(() => undefined));
    Object.assign(window, { __TAURI__: { event: { listen } } });
    const addSpy = vi.spyOn(window, "addEventListener");
    const { container } = render(renderNotch({ notchExpanded: false, nativeCursor: null }));

    expect(listen).not.toHaveBeenCalled();
    expect(
      addSpy.mock.calls.filter(([type]) => String(type).startsWith("mahoquot:notch")),
    ).toHaveLength(0);

    act(() => {
      window.dispatchEvent(new CustomEvent("mahoquot:notch-hover", { detail: true }));
    });
    expect(container.querySelector(".notch-shell")).not.toHaveClass("expanded");
  });

  it("opens provider detail from the nativeCursor prop while expanded", () => {
    const { rerender } = render(renderNotch({ notchExpanded: true, nativeCursor: null }));
    const ring = screen.getByTestId("notch-ring-codex");
    vi.spyOn(ring, "getBoundingClientRect").mockReturnValue({
      x: 350,
      y: 210,
      left: 350,
      top: 210,
      right: 393,
      bottom: 253,
      width: 43,
      height: 43,
      toJSON: () => ({}),
    });

    rerender(renderNotch({ notchExpanded: true, nativeCursor: { x: 370, y: 230 } }));
    expect(ring.parentElement).toHaveClass("react-visible");
  });

  it("closes the open tooltip when notchExpanded drops back to false", () => {
    const { rerender } = render(renderNotch({ notchExpanded: true, nativeCursor: null }));
    const ring = screen.getByTestId("notch-ring-codex");
    act(() => {
      ring.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      ring.click();
    });
    expect(ring.parentElement).toHaveClass("react-visible");

    rerender(renderNotch({ notchExpanded: false, nativeCursor: null }));
    expect(ring.parentElement).not.toHaveClass("react-visible");
  });
});

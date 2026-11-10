// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "../../../crates/monitor-ui/frontend/node_modules/vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandRow } from "../components/sections/install";
import { DitherArea } from "../components/dither-area";

let host: HTMLDivElement;
let root: Root;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

const state = () => host.querySelector("[data-copy-state]")?.getAttribute("data-copy-state");
const click = () => act(() => host.querySelector("button")!.click());
const mountCommand = () => act(() => root.render(<CommandRow label="Example" cmd="echo local" />));
function clipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: writeText ? { writeText } : undefined });
}

describe("SI03 clipboard ownership", () => {
  it("copies exact bytes and gives the latest success a full reset interval", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    clipboard(write);
    await mountCommand();
    await click();
    expect(write).toHaveBeenCalledWith("echo local");
    expect(state()).toBe("copied");
    await act(() => vi.advanceTimersByTime(1000));
    await click();
    await act(() => vi.advanceTimersByTime(600));
    expect(state()).toBe("copied");
    await act(() => vi.advanceTimersByTime(1000));
    expect(state()).toBe("idle");
    await click();
    await act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["missing", "rejected"])("handles %s clipboard locally", async (mode) => {
    clipboard(mode === "missing" ? undefined : () => Promise.reject(new Error("denied")));
    await mountCommand();
    await click();
    expect(state()).toBe("error");
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(host.querySelector("code")?.textContent).toBe("echo local");
    clipboard(() => Promise.resolve());
    await click();
    expect(state()).toBe("copied");
  });

  it("ignores obsolete completion and completion after unmount", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    clipboard(vi.fn().mockReturnValueOnce(pending).mockRejectedValueOnce(new Error("denied")));
    await mountCommand();
    await click();
    await click();
    await act(async () => { resolve(); await pending; });
    expect(state()).toBe("error");
    let release!: () => void;
    const late = new Promise<void>((done) => { release = done; });
    clipboard(() => late);
    await click();
    await act(() => root.render(null));
    await act(async () => { release(); await late; });
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("SI07 paints without bloom, reconfigures layers, resizes and disconnects", async () => {
  const fillRect = vi.fn();
  const clearRect = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ fillRect, clearRect, fillStyle: "" }) as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(80);
  const observers: { draw: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn();
    constructor(readonly draw: () => void) { observers.push(this); }
    observe() {}
  });
  const values = [1, 3, 2];
  const seed = { fill: [240, 134, 42], line: [242, 242, 242] } as const;
  const render = (bloom: boolean) => act(() => root.render(<DitherArea values={values} seed={seed} height={40} ariaLabel="Fixture" bloom={bloom} />));
  await render(false);
  expect(fillRect).toHaveBeenCalled();
  expect(host.querySelectorAll("canvas")).toHaveLength(1);
  await render(true);
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
  expect(host.querySelectorAll("canvas")).toHaveLength(2);
  fillRect.mockClear();
  await act(() => observers[1].draw());
  expect(fillRect).toHaveBeenCalled();
  await render(false);
  expect(observers[1].disconnect).toHaveBeenCalledOnce();
  expect(host.querySelectorAll("canvas")).toHaveLength(1);
  fillRect.mockClear();
  await act(() => observers[2].draw());
  expect(fillRect).toHaveBeenCalled();
  await act(() => root.render(null));
  expect(observers[2].disconnect).toHaveBeenCalledOnce();
});

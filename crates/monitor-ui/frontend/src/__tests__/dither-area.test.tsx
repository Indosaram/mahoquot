import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DitherArea } from "../components/dither-area";

const SEED = { fill: [240, 128, 26], line: [255, 178, 102] } as const;
const HOST_WIDTH = 240;
const HEIGHT = 40;

interface PaintCall {
  readonly x: number;
  readonly y: number;
  readonly style: string;
}

/** The shared canvas stub in test-setup reports zero size, which makes every
 * paint loop exit before drawing; these tests need a measurable host and a
 * recording 2D context to observe the pixels at all. */
const recordingContexts: Array<{ readonly calls: PaintCall[]; readonly cleared: number }> = [];

const install = () => {
  recordingContexts.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    const calls: PaintCall[] = [];
    const record = { calls, cleared: 0 };
    recordingContexts.push(record);
    const sink = {
      fillStyle: "",
      fillRect(x: number, y: number) {
        calls.push({ x, y, style: String(sink.fillStyle) });
      },
      clearRect() {
        record.cleared += 1;
      },
    };
    return sink as unknown as CanvasRenderingContext2D;
  });
  Object.defineProperty(HTMLDivElement.prototype, "clientWidth", {
    configurable: true,
    get: () => HOST_WIDTH,
  });
};

beforeEach(install);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLDivElement.prototype, "clientWidth");
});

describe("DitherArea", () => {
  it("paints the series onto a half-resolution backing canvas and its bloom layer", () => {
    render(
      <DitherArea values={[1, 4, 2, 8]} seed={SEED} height={HEIGHT} ariaLabel="Request activity" />,
    );

    const canvases = Array.from(
      screen.getByRole("img", { name: "Request activity" }).querySelectorAll("canvas"),
    );
    expect(canvases).toHaveLength(2);
    for (const canvas of canvases) {
      expect(canvas.width).toBe(HOST_WIDTH / 2);
      expect(canvas.height).toBe(HEIGHT / 2);
    }

    expect(recordingContexts).toHaveLength(2);
    for (const context of recordingContexts) {
      expect(context.cleared).toBe(1);
      expect(context.calls.length).toBeGreaterThan(0);
      expect(context.calls.every((call) => call.style.startsWith("rgba("))).toBe(true);
      expect(context.calls.some((call) => call.style.startsWith("rgba(240,128,26,"))).toBe(true);
      expect(context.calls.some((call) => call.style.startsWith("rgba(255,178,102,"))).toBe(true);
      expect(context.calls.every((call) => call.x >= 0 && call.x < HOST_WIDTH / 2)).toBe(true);
      expect(context.calls.every((call) => call.y >= 0 && call.y < HEIGHT / 2)).toBe(true);
    }
  });

  it("repaints when the series changes", () => {
    const view = render(
      <DitherArea values={[1, 4, 2, 8]} seed={SEED} height={HEIGHT} ariaLabel="Request activity" />,
    );
    const first = recordingContexts.length;

    view.rerender(
      <DitherArea values={[8, 2, 4, 1]} seed={SEED} height={HEIGHT} ariaLabel="Request activity" />,
    );

    expect(recordingContexts.length).toBe(first * 2);
    expect(recordingContexts.at(-1)?.calls.length).toBeGreaterThan(0);
  });

  it("sizes the canvas but paints nothing when there is no series to draw", () => {
    render(<DitherArea values={[7]} seed={SEED} height={HEIGHT} ariaLabel="Single sample" />);

    const canvas = screen
      .getByRole("img", { name: "Single sample" })
      .querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(HOST_WIDTH / 2);
    expect(recordingContexts).toHaveLength(0);
  });
});

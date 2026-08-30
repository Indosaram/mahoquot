/**
 * Canvas dithered-area painting, ported from kiro-lb's dither-kit
 * (https://github.com/minpeter/kiro-lb, AGPL-3.0) — algorithm and constants
 * follow the reference implementation so the rendered look matches.
 *
 * Ordered dithering: a Bayer-4x4 threshold per backing cell decides lit/unlit
 * at the local density; alpha varies with density, dissolving toward the value
 * line. The backing canvas is half CSS resolution and is upscaled `pixelated`,
 * which is what makes the fill read as chunky pixels rather than a gradient.
 */

const CELL = 2;
const MAX_COLS = 520;
const MAX_ROWS = 200;
const OFF_TIER = 0.4;
const BORDER_ALPHA = 0.72;
const FEATHER_ALPHA = 0.36;

const BAYER: readonly number[][] = (
  [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ] as const
).map((row) => row.map((value) => value / 16));

export const bayerThreshold = (col: number, row: number): number =>
  BAYER[row & 3]![col & 3]!;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type DitherSeed = {
  readonly fill: readonly [number, number, number];
  readonly line: readonly [number, number, number];
};

export interface PaintCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly style: string;
}

export interface PixelSink {
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  fillRect(x: number, y: number, w: number, h: number): void;
}

export interface PaintOptions {
  readonly intensity?: number;
  readonly dim?: number;
  readonly dotted?: boolean;
}

export function backingSize(cssWidth: number, cssHeight: number) {
  return {
    cols: Math.max(1, Math.min(Math.floor(cssWidth / CELL), MAX_COLS)),
    rows: Math.max(1, Math.min(Math.floor(cssHeight / CELL), MAX_ROWS)),
  };
}

export function resample(
  source: readonly number[],
  cols: number,
): readonly number[] {
  if (source.length === cols) return source.slice();
  const out: number[] = [];
  for (let col = 0; col < cols; col += 1) {
    const at = (source.length - 1) * (cols === 1 ? 0 : col / (cols - 1));
    const low = Math.floor(at);
    const high = Math.min(source.length - 1, low + 1);
    out.push(source[low]! + (source[high]! - source[low]!) * (at - low));
  }
  return out;
}

export function cellAlpha(
  density: number,
  lit: boolean,
  intensity: number,
  dim: number,
): number {
  const base = 0.3 + density * 0.7;
  const alpha = base * (1 + 0.22 * intensity);
  return (lit ? alpha : alpha * OFF_TIER) * dim;
}

export function paintColumn(
  sink: PixelSink,
  x: number,
  top: number,
  floor: number,
  seed: DitherSeed,
  options: PaintOptions = {},
): void {
  const intensity = options.intensity ?? 0;
  const dim = options.dim ?? 1;
  const bias = options.dotted ? 0.12 : 0;
  const [fr, fg, fb] = seed.fill;
  const [lr, lg, lb] = seed.line;
  const depth = floor - top;

  if (depth <= 0) {
    sink.fillStyle = `rgba(${lr},${lg},${lb},${BORDER_ALPHA * dim})`;
    sink.fillRect(x, top, 1, 1);
    return;
  }

  const topRow = Math.floor(top);
  const bottom = Math.floor(floor);
  for (let y = topRow; y < bottom; y += 1) {
    const density = Math.min(1, Math.max(0, (y - top) / depth));
    const lit = density > bayerThreshold(x, y) - 0.1 * intensity - bias;
    sink.fillStyle = `rgba(${fr},${fg},${fb},${cellAlpha(density, lit, intensity, dim)})`;
    sink.fillRect(x, y, 1, 1);
  }

  sink.fillStyle = `rgba(${lr},${lg},${lb},${BORDER_ALPHA * dim})`;
  sink.fillRect(x, topRow, 1, 1);
  sink.fillStyle = `rgba(${lr},${lg},${lb},${FEATHER_ALPHA * dim})`;
  sink.fillRect(x, topRow + 1, 1, 1);
}

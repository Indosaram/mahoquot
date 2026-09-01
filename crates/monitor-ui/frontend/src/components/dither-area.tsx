import { type DitherSeed, backingSize, paintColumn, resample } from "@/lib/dither";
import { useEffect, useRef } from "react";

interface DitherAreaProps {
  readonly values: readonly number[];
  readonly seed: DitherSeed;
  readonly height: number;
  readonly ariaLabel: string;
  readonly bloom?: boolean;
  readonly className?: string;
}

/** Canvas dithered area chart rendering the dither-kit look: a half-resolution
 * backing canvas painted with Bayer-ordered dithering, upscaled `pixelated`,
 * plus a blurred bloom layer blended additively. Repaints on resize and when
 * the series changes; the fill is static — no hover feedback. */
export function DitherArea({
  values,
  seed,
  height,
  ariaLabel,
  bloom = true,
  className,
}: DitherAreaProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const paintRef = useRef<HTMLCanvasElement>(null);
  const bloomRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const paint = paintRef.current;
    const bloom = bloomRef.current;
    if (!host || !paint || !bloom) return;

    const draw = () => {
      const width = host.clientWidth;
      const { cols, rows } = backingSize(width, height);
      paint.width = cols;
      paint.height = rows;
      bloom.width = cols;
      bloom.height = rows;
      if (cols < 2 || values.length < 2) return;

      const max = Math.max(1, ...values);
      const fractions = values.map((value) => value / max);
      const columns = resample(fractions, cols);
      const floor = rows - 1;
      const sink = paint.getContext("2d");
      const bloomSink = bloom.getContext("2d");
      if (!sink || !bloomSink) return;
      sink.clearRect(0, 0, cols, rows);
      bloomSink.clearRect(0, 0, cols, rows);
      for (let col = 0; col < cols; col += 1) {
        const depth = Math.round(columns[col] * (floor - 1));
        paintColumn(sink, col, floor - depth, floor, seed, { intensity: 0.4 });
        paintColumn(bloomSink, col, floor - depth, floor, seed, {
          intensity: 0.7,
        });
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(host);
    return () => observer.disconnect();
  }, [values, seed, height]);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ position: "relative", height }}
      role="img"
      aria-label={ariaLabel}
    >
      <canvas ref={paintRef} style={canvasStyle} />
      {bloom ? <canvas ref={bloomRef} style={{ ...canvasStyle, ...bloomStyle }} /> : null}
    </div>
  );
}

const canvasStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "block",
  imageRendering: "pixelated",
};

const bloomStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  filter: "blur(6px)",
  mixBlendMode: "plus-lighter",
  opacity: 0.5,
  pointerEvents: "none",
};

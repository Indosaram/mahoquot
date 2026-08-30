import { DitherArea } from "@/components/dither-area";
import { RATE_TOTALS } from "@/content/site";

const TOTALS = [...RATE_TOTALS];

export function RateChartCard() {
  const total = TOTALS.reduce((a, b) => a + b, 0);

  return (
    <figure className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="flex items-baseline justify-between border-b border-line px-6 py-5">
        <h3 className="text-[16px] font-medium text-ink">Request rate</h3>
        <span className="font-mono text-[11px] text-ink-ghost">26m</span>
      </div>

      <div className="px-2 pb-2 pt-4">
        <DitherArea
          values={TOTALS}
          seed={{ fill: [240, 128, 26], line: [255, 178, 102] }}
          height={190}
          ariaLabel={`Request rate per minute across the pool, peaking at ${Math.max(...TOTALS)} requests`}
        />
        <div className="flex justify-between px-4 pt-1 font-mono text-[10px] text-ink-ghost">
          <span>-26 min</span>
          <span>now</span>
        </div>
      </div>

      <figcaption className="border-t border-line px-6 py-3.5 text-[13px] text-ink-faint">
        Strict round-robin: {total.toLocaleString()} requests split{" "}
        {Math.round(total / 3).toLocaleString()} / {Math.round(total / 3).toLocaleString()} /{" "}
        {Math.round(total / 3).toLocaleString()} per account (±1).
      </figcaption>
    </figure>
  );
}

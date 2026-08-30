import { RATE_ACCOUNTS, RATE_TOTALS } from "@/content/site";

const TOTAL_W = 720;
const TOTAL_H = 150;
const PANEL_W = 240;
const PANEL_H = 88;
const PAD = 8;

function geometry(values: readonly number[], max: number, w: number, h: number) {
  const n = values.length;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => h - PAD - (v / max) * (h - PAD * 2);
  const line = values
    .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const area = `0,${h - 2} ${line} ${(n - 1 === 0 ? w : x(n - 1)).toFixed(1)},${h - 2}`;
  return { line, area };
}

export function RateChartCard() {
  const totalMax = Math.max(...RATE_TOTALS);
  const total = geometry(RATE_TOTALS, totalMax, TOTAL_W, TOTAL_H);

  return (
    <figure className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="border-b border-line px-6 py-5">
        <h3 className="text-[16px] font-medium text-ink">Request rate</h3>
        <p className="mt-1.5 text-[13px] text-ink-faint">
          Per-minute requests across the {RATE_ACCOUNTS.length}-account pool over
          26 minutes — {RATE_TOTALS.reduce((a, b) => a + b, 0).toLocaleString()}{" "}
          requests, every bucket served without a failure.
        </p>
      </div>

      <div className="px-6 pb-2 pt-5">
        <svg
          viewBox={`0 0 ${TOTAL_W} ${TOTAL_H}`}
          className="h-36 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Total requests per minute across the pool, peaking at ${totalMax} requests in one minute`}
        >
          <title>Total request rate per minute</title>
          <defs>
            <linearGradient id="rate-total-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`M0 ${TOTAL_H / 2}H${TOTAL_W}`} stroke="var(--color-line-soft)" strokeWidth="1" />
          <polygon points={total.area} fill="url(#rate-total-fill)" />
          <polyline
            points={total.line}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-ghost">
          <span>-26 min</span>
          <span>now</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 border-t border-line-soft p-4 sm:grid-cols-3">
        {RATE_ACCOUNTS.map((account) => {
          const max = Math.ceil((account.peak * 1.12) / 10) * 10;
          const g = geometry(account.values, max, PANEL_W, PANEL_H);
          return (
            <figure
              key={account.name}
              className="rounded-xl border border-line bg-page-raised p-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <code className="font-mono text-[12px] text-ink">{account.name}</code>
                <span className="tnum text-[11px] text-ink-faint">
                  {account.peak}/min peak
                </span>
              </div>
              <svg
                viewBox={`0 0 ${PANEL_W} ${PANEL_H}`}
                className="mt-2 h-20 w-full"
                preserveAspectRatio="none"
                role="img"
                aria-label={`Requests per minute for ${account.name}, peaking at ${account.peak}`}
              >
                <title>{`${account.name} request rate`}</title>
                <defs>
                  <linearGradient id={`rate-${account.name}-fill`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.24" />
                    <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={`M0 ${PANEL_H / 2}H${PANEL_W}`} stroke="var(--color-line-soft)" strokeWidth="1" />
                <polygon points={g.area} fill={`url(#rate-${account.name}-fill)`} />
                <polyline
                  points={g.line}
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </figure>
          );
        })}
      </div>

      <figcaption className="border-t border-line px-6 py-3.5 text-[13px] text-ink-faint">
        Strict round-robin splits every minute within ±1 request —{" "}
        {RATE_ACCOUNTS.map((a) => a.values.reduce((s, v) => s + v, 0).toLocaleString()).join(" / ")}{" "}
        requests per account over the window.
      </figcaption>
    </figure>
  );
}

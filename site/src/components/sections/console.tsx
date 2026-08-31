import { DitherArea } from "@/components/dither-area";
import { RATE_TOTALS } from "@/content/site";

const TOTALS = [...RATE_TOTALS];
  const total = TOTALS.reduce((a, b) => a + b, 0);

export function Console() {
  return (
    <section id="console" className="border-b border-line bg-page-raised">
      <div className="mx-auto max-w-[1400px] px-6 py-24">
        <div className="grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="flex flex-col justify-center">
            <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-ink-faint">
              Operations console
            </p>
            <h2 className="mt-4 text-[clamp(1.9rem,3.2vw,2.6rem)] font-medium leading-[1.12] tracking-[-0.01em] text-ink">
              Your pool, your machine, your numbers.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[16px] leading-relaxed text-ink-muted">
              The console ships with the proxy — live pool health, per-minute
              request rates and credential lifecycle, rendered straight from
              the gateway as it runs.
            </p>

            <p className="mt-5 text-[13px] leading-relaxed text-ink-ghost">
              Screenshots: the shipping console rendering a 26-minute burst run
              from <code className="font-mono">tools/bench</code>. Figures here
              are from the repository benchmark suite.
            </p>
          </div>

          <figure className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface">
            <img
              src="shots/console-accounts.png"
              alt="Accounts surface listing three pooled Codex accounts with health badges and refresh controls"
              width={1280}
              height={820}
              className="w-full"
            />
            <figcaption className="mt-auto border-t border-line px-5 py-3.5 text-[13px] text-ink-faint">
              Accounts — pool health, quota state and credential lifecycle
            </figcaption>
          </figure>
        </div>

        <figure className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
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
      </div>
    </section>
  );
}

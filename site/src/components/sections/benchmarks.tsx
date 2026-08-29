import { BENCH_CAPTION, BENCH_ROWS, OVERHEAD_ROWS } from "@/content/site";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { cn } from "@/lib/utils";

export function Benchmarks() {
  return (
    <section id="benchmarks" className="border-b border-line">
      <div className="mx-auto max-w-[1400px] px-6 py-24">
        <SectionHeader
          eyebrow="Measured, not claimed"
          title="Faster where the stream actually lives."
          lead="Real LLM streams run hundreds to thousands of chunks, so per-chunk cost is the dominant architectural difference — not the handshake."
        />

        <Card className="mt-12">
          <CardHeader>
            <CardTitle>Fair translation benchmark</CardTitle>
            <CardDescription className="max-w-3xl leading-relaxed">
              {BENCH_CAPTION}
            </CardDescription>
          </CardHeader>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-[0.1em] text-ink-ghost">
                  <th className="px-6 py-3 font-medium">Load</th>
                  <th className="px-6 py-3 font-medium">Tier</th>
                  <th className="px-6 py-3 text-right font-medium">p50 TTFT</th>
                  <th className="px-6 py-3 text-right font-medium">p99 TTFT</th>
                  <th className="px-6 py-3 text-right font-medium">RPS</th>
                </tr>
              </thead>
              <tbody>
                {BENCH_ROWS.map((row) => (
                  <tr
                    key={`${row.load}-${row.tier}`}
                    className="border-b border-line-soft text-[14px] last:border-b-0"
                  >
                    <td className="px-6 py-3.5 text-ink-ghost">{row.load}</td>
                    <td
                      className={cn(
                        "px-6 py-3.5",
                        row.best ? "font-medium text-accent" : "text-ink-muted",
                      )}
                    >
                      {row.tier}
                    </td>
                    <td className={cn("tnum px-6 py-3.5 text-right", row.best ? "text-ink" : "text-ink-muted")}>
                      {row.p50}
                    </td>
                    <td className={cn("tnum px-6 py-3.5 text-right", row.best ? "text-ink" : "text-ink-muted")}>
                      {row.p99}
                    </td>
                    <td className={cn("tnum px-6 py-3.5 text-right", row.best ? "text-ink" : "text-ink-muted")}>
                      {row.rps}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <CardFooter>
            <p className="text-[13px] leading-relaxed text-ink-muted">
              Paired deltas —{" "}
              <span className="text-ink">Mahoquot wins 6 of 6 rounds on every metric</span>
              : +10.5 ms p50 and +43.7 ms p99 at 20 chunks, +49.8 ms p50 and
              +311.8 ms p99 at 200 chunks. Per relayed chunk Mahoquot costs about
              58 us against CLIProxyAPI's 378 us.
            </p>
          </CardFooter>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Gateway overhead vs direct upstream</CardTitle>
            <CardDescription>
              Sign-consistent paired deltas. Median proxy cost is 1-3 ms and real.
            </CardDescription>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-[0.1em] text-ink-ghost">
                  <th className="px-6 py-3 font-medium">Metric</th>
                  <th className="px-6 py-3 text-right font-medium">@100</th>
                  <th className="px-6 py-3 text-right font-medium">@500</th>
                  <th className="px-6 py-3 text-right font-medium">@1000</th>
                </tr>
              </thead>
              <tbody>
                {OVERHEAD_ROWS.map((row) => (
                  <tr key={row.metric} className="border-b border-line-soft text-[14px] last:border-b-0">
                    <td className="px-6 py-3.5 text-ink-muted">{row.metric}</td>
                    <td className="tnum px-6 py-3.5 text-right text-ink">{row.c100}</td>
                    <td className="tnum px-6 py-3.5 text-right text-ink">{row.c500}</td>
                    <td className="tnum px-6 py-3.5 text-right text-ink">{row.c1000}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </section>
  );
}

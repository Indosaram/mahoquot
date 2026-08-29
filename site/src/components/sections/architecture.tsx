import { Check, Minus } from "lucide-react";
import { CRATES, MATRIX_ROWS } from "@/content/site";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";

function Mark({ on }: { on: boolean }) {
  return on ? (
    <Check className="mx-auto h-4 w-4 text-accent" strokeWidth={2.5} />
  ) : (
    <Minus className="mx-auto h-4 w-4 text-ink-ghost" />
  );
}

export function Architecture() {
  return (
    <section id="architecture" className="border-b border-line bg-page-raised">
      <div className="mx-auto max-w-[1400px] px-6 py-24">
        <SectionHeader
          eyebrow="Architecture"
          title="Route-for-route parity, rebuilt lock-free."
          lead="A faithful Rust reimplementation of CLIProxyAPI verified against a live upstream instance. Divergence is not the goal — speed and transparency are."
        />

        <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Direct feature matrix</CardTitle>
              <CardDescription>
                Mahoquot Rust core against the incumbent Go proxy
              </CardDescription>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-[0.1em] text-ink-ghost">
                    <th className="px-6 py-3 font-medium">Capability</th>
                    <th className="w-[120px] px-4 py-3 text-center font-medium text-accent">
                      Mahoquot
                    </th>
                    <th className="w-[130px] px-4 py-3 text-center font-medium">
                      CLIProxyAPI
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {MATRIX_ROWS.map((row) => (
                    <tr
                      key={row.capability}
                      className="border-b border-line-soft text-[14px] last:border-b-0"
                    >
                      <td className="px-6 py-3.5 text-ink-muted">
                        {row.capability}
                      </td>
                      <td className="px-4 py-3.5">
                        <Mark on={row.mahoquot} />
                      </td>
                      <td className="px-4 py-3.5">
                        <Mark on={row.incumbent} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Workspace layout</CardTitle>
              <CardDescription>
                Five crates, strictly layered
              </CardDescription>
            </CardHeader>
            <CardContent>
              {CRATES.map((crate, i) => (
                <div
                  key={crate.name}
                  className={
                    i === 0 ? "py-4" : "border-t border-line-soft py-4"
                  }
                >
                  <code className="font-mono text-[13px] text-accent">
                    {crate.name}
                  </code>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-ink-muted">
                    {crate.role}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

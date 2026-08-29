import { useState } from "react";
import { Check } from "lucide-react";
import { FEATURES } from "@/content/site";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/ui/section-header";

export function Features() {
  const [active, setActive] = useState(FEATURES[0]!.id);
  const current = FEATURES.find((f) => f.id === active) ?? FEATURES[0]!;

  return (
    <section id="features" className="border-b border-line">
      <div className="mx-auto max-w-[1400px] px-6 py-24">
        <SectionHeader
          eyebrow="Why Mahoquot"
          title="Fairness, failover, and effectively no overhead."
          lead="Success is invisibility — your agent never stalls on a quota wall, and the proxy adds negligible latency to a stream it did not need to touch."
        />

        <div className="mt-14 flex gap-1.5 overflow-x-auto pb-px">
          {FEATURES.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setActive(f.id)}
              aria-pressed={f.id === active}
              className={cn(
                "shrink-0 rounded-t-xl border border-b-0 px-5 py-3 text-[12px] font-medium uppercase tracking-[0.1em] transition-colors",
                f.id === active
                  ? "border-line bg-surface text-ink"
                  : "border-transparent text-ink-faint hover:text-ink-muted",
              )}
            >
              {f.tab}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl rounded-tl-none border border-line bg-line lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="bg-surface p-9">
            <h3 className="text-[22px] font-medium tracking-[-0.01em] text-ink">
              {current.title}
            </h3>
            <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">
              {current.description}
            </p>
            <ul className="mt-8 space-y-3">
              {current.points.map((point) => (
                <li
                  key={point}
                  className="flex items-start gap-2.5 text-[14px] text-ink-faint"
                >
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  {point}
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-page-raised p-9">
            <ul className="space-y-px">
              {FEATURES.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => setActive(f.id)}
                    className={cn(
                      "flex w-full items-baseline gap-4 rounded-lg px-4 py-3.5 text-left transition-colors",
                      f.id === active
                        ? "bg-surface text-ink"
                        : "text-ink-faint hover:bg-surface/50 hover:text-ink-muted",
                    )}
                  >
                    <span className="tnum shrink-0 font-mono text-[12px] text-ink-ghost">
                      {String(FEATURES.indexOf(f) + 1).padStart(2, "0")}
                    </span>
                    <span className="text-[15px] font-medium">{f.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

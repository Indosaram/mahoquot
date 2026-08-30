import { ArrowUpRight } from "lucide-react";
import { GithubMark } from "@/components/github-mark";
import { ButtonLink } from "@/components/ui/button";
import { HERO_STATS, PRODUCT, PROVIDERS, REPO_URL, DOCS_URL } from "@/content/site";

export function Hero() {
  return (
    <section id="top" className="relative border-b border-line pt-16">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="flex flex-col justify-center px-6 py-20 lg:py-28">
          <h1 className="max-w-[16ch] text-[clamp(2.5rem,4.6vw,3.6rem)] font-medium leading-[1.06] tracking-[-0.01em] text-ink">
            One local endpoint for every LLM account you own
          </h1>

          <p className="mt-6 max-w-[52ch] text-[16px] leading-[1.65] text-ink-muted">
            <span className="text-accent">Route</span>, refresh, and fail over
            across your Codex, Claude, Antigravity, Cursor and Kiro
            subscriptions. Mahoquot is a high-concurrency inference proxy in
            Rust that keeps your agent from stalling on a quota wall.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <ButtonLink
              variant="primary"
              size="md"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="gap-2"
            >
              <GithubMark className="h-4 w-4" />
              View on GitHub
            </ButtonLink>
            <ButtonLink
              variant="outline"
              size="md"
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="gap-1.5"
            >
              Read the docs
              <ArrowUpRight className="h-3.5 w-3.5" />
            </ButtonLink>
          </div>

          <div className="mt-8 flex items-center gap-2.5 font-mono text-[13px] text-ink-faint">
            <span className="text-ink-ghost">$</span>
            <span className="text-ink-muted">cargo run -p mahoquot-gateway</span>
            <span className="text-ink-ghost">:{PRODUCT.port}</span>
          </div>

          <dl className="mt-12 grid grid-cols-3 gap-6 border-t border-line pt-8">
            {HERO_STATS.map((stat) => (
              <div key={stat.label}>
                <dt className="tnum text-[24px] font-medium tracking-[-0.01em] text-ink">
                  {stat.value}
                </dt>
                <dd className="mt-1 text-[12px] leading-snug text-ink-faint">
                  {stat.label}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative flex items-center overflow-hidden border-line px-6 pb-20 lg:border-l lg:py-28 lg:pl-14 lg:pr-0">
          <img
            src="shots/console-overview.png"
            alt="Mahoquot operations console showing 16,950 relayed requests at 100% success across a three-account Codex pool"
            width={1280}
            height={656}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            className="w-full rounded-l-2xl border border-line shadow-panel lg:min-w-[760px]"
          />
        </div>
      </div>

      <div className="border-t border-line py-7">
        <div className="mask-fade-edges flex overflow-hidden">
          <div
            data-marquee-track
            className="animate-marquee flex w-max items-center"
          >
            {[...PROVIDERS, ...PROVIDERS].map((p, i) => (
              <span
                key={`${p.name}-${i}`}
                data-marquee-item
                className="flex shrink-0 items-center gap-2.5 px-9 text-[15px] font-medium text-ink-faint"
              >
                <span
                  aria-hidden="true"
                  className="h-5 w-5 bg-ink-ghost"
                  style={{
                    maskImage: `url(brand/${p.file})`,
                    WebkitMaskImage: `url(brand/${p.file})`,
                    maskSize: "contain",
                    WebkitMaskSize: "contain",
                    maskRepeat: "no-repeat",
                    WebkitMaskRepeat: "no-repeat",
                    maskPosition: "center",
                    WebkitMaskPosition: "center",
                  }}
                />
                {p.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

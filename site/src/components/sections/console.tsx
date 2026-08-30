import { LIVE_RUN } from "@/content/site";
import { SectionHeader } from "@/components/ui/section-header";

const MEASURED = [
  { label: "Requests relayed", value: LIVE_RUN.requests },
  { label: "Success rate", value: LIVE_RUN.success },
  { label: "Failed over", value: LIVE_RUN.failedOver },
  { label: "Pooled accounts", value: LIVE_RUN.accounts },
];

const LATENCY = [
  { label: "p50 TTFT", value: `${LIVE_RUN.p50} ms` },
  { label: "p90 TTFT", value: `${LIVE_RUN.p90} ms` },
  { label: "p99 TTFT", value: `${LIVE_RUN.p99} ms` },
  { label: "Throughput", value: `${LIVE_RUN.rps} rps` },
];

export function Console() {
  return (
    <section id="console" className="border-b border-line bg-page-raised">
      <div className="mx-auto max-w-[1400px] px-6 py-24">
        <div className="grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="flex flex-col justify-center">
            <SectionHeader
              eyebrow="Measured, not mocked"
              title="Every number on this page came from a real run."
              lead={
                <>
                  Three pooled Codex accounts, {LIVE_RUN.requests} requests at
                  concurrency {LIVE_RUN.concurrency} driven through the release
                  build by{" "}
                  <code className="font-mono text-[15px]">tools/bench</code>,
                  read back from{" "}
                  <code className="font-mono text-[15px]">/admin/usage</code>{" "}
                  and rendered by the shipping console.
                </>
              }
            />

            <div className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line">
              {MEASURED.map((m) => (
                <div key={m.label} className="bg-surface px-6 py-5">
                  <div className="tnum text-[26px] font-medium tracking-[-0.01em] text-ink">
                    {m.value}
                  </div>
                  <div className="mt-1 text-[12px] text-ink-faint">
                    {m.label}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-4">
              {LATENCY.map((l) => (
                <div key={l.label} className="bg-surface px-5 py-4">
                  <div className="tnum text-[17px] font-medium text-ink">
                    {l.value}
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">
                    {l.label}
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-5 text-[13px] leading-relaxed text-ink-ghost">
              Latency sampled over {LIVE_RUN.samples} TTFT observations. Upstream
              was the deterministic mock in{" "}
              <code className="font-mono">tools/bench</code>, so these figures
              measure Mahoquot itself rather than a provider network.
            </p>
          </div>

          <figure className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface">
            <img
              src="shots/console-accounts.png"
              alt="Accounts surface listing three healthy pooled Codex accounts named alpha, bravo and charlie, each with warm up and refresh controls"
              width={1280}
              height={820}
              loading="lazy"
              decoding="async"
              className="w-full"
            />
            <figcaption className="mt-auto border-t border-line px-5 py-3.5 text-[13px] text-ink-faint">
              Accounts — pool health, quota state and credential lifecycle
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

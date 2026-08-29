import { useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { GithubMark } from "@/components/github-mark";
import { ButtonLink } from "@/components/ui/button";
import { CONTRACTS_URL, INSTALL_STEPS, REPO_URL } from "@/content/site";

function CommandRow({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-line py-5 sm:flex-row sm:items-center sm:gap-6">
      <span className="w-[190px] shrink-0 text-[14px] text-ink-faint">
        {label}
      </span>
      <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink">
        {cmd}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy: ${cmd}`}
        className="shrink-0 self-start rounded-md p-1.5 text-ink-ghost transition-colors hover:bg-surface hover:text-ink sm:self-auto"
      >
        {copied ? (
          <Check className="h-4 w-4 text-ok" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

export function Install() {
  return (
    <section id="install" className="border-b border-line">
      <div className="mx-auto max-w-[1400px] px-6 py-24">
        <div className="grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <div>
            <h2 className="text-[clamp(1.9rem,3.2vw,2.6rem)] font-medium leading-[1.12] tracking-[-0.01em] text-ink">
              Run it locally in three commands.
            </h2>
            <p className="mt-4 max-w-[44ch] text-[16px] leading-relaxed text-ink-muted">
              No cloud and no telemetry to anyone else's server. The gateway runs
              on your machine and your credentials never leave it.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink
                variant="primary"
                size="md"
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="gap-2"
              >
                <GithubMark className="h-4 w-4" />
                View source
              </ButtonLink>
              <ButtonLink
                variant="outline"
                size="md"
                href={CONTRACTS_URL}
                target="_blank"
                rel="noreferrer"
                className="gap-1.5"
              >
                Protocol contracts
                <ArrowUpRight className="h-3.5 w-3.5" />
              </ButtonLink>
            </div>
          </div>

          <div>
            {INSTALL_STEPS.map((step) => (
              <CommandRow key={step.cmd} {...step} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

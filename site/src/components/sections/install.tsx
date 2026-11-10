import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { GithubMark } from "@/components/github-mark";
import { ButtonLink } from "@/components/ui/button";
import { CONTRACTS_URL, INSTALL_STEPS, REPO_URL } from "@/content/site";

export function CommandRow({ label, cmd }: { label: string; cmd: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);

  useEffect(() => () => {
    generation.current += 1;
    clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    const request = ++generation.current;
    clearTimeout(timer.current);
    setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(cmd);
      if (request !== generation.current) return;
      setStatus("copied");
      timer.current = setTimeout(() => setStatus("idle"), 1600);
    } catch {
      if (request === generation.current) setStatus("error");
    }
  };

  return (
    <div className="border-t border-line py-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
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
        {status === "copied" ? (
          <Check className="h-4 w-4 text-ok" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" data-copy-state={status} className="mt-2 text-[13px] text-ink-muted">
        {status === "copied" ? "Command copied." : status === "error" ? "Could not copy. Select the command above and copy it manually." : ""}
      </p>
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
              Run the proxy. Add the desktop if you need it.
            </h2>
            <p className="mt-4 max-w-[44ch] text-[16px] leading-relaxed text-ink-muted">
              Start in a directory for both checkouts. The proxy needs Rust; the
              optional desktop needs Bun and the Tauri system prerequisites.
              Keep the proxy running and configure your client in another terminal.
              The auth directory stores your provider accounts; add an account
              before sending model requests.
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

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/globals.css";
import { Button, ButtonLink } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { GithubMark } from "@/components/github-mark";

const buttonVariants = [
  { id: "primary", label: "Primary", desc: "bg-ink text-page (High-priority action)" },
  { id: "secondary", label: "Secondary", desc: "border-line-strong bg-surface text-ink (Standard CTA)" },
  { id: "outline", label: "Outline", desc: "border-line-strong text-ink (Transparent alternative)" },
  { id: "ghost", label: "Ghost", desc: "text-ink-muted hover:text-ink (Low-emphasis action)" },
  { id: "link", label: "Link", desc: "text-ink-muted hover:text-ink underline/inline" },
] as const;

function ShowcaseApp() {
  return (
    <div className="min-h-screen bg-page text-ink-soft selection:bg-accent/25 selection:text-ink">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6 py-10 space-y-14">
        {/* Page Header */}
        <header className="border-b border-line pb-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-line-strong bg-surface px-3 py-1 text-[11px] font-mono uppercase tracking-[0.14em] text-accent">
              Design System Fixture
            </span>
            <span className="text-[12px] font-mono text-ink-ghost">
              Canvas: #020202
            </span>
          </div>
          <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-ink">
            UI Primitives Showcase &amp; Visual QA
          </h1>
          <p className="mt-2 text-sm text-ink-muted max-w-2xl">
            Live component verification surface for token fidelity, primitive variants, interactive states, and contrast ratios on dark canvas.
          </p>
        </header>

        {/* Primitive 1: Button & ButtonLink */}
        <section className="space-y-8" aria-labelledby="buttons-heading">
          <div className="border-b border-line pb-4">
            <h2 id="buttons-heading" className="text-xl font-medium text-ink">
              1. Button &amp; ButtonLink Primitives
            </h2>
            <p className="text-sm text-ink-muted">
              5 variants × 3 sizes (sm, md, lg) using design tokens for line, surface, ink, and focus ring.
            </p>
          </div>

          {/* Button Matrix - Responsive per-variant rows */}
          <div className="space-y-4">
            <h3 className="text-xs font-mono uppercase tracking-wider text-ink-faint">
              Button Variants × Sizes (sm / md / lg)
            </h3>
            <div className="grid grid-cols-1 gap-4">
              {buttonVariants.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-line bg-surface/60 p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="space-y-0.5 min-w-[200px]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-medium text-accent">
                        variant=&quot;{item.id}&quot;
                      </span>
                    </div>
                    <p className="text-xs text-ink-faint">{item.desc}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant={item.id} size="sm">
                      {item.label} (sm)
                    </Button>
                    <Button variant={item.id} size="md">
                      {item.label} (md)
                    </Button>
                    <Button variant={item.id} size="lg">
                      {item.label} (lg)
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ButtonLink Matrix */}
          <div className="space-y-4">
            <h3 className="text-xs font-mono uppercase tracking-wider text-ink-faint">
              ButtonLink Primitive (Anchor Semantics)
            </h3>
            <div className="rounded-xl border border-line bg-surface/60 p-4 sm:p-5 flex flex-wrap items-center gap-3">
              {buttonVariants.map((item) => (
                <ButtonLink
                  key={`link-${item.id}`}
                  variant={item.id}
                  size="md"
                  href="#buttons-heading"
                >
                  Link {item.label}
                </ButtonLink>
              ))}
            </div>
          </div>

          {/* Icon-in-Button & Composite Patterns */}
          <div className="space-y-4">
            <h3 className="text-xs font-mono uppercase tracking-wider text-ink-faint">
              Icon-in-Button Pattern (with GithubMark)
            </h3>
            <div className="rounded-xl border border-line bg-surface/60 p-4 sm:p-5 flex flex-wrap items-center gap-3">
              <Button variant="primary" size="sm" className="gap-2">
                <GithubMark className="h-4 w-4" />
                <span>GitHub sm</span>
              </Button>
              <Button variant="primary" size="md" className="gap-2">
                <GithubMark className="h-4 w-4" />
                <span>Star on GitHub</span>
              </Button>
              <Button variant="secondary" size="md" className="gap-2">
                <GithubMark className="h-4 w-4" />
                <span>View Source</span>
              </Button>
              <Button variant="outline" size="lg" className="gap-2">
                <GithubMark className="h-4 w-4" />
                <span>Documentation</span>
              </Button>
              <Button variant="ghost" size="md" className="gap-2">
                <GithubMark className="h-4 w-4" />
                <span>Repository</span>
              </Button>
            </div>
          </div>

          {/* Interactive States: Disabled & Focus */}
          <div className="space-y-4">
            <h3 className="text-xs font-mono uppercase tracking-wider text-ink-faint">
              Interactive States (Disabled + Focus Ring Token)
            </h3>
            <div className="rounded-xl border border-line bg-surface/60 p-4 sm:p-5 space-y-4">
              <div>
                <span className="text-xs text-ink-ghost block mb-2 font-mono">
                  Disabled States (opacity-50 pointer-events-none):
                </span>
                <div className="flex flex-wrap items-center gap-3">
                  {buttonVariants.map((item) => (
                    <Button key={`disabled-${item.id}`} variant={item.id} size="sm" disabled>
                      {item.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="pt-2 border-t border-line-soft">
                <span className="text-xs text-ink-ghost block mb-2 font-mono">
                  Simulated Focus Ring (focus-visible:ring-1 focus-visible:ring-ring / --color-ring: #f0862a):
                </span>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="primary" size="md" className="ring-1 ring-ring">
                    Primary + Focus
                  </Button>
                  <Button variant="secondary" size="md" className="ring-1 ring-ring">
                    Secondary + Focus
                  </Button>
                  <Button variant="outline" size="md" className="ring-1 ring-ring">
                    Outline + Focus
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Primitive 2: SectionHeader */}
        <section className="space-y-8" aria-labelledby="section-header-heading">
          <div className="border-b border-line pb-4">
            <h2 id="section-header-heading" className="text-xl font-medium text-ink">
              2. SectionHeader Primitive
            </h2>
            <p className="text-sm text-ink-muted">
              Standardized eyebrow (`text-[12px] uppercase text-ink-faint`), clamp title (`text-ink`), and lead copy (`text-[16px] text-ink-muted`).
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8 space-y-3">
              <span className="text-[11px] font-mono uppercase tracking-wider text-ink-ghost">
                Full Configuration (Eyebrow + Title + Lead)
              </span>
              <SectionHeader
                eyebrow="ARCHITECTURE &amp; INTERNALS"
                title="Single binary. Zero garbage collection. Direct HTTP pipelining."
                lead="Mahoquot runs as a lightweight daemon on localhost:8080. It presents a standard OpenAI-compatible API to local clients while managing downstream tokens and OAuth flows."
              />
            </div>

            <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8 space-y-3">
              <span className="text-[11px] font-mono uppercase tracking-wider text-ink-ghost">
                Eyebrow + Title Only (Lead Omitted)
              </span>
              <SectionHeader
                eyebrow="MEASUREMENTS"
                title="Sub-millisecond routing overhead across all proxy models."
              />
            </div>
          </div>
        </section>

        {/* Primitive 3: Card */}
        <section className="space-y-8" aria-labelledby="card-heading">
          <div className="border-b border-line pb-4">
            <h2 id="card-heading" className="text-xl font-medium text-ink">
              3. Card Primitives (Card, Header, Title, Description, Content, Footer)
            </h2>
            <p className="text-sm text-ink-muted">
              Surface containment cards (`rounded-2xl border border-line bg-surface`) with semantic slots and line dividers.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Stream Buffer Pool</CardTitle>
                <CardDescription>Zero-copy ring buffer with bounded memory</CardDescription>
              </CardHeader>
              <CardContent className="py-5 text-sm text-ink-soft">
                <p>
                  Allocates 64KB fixed chunks reused across streaming chunks to achieve 6.5x lower overhead than CLIProxyAPI.
                </p>
              </CardContent>
              <CardFooter className="flex items-center justify-between">
                <span className="font-mono text-xs text-accent">quotio-core</span>
                <Button variant="secondary" size="sm">Inspect</Button>
              </CardFooter>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Failover Engine</CardTitle>
                <CardDescription>Pre-first-byte speculative retry strategy</CardDescription>
              </CardHeader>
              <CardContent className="py-5 text-sm text-ink-soft">
                <p>
                  Detects rate limits (429) or upstream timeouts before first response byte and seamlessly retries on secondary subscription tokens.
                </p>
              </CardContent>
              <CardFooter className="flex items-center justify-between">
                <span className="font-mono text-xs text-ok">Active Status</span>
                <Button variant="outline" size="sm">Configure</Button>
              </CardFooter>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>OAuth Daemon</CardTitle>
                <CardDescription>Background refresh for multi-provider tokens</CardDescription>
              </CardHeader>
              <CardContent className="py-5 text-sm text-ink-soft">
                <p>
                  Persists and refreshes Claude Code, Codex, and Gemini OAuth credentials in the OS keyring with automatic jittered renewal.
                </p>
              </CardContent>
              <CardFooter className="flex items-center justify-between">
                <span className="font-mono text-xs text-ink-faint">Security Tier 1</span>
                <Button variant="primary" size="sm">Manage Keys</Button>
              </CardFooter>
            </Card>
          </div>
        </section>

        {/* Contrast Verification Badge */}
        <section className="rounded-2xl border border-line-strong bg-surface-raised p-6 space-y-4">
          <h2 className="text-sm font-mono uppercase tracking-wider text-accent">
            Design Token Contrast Auditing Summary (against #020202)
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono">
            <div className="p-3 rounded-lg bg-surface border border-line">
              <span className="text-ink-ghost block">--color-ink</span>
              <span className="text-ink text-sm font-bold">#f2f2f2</span>
              <span className="text-ok block mt-1">18.5:1 (AAA)</span>
            </div>
            <div className="p-3 rounded-lg bg-surface border border-line">
              <span className="text-ink-ghost block">--color-ink-soft</span>
              <span className="text-ink-soft text-sm font-bold">#d9d9d9</span>
              <span className="text-ok block mt-1">14.7:1 (AAA)</span>
            </div>
            <div className="p-3 rounded-lg bg-surface border border-line">
              <span className="text-ink-ghost block">--color-ink-muted</span>
              <span className="text-ink-muted text-sm font-bold">#8f8f8f</span>
              <span className="text-ok block mt-1">6.4:1 (AA)</span>
            </div>
            <div className="p-3 rounded-lg bg-surface border border-line">
              <span className="text-ink-ghost block">--color-accent</span>
              <span className="text-accent text-sm font-bold">#f0862a</span>
              <span className="text-ok block mt-1">8.0:1 (AA UI)</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <ShowcaseApp />
  </StrictMode>,
);

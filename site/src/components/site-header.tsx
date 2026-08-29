import { useState } from "react";
import { Menu, X } from "lucide-react";
import { GithubMark } from "@/components/github-mark";
import { ButtonLink } from "@/components/ui/button";
import { NAV_LINKS, PRODUCT, REPO_URL } from "@/content/site";

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-line bg-page/85 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-8 px-6">
        <a href="#top" className="flex shrink-0 items-center gap-2.5">
          <img
            src="brand/mahoquot-icon.png"
            alt=""
            className="h-7 w-7 rounded-lg"
          />
          <span className="text-[16px] font-medium tracking-[-0.01em] text-ink">
            {PRODUCT.name}
          </span>
        </a>

        <nav className="hidden flex-1 items-center gap-7 text-[15px] text-ink-muted lg:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="flex items-center gap-1.5 transition-colors hover:text-ink"
            >
              <span className="h-1 w-1 rounded-full bg-ink-ghost" />
              {link.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-3 lg:flex">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 text-[14px] text-ink-muted transition-colors hover:text-ink"
          >
            <GithubMark className="h-4 w-4" />
            GitHub
          </a>
          <ButtonLink
            variant="secondary"
            size="sm"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            Get started
          </ButtonLink>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface hover:text-ink lg:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-line bg-page px-6 py-3 lg:hidden">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="block py-2.5 text-[15px] text-ink-muted transition-colors hover:text-ink"
            >
              {link.label}
            </a>
          ))}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block border-t border-line pt-3 text-[15px] text-ink"
          >
            GitHub
          </a>
        </div>
      )}
    </header>
  );
}

import { GithubMark } from "@/components/github-mark";
import { CONTRACTS_URL, DOCS_URL, NAV_LINKS, PRODUCT, REPO_URL } from "@/content/site";

export function SiteFooter() {
  return (
    <footer className="bg-page">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-8 px-6 py-12 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2.5">
          <img src="brand/mahoquot-icon.png" alt="" width={24} height={24} className="h-6 w-6 rounded-md" />
          <span className="text-[15px] font-medium text-ink">{PRODUCT.name}</span>
          <span className="text-[13px] text-ink-ghost">{PRODUCT.version}</span>
        </div>

        <nav className="flex flex-wrap items-center gap-x-7 gap-y-3 text-[14px] text-ink-faint">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="transition-colors hover:text-ink">
              {link.label}
            </a>
          ))}
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-ink">
            Docs
          </a>
          <a href={CONTRACTS_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-ink">
            Contracts
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub repository"
            className="transition-colors hover:text-ink"
          >
            <GithubMark className="h-4 w-4" />
          </a>
        </nav>

        <p className="text-[13px] text-ink-ghost">Built in Rust. Runs on your machine.</p>
      </div>
    </footer>
  );
}

import { AtlasLogo, GitHubIcon } from "./shared";

// The public status page lives on OpenStatus (independent infra, reachable
// during an Atlas outage). NEXT_PUBLIC_STATUS_URL overrides it per-deploy.
const STATUS_URL =
  process.env.NEXT_PUBLIC_STATUS_URL || "https://atlas.openstatus.dev";

export function Footer() {
  return (
    <footer className="mx-auto max-w-5xl px-6 pb-12">
      <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      <div className="flex flex-col items-center justify-between gap-4 pt-8 sm:flex-row">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <AtlasLogo className="h-4 w-4 text-accent" />
            <span className="font-mono text-sm text-fg-muted">atlas</span>
          </div>
          <a
            href="https://github.com/AtlasDevHQ/atlas"
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
          >
            <GitHubIcon className="h-3 w-3" />
            Open source
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <a href="/pricing" className="text-xs text-fg-muted transition-colors hover:text-fg">
            Pricing
          </a>
          <a href="/blog" className="text-xs text-fg-muted transition-colors hover:text-fg">
            Blog
          </a>
          <a href="https://docs.useatlas.dev" className="text-xs text-fg-muted transition-colors hover:text-fg">
            Docs
          </a>
          <a href="https://app.useatlas.dev" className="text-xs text-fg-muted transition-colors hover:text-fg">
            Atlas Cloud
          </a>
          <a href={STATUS_URL} className="text-xs text-fg-muted transition-colors hover:text-fg">
            Status
          </a>
          <a href="/terms" className="text-xs text-fg-muted transition-colors hover:text-fg">
            Terms
          </a>
          <a href="/privacy" className="text-xs text-fg-muted transition-colors hover:text-fg">
            Privacy
          </a>
          <a href="/aup" className="text-xs text-fg-muted transition-colors hover:text-fg">
            AUP
          </a>
          <a href="/dpa" className="text-xs text-fg-muted transition-colors hover:text-fg">
            DPA
          </a>
          <a href="https://github.com/AtlasDevHQ/atlas" className="whitespace-nowrap text-xs text-fg-muted transition-colors hover:text-fg">
            Built by humans and AI
          </a>
        </div>
      </div>
    </footer>
  );
}

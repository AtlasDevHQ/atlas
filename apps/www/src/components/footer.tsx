import { AtlasLogo, GitHubIcon } from "./shared";

const STATUS_URL = process.env.NEXT_PUBLIC_STATUS_URL || "/status";

export function Footer() {
  return (
    <footer className="mx-auto max-w-5xl px-6 pb-12">
      <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
      <div className="flex flex-col items-center justify-between gap-4 pt-8 sm:flex-row">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <AtlasLogo className="h-4 w-4 text-brand/60" />
            <span className="font-mono text-sm text-zinc-600">atlas</span>
          </div>
          <a
            href="https://github.com/AtlasDevHQ/atlas"
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800/60 px-2.5 py-1 text-[11px] font-medium text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-400"
          >
            <GitHubIcon className="h-3 w-3" />
            Open source
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <a href="/pricing" className="text-xs text-zinc-600 transition-colors hover:text-zinc-400">
            Pricing
          </a>
          <a href="/sla" className="text-xs text-zinc-600 transition-colors hover:text-zinc-400">
            SLA
          </a>
          <a href="https://docs.useatlas.dev" className="text-xs text-zinc-600 transition-colors hover:text-zinc-400">
            Docs
          </a>
          <a href="https://app.useatlas.dev" className="text-xs text-zinc-600 transition-colors hover:text-zinc-400">
            Atlas Cloud
          </a>
          <a href={STATUS_URL} className="text-xs text-zinc-600 transition-colors hover:text-zinc-400">
            Status
          </a>
          <a href="/terms" className="text-xs text-zinc-600 transition-colors hover:text-zinc-400">
            Terms
          </a>
          <a href="/privacy" className="text-xs text-zinc-600 transition-colors hover:text-zinc-400">
            Privacy
          </a>
          <a href="/dpa" className="text-xs text-zinc-600 transition-colors hover:text-zinc-400">
            DPA
          </a>
          <a href="https://github.com/AtlasDevHQ/atlas" className="text-xs text-zinc-600 transition-colors hover:text-zinc-400">
            Built by @msywulak
          </a>
        </div>
      </div>
    </footer>
  );
}

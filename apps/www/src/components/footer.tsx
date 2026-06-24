import { AtlasLogo, GitHubIcon } from "./shared";

// The public status page lives on OpenStatus (independent infra, reachable
// during an Atlas outage). NEXT_PUBLIC_STATUS_URL overrides it per-deploy.
const STATUS_URL =
  process.env.NEXT_PUBLIC_STATUS_URL || "https://atlas.openstatus.dev";

// Primary footer links: product + resources. Legal links live in the dimmer
// baseline row below so the two readings stay distinct and neither crowds out
// the other as the legal set grows.
const PRIMARY_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/blog", label: "Blog" },
  { href: "https://docs.useatlas.dev", label: "Docs" },
  { href: "https://app.useatlas.dev", label: "Atlas Cloud" },
  { href: STATUS_URL, label: "Status" },
];

const LEGAL_LINKS = [
  { href: "/security", label: "Security" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/aup", label: "AUP" },
  { href: "/dpa", label: "DPA" },
];

export function Footer() {
  return (
    <footer className="mx-auto max-w-5xl px-6 pb-12">
      <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />

      {/* Primary row: brand cluster + product/resource nav */}
      <div className="flex flex-col items-center justify-between gap-6 pt-8 sm:flex-row">
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
        <nav
          aria-label="Footer"
          className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
        >
          {PRIMARY_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="text-sm text-fg-muted transition-colors hover:text-fg"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>

      {/* Baseline row: credit + legal — dimmer and smaller so it reads as a
          sub-tier, not a second primary nav. */}
      <div className="mt-6 flex flex-col-reverse items-center justify-between gap-3 border-t border-border-soft pt-6 sm:flex-row">
        <p className="text-xs text-fg-faint">Built by humans and AI</p>
        <nav
          aria-label="Legal"
          className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2"
        >
          {LEGAL_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="text-xs text-fg-faint transition-colors hover:text-fg-muted"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}

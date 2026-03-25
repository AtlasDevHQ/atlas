import { AtlasLogo } from "./shared";

const NAV_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/blog", label: "Blog" },
  { href: "https://docs.useatlas.dev", label: "Docs" },
  { href: "https://github.com/AtlasDevHQ/atlas", label: "GitHub" },
];

export function Nav({ currentPage, logoHref = "/" }: { currentPage?: string; logoHref?: string }) {
  return (
    <nav className="animate-fade-in mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
      <a href={logoHref} className="flex items-center gap-2.5">
        <AtlasLogo className="h-6 w-6 text-brand" />
        <span className="font-mono text-lg font-semibold tracking-tight text-zinc-100">
          atlas
        </span>
        <span className="rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-brand uppercase">
          beta
        </span>
      </a>
      <div className="flex items-center gap-4 sm:gap-6">
        {NAV_LINKS.map((link) => {
          const isActive = currentPage === link.href;
          return (
            <a
              key={link.href}
              href={link.href}
              {...(isActive ? { "aria-current": "page" as const } : {})}
              className={`text-sm transition-colors ${
                isActive
                  ? "text-zinc-300 hover:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {link.label}
            </a>
          );
        })}
        <a
          href="https://app.useatlas.dev"
          className="rounded-md bg-zinc-100 px-3.5 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white"
        >
          Sign up
        </a>
      </div>
    </nav>
  );
}

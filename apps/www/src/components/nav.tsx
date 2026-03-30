"use client";

import { useState } from "react";
import { AtlasLogo } from "./shared";

const NAV_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "https://docs.useatlas.dev", label: "Docs" },
  { href: "https://github.com/AtlasDevHQ/atlas", label: "GitHub" },
];

export function Nav({ currentPage, logoHref = "/" }: { currentPage?: string; logoHref?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <nav className="animate-fade-in relative mx-auto max-w-5xl px-6 py-6">
      <div className="flex items-center justify-between">
        <a href={logoHref} className="flex items-center gap-2.5">
          <AtlasLogo className="h-6 w-6 text-brand" />
          <span className="font-mono text-lg font-semibold tracking-tight text-zinc-100">
            atlas
          </span>
          <span className="rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-brand uppercase">
            beta
          </span>
        </a>

        {/* Desktop links */}
        <div className="hidden items-center gap-6 sm:flex">
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

        {/* Mobile hamburger */}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:text-zinc-100 sm:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          {open ? (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="absolute right-6 left-6 top-full z-50 mt-1 flex flex-col gap-1 rounded-lg border border-zinc-800/60 bg-zinc-950 p-2 shadow-xl sm:hidden">
          {NAV_LINKS.map((link) => {
            const isActive = currentPage === link.href;
            return (
              <a
                key={link.href}
                href={link.href}
                {...(isActive ? { "aria-current": "page" as const } : {})}
                className={`rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "text-zinc-200"
                    : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                }`}
              >
                {link.label}
              </a>
            );
          })}
          <div className="my-1 border-t border-zinc-800/60" />
          <a
            href="https://app.useatlas.dev"
            className="rounded-md bg-zinc-100 px-3 py-2 text-center text-sm font-medium text-zinc-950 transition-colors hover:bg-white"
          >
            Sign up
          </a>
        </div>
      )}
    </nav>
  );
}

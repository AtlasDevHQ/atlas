"use client";

import { useEffect, useState } from "react";

export function StickyNav() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      aria-label="Section navigation"
      className={`fixed top-0 z-40 w-full border-b border-border bg-bg/80 backdrop-blur-md transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0"
      }`}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <a href="#" className="flex items-center gap-2" aria-label="Back to top">
            <svg viewBox="0 0 256 256" fill="none" className="h-5 w-5 text-accent" aria-hidden="true">
              <path d="M128 24 L232 208 L24 208 Z" stroke="currentColor" strokeWidth="14" fill="none" strokeLinejoin="round" />
              <circle cx="128" cy="28" r="16" fill="currentColor" />
            </svg>
            <span className="font-mono text-sm font-semibold text-fg">atlas</span>
          </a>
          <div className="hidden items-center gap-4 sm:flex">
            <a href="#how-it-works" className="text-xs text-fg-muted transition-colors hover:text-fg">How it works</a>
            <a href="#surfaces" className="text-xs text-fg-muted transition-colors hover:text-fg">Surfaces</a>
            <a href="#deploy" className="text-xs text-fg-muted transition-colors hover:text-fg">Deploy</a>
            <a href="/why-atlas" className="text-xs text-fg-muted transition-colors hover:text-fg">Why Atlas</a>
            <a href="/pricing" className="text-xs text-fg-muted transition-colors hover:text-fg">Pricing</a>
          </div>
        </div>
        <a
          href="https://app.useatlas.dev"
          className="rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:bg-accent"
        >
          Sign up
        </a>
      </div>
    </nav>
  );
}

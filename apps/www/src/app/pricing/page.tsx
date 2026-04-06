import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { Divider, GitHubIcon, SectionLabel, TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";
import { PricingContent } from "./pricing-content";

export const metadata: Metadata = {
  title: "Pricing — Atlas",
  description:
    "Atlas pricing: self-host for free, or choose Starter, Pro, or Business. Annual billing saves 2 months. Open-source under AGPL-3.0.",
  openGraph: {
    title: "Pricing — Atlas",
    description:
      "Atlas pricing: self-host for free, or start a 14-day trial on Atlas Cloud. Per-seat pricing, BYOK for unlimited queries.",
    url: "https://www.useatlas.dev/pricing",
    siteName: "Atlas",
    type: "website",
  },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PricingPage() {
  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/pricing" />

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-20 text-center md:pt-24 md:pb-28">
        <div className="animate-fade-in-up delay-100">
          <SectionLabel>Pricing</SectionLabel>
        </div>
        <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
          Simple, per-seat pricing
        </h1>
        <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
          Self-host for free. Or start a 14-day trial on Atlas Cloud —
          no credit card required.
        </p>
        <p className="animate-fade-in-up delay-400 mx-auto mt-2 text-sm text-zinc-500">
          No enterprise sales calls — self-serve all the way up.
        </p>
      </section>

      {/* Interactive pricing section (client component) */}
      <PricingContent />

      <Divider />

      {/* Self-hosted callout */}
      <section className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <div className="text-center">
          <SectionLabel>Open source</SectionLabel>
          <h2 className="mb-4 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
            Want full control? Self-host for free.
          </h2>
          <p className="mx-auto mb-8 max-w-xl text-zinc-400">
            Atlas is open-source under AGPL-3.0. Deploy on your own infrastructure with
            Docker, Railway, or Vercel. All core features, all databases, all plugins —
            no usage limits, no time limits.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="https://docs.useatlas.dev/getting-started"
              className="group inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-white"
            >
              Deploy now
              <svg
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </a>
            <a
              href="https://github.com/AtlasDevHQ/atlas"
              className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
            >
              <GitHubIcon className="h-4 w-4" />
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

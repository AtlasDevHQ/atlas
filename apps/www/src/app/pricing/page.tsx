import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";
import { PricingContent } from "./pricing-content";

export const metadata: Metadata = {
  title: "Pricing — Atlas",
  description:
    "Atlas pricing: self-host for free under AGPL-3.0, or pick Starter, Pro, or Business on Atlas Cloud. Annual billing saves ~17%. BYOK on every paid plan.",
  openGraph: {
    title: "Pricing — Atlas",
    description:
      "Self-host is free, forever. Cloud adds the things you'd build anyway: SSO, audit, uptime, support. 14-day free trial — no card required.",
    url: "https://www.useatlas.dev/pricing",
    siteName: "Atlas",
    type: "website",
  },
};

export default function PricingPage() {
  return (
    <div className="relative min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-zinc-900 focus:px-3 focus:py-2 focus:font-mono focus:text-sm focus:text-zinc-100 focus:ring-2 focus:ring-brand"
      >
        Skip to content
      </a>

      <StickyNav />
      <TopGlow />
      <Nav currentPage="/pricing" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-6 pt-16 pb-12 text-center md:pt-24 md:pb-16">
          <p className="animate-fade-in-up delay-100 mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
            // pricing
          </p>
          <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
            Honest pricing. Per seat, per month.
          </h1>
          <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
            Self-host is free and always will be. Cloud adds the things you&rsquo;d build
            anyway: SSO, audit, uptime, support.
          </p>
        </section>

        <PricingContent />
      </main>

      <Footer />
    </div>
  );
}

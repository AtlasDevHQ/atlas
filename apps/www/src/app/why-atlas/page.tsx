import type { Metadata } from "next";

import { Comparison } from "../../components/landing/comparison";
import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Why Atlas — Atlas",
  description:
    "How Atlas compares to traditional BI and other text-to-SQL tools: a YAML semantic layer, agent-native via MCP, embeddable anywhere, and deploy-anywhere under AGPL-3.0.",
  openGraph: {
    title: "Why Atlas",
    description:
      "Atlas vs. traditional BI vs. other text-to-SQL: semantic layer, agent-native, embeddable, open source, deploy anywhere.",
    url: "https://www.useatlas.dev/why-atlas",
    siteName: "Atlas",
    type: "website",
  },
};

export default function WhyAtlasPage() {
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
      <Nav currentPage="/why-atlas" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        <section className="mx-auto max-w-5xl px-6 pt-16 pb-12 md:px-16 md:pt-24 md:pb-16">
          <h1 className="animate-fade-in-up delay-100 m-0 text-[40px] font-semibold leading-[1.04] tracking-[-0.035em] text-zinc-50 sm:text-[52px] md:text-[60px]">
            <span className="block">One model. Every surface.</span>
            <em className="block font-semibold text-brand">Yours to run.</em>
          </h1>
          <p className="animate-fade-in-up delay-200 mt-5 max-w-xl text-lg leading-[1.6] text-zinc-400">
            How Atlas stacks up against traditional BI and other text-to-SQL tools.
          </p>
        </section>

        <Comparison />
      </main>

      <Footer />
    </div>
  );
}

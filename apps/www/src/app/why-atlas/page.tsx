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
      "Atlas vs. traditional BI vs. other text-to-SQL — semantic layer, agent-native, embeddable, open source, deploy anywhere.",
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
        <section className="mx-auto max-w-4xl px-6 pt-16 pb-12 text-center md:pt-24 md:pb-16">
          <p className="animate-fade-in-up delay-100 mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
            // why atlas
          </p>
          <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
            One model. Every surface. Yours to run.
          </h1>
          <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
            How Atlas stacks up against traditional BI and other text-to-SQL tools.
          </p>
        </section>

        <Comparison />
      </main>

      <Footer />
    </div>
  );
}

import { BigStat } from "../components/landing/big-stat";
import { Deploy } from "../components/landing/deploy";
import { EndCta } from "../components/landing/end-cta";
import { Hero } from "../components/landing/hero";
import { Primitives } from "../components/landing/primitives";
import { TraceSection } from "../components/landing/trace-section";
import { Footer } from "../components/footer";
import { Nav } from "../components/nav";
import { StickyNav } from "../components/sticky-nav";

export default function Home() {
  return (
    <div className="relative min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-zinc-900 focus:px-3 focus:py-2 focus:font-mono focus:text-sm focus:text-zinc-100 focus:ring-2 focus:ring-brand"
      >
        Skip to content
      </a>

      <StickyNav />
      <Nav logoHref="/" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        <Hero />
        <BigStat />
        <TraceSection />
        <Primitives />
        <Deploy />
        <EndCta />
      </main>

      <Footer />
    </div>
  );
}

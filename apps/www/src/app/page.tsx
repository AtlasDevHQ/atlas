import { BigStat } from "../components/landing/big-stat";
import { Deploy } from "../components/landing/deploy";
import { DropInSurfaces } from "../components/landing/drop-in-surfaces";
import { EndCta } from "../components/landing/end-cta";
import { Hero } from "../components/landing/hero";
import { HowItWorks } from "../components/landing/how-it-works";
import { Footer } from "../components/footer";
import { Nav } from "../components/nav";
import { StickyNav } from "../components/sticky-nav";

export default function Home() {
  return (
    <div className="relative min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-bg-raised focus:px-3 focus:py-2 focus:font-mono focus:text-sm focus:text-fg focus:ring-2 focus:ring-accent"
      >
        Skip to content
      </a>

      <StickyNav />
      <Nav logoHref="/" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        <Hero />
        <BigStat />
        <HowItWorks />
        <DropInSurfaces />
        <Deploy />
        <EndCta />
      </main>

      <Footer />
    </div>
  );
}

import type { Metadata } from "next";
import { Sora, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { buildThemeInitScript } from "@/ui/hooks/theme-init-script";
import { AuthGuard } from "@/ui/components/auth-guard";
import { QueryProvider } from "@/ui/components/query-provider";
import { ModeBanner } from "@/ui/components/mode-banner";
import { StagingBanner } from "@/ui/components/staging-banner";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// The brand type pair, PRODUCT.md › Design Principle 4: "one font pair (Sora +
// JetBrains Mono)". Mirrors apps/www/src/app/layout.tsx exactly — same loader,
// same variable names — so the product and the landing page render in the same
// type. Before #5306 this app loaded NEITHER, so it rendered in whatever
// `ui-sans-serif, system-ui` resolved to per-OS, and every mono pane fell back
// to the platform default.
const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Atlas",
  description: "Ask your data anything",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The proxy mints a per-request CSP nonce and forwards it on `x-nonce`. The
  // hand-written theme-init <script> below is inline, so under the nonce-based
  // `script-src` (no `'unsafe-inline'`) it only executes if it carries the
  // matching nonce. Next.js stamps the nonce onto its own framework scripts
  // automatically; this one is ours, so we stamp it explicitly. Reading
  // headers() opts the layout into dynamic rendering, which the nonce posture
  // requires anyway (a baked-at-build nonce would never match the request's).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  if (!nonce && process.env.NODE_ENV !== "production") {
    // No x-nonce means the proxy didn't run for this render. If the response
    // CSP is nonce-based (no 'unsafe-inline'), this inline script is then
    // silently CSP-blocked → a dark-mode flash with no other breadcrumb.
    // Surface it loudly in dev so the wiring break is caught before deploy;
    // prod stays resilient (undefined → React omits the nonce attribute, and
    // the static next.config.ts CSP still permits the inline script).
    console.warn(
      "[atlas] RootLayout: no x-nonce header — the CSP proxy may not have run for this request; the inline theme script may be CSP-blocked.",
    );
  }
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sora.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/*
          suppressHydrationWarning: under a nonce-based CSP the browser strips
          the `nonce` content attribute from the DOM once it has authorized the
          inline script, so on the client React reads `nonce=""` while the SSR
          HTML carried the real value. That benign, expected mismatch otherwise
          logs a hydration error on *every* page (it surfaced across the whole
          cold-start funnel, #3925). The attribute is still server-stamped, so
          CSP enforcement is unchanged — only the false-positive warning is
          silenced. The no-flash theme script has no hydrated children, so
          nothing else on this element needs reconciliation.
        */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }}
        />
      </head>
      {/*
        ⚠️ NO COLOR UTILITY ON THIS ELEMENT. The tokenized `@layer base` rule in
        globals.css (`body { @apply bg-background text-foreground }`) owns the
        page ground, and a Tailwind utility here would beat it — which is
        exactly what happened until #5306: `bg-white dark:bg-zinc-950` made the
        light ground pure white instead of warm paper-lite (hue 83) and the dark
        ground pure neutral zinc instead of the faintly forest-tinted
        oklch(0.165 0.012 158) that ADR-0023 §4 and PRODUCT.md Design Principle 5 both
        specify as "NOT pure gray". The skip-link on the next line always did it
        correctly; both conventions lived one line apart in the same element.
        scripts/check-web-brand-tokens.sh now fails if a color utility returns.
      */}
      <body className="flex h-dvh flex-col font-sans antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground">Skip to content</a>
        <StagingBanner />
        <QueryProvider>
          <NuqsAdapter>
            <AuthGuard>
              <ModeBanner />
              {/*
                `[contain:layout]` establishes a containing block so the
                admin sidebar's `position: fixed` resolves relative to this
                wrapper instead of the viewport. Without it, the sidebar
                pins to `top: 0` of the viewport and covers the 32-px
                ModeBanner above. The contain root is below the banner in
                flex order, so the sidebar's bounds line up under it
                (#2177).
              */}
              <div className="flex min-h-0 flex-1 flex-col [contain:layout]">{children}</div>
            </AuthGuard>
          </NuqsAdapter>
        </QueryProvider>
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  );
}

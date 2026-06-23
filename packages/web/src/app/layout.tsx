import type { Metadata } from "next";
import { headers } from "next/headers";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { buildThemeInitScript } from "@/ui/hooks/theme-init-script";
import { AuthGuard } from "@/ui/components/auth-guard";
import { QueryProvider } from "@/ui/components/query-provider";
import { ModeBanner } from "@/ui/components/mode-banner";
import { StagingBanner } from "@/ui/components/staging-banner";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} />
      </head>
      <body className="flex h-dvh flex-col bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
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

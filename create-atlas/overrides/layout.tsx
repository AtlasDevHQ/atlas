import type { Metadata } from "next";
import { Sora, JetBrains_Mono } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { buildThemeInitScript } from "@/ui/hooks/theme-init-script";
import { AuthGuard } from "@/ui/components/auth-guard";
import { QueryProvider } from "@/ui/components/query-provider";
import "./globals.css";

// The brand type pair, same loader and same variable names as
// packages/web/src/app/layout.tsx. prepare-templates.sh copies packages/web's
// globals.css into this template verbatim, and that file declares
// `--font-sans: var(--font-sora), ui-sans-serif, …`. An undefined custom
// property in var() with no fallback is invalid at computed-value time, so
// WITHOUT these loaders the whole font-family declaration is discarded — the
// scaffolded app loses `ui-sans-serif, system-ui` too and falls through to the
// browser default. Loading them here is what makes that copied CSS mean
// anything (#5306 review).
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sora.variable} ${jetbrainsMono.variable}`}
    >
      {/* oxlint-disable-next-line @next/next/no-head-element -- App Router root layout: <head> is the correct API here, not next/head (which is Pages Router). */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} />
      </head>
      {/*
        ⚠️ NO COLOR UTILITY ON THIS ELEMENT — same rule as
        packages/web/src/app/layout.tsx. The tokenized `@layer base` rule in the
        copied globals.css owns the page ground, and a utility here beats it.
        This file kept `bg-white dark:bg-zinc-950` for the whole of #5306
        because check-web-brand-tokens.sh reads only packages/web's layout, so
        every scaffolded project shipped the defect the product had just fixed.
      */}
      <body className="flex h-dvh flex-col font-sans antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground">Skip to content</a>
        <QueryProvider>
          <NuqsAdapter>
            <AuthGuard>
              <div className="flex min-h-0 flex-1 flex-col">{children}</div>
            </AuthGuard>
          </NuqsAdapter>
        </QueryProvider>
      </body>
    </html>
  );
}

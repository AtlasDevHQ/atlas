import type { Metadata } from "next";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { buildThemeInitScript } from "@/ui/hooks/theme-init-script";
import { AuthGuard } from "@/ui/components/auth-guard";
import { QueryProvider } from "@/ui/components/query-provider";
import { ModeBanner } from "@/ui/components/mode-banner";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript() }} />
      </head>
      <body className="flex h-dvh flex-col bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground">Skip to content</a>
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

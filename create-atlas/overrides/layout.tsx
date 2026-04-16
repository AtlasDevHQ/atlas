import type { Metadata } from "next";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { buildThemeInitScript } from "@/ui/hooks/theme-init-script";
import { AuthGuard } from "@/ui/components/auth-guard";
import { QueryProvider } from "@/ui/components/query-provider";
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
              <div className="flex min-h-0 flex-1 flex-col">{children}</div>
            </AuthGuard>
          </NuqsAdapter>
        </QueryProvider>
      </body>
    </html>
  );
}

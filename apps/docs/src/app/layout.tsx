import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: {
    template: "%s | Atlas Docs",
    default: "Atlas Docs",
  },
  description:
    "Documentation for Atlas — deploy-anywhere text-to-SQL data analyst agent.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}

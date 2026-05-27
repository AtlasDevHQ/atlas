import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import WebMCP from "@/components/webmcp";
import { Provider } from "./provider";

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.useatlas.dev"),
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
        <Provider>{children}</Provider>
        <WebMCP />
      </body>
    </html>
  );
}

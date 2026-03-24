import type { Metadata } from "next";
import { Sora, JetBrains_Mono } from "next/font/google";
import "./globals.css";

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
  title: "Atlas — Open-source data agent",
  description:
    "Open-source text-to-SQL agent. Connect any database, auto-generate a semantic layer, and let your team query data in plain English. Self-host for free or use Atlas Cloud with enterprise features.",
  openGraph: {
    title: "Atlas — Open-source data agent",
    description:
      "Open-source text-to-SQL agent. Self-host for free or use Atlas Cloud. 7 databases, 20+ plugins, admin console, Slack, MCP, and more.",
    url: "https://useatlas.dev",
    siteName: "Atlas",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Atlas — Open-source data agent",
    description:
      "Open-source text-to-SQL agent with auto-generated semantic layer and production-grade security. Self-host or use Atlas Cloud.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sora.variable} ${jetbrainsMono.variable}`}>
      <body className="noise-overlay bg-zinc-950 font-sans text-zinc-300 antialiased">
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Sora, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import WebMCP from "@/components/webmcp";

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
  title: "Atlas — Text-to-SQL, that actually ships.",
  description:
    "Atlas reads your semantic layer, writes deterministic SQL, and runs it through 7 validators before it ever touches your warehouse. Open-source, self-hosted or cloud.",
  openGraph: {
    title: "Atlas — Text-to-SQL, that actually ships.",
    description:
      "94% of AI-generated SQL fails at least one Atlas validator. Atlas reads your schema, writes deterministic SQL, and runs it through 7 gates before execution. Self-host or cloud.",
    url: "https://www.useatlas.dev",
    siteName: "Atlas",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Atlas — Text-to-SQL, that actually ships.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Atlas — Text-to-SQL, that actually ships.",
    description:
      "Atlas reads your schema, writes deterministic SQL, and runs it through 7 validators. Open-source or cloud.",
    images: ["/og.png"],
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
        <WebMCP />
      </body>
    </html>
  );
}

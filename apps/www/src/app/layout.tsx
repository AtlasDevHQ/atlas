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
  metadataBase: new URL("https://www.useatlas.dev"),
  title: {
    default: "Atlas — the company facts your AI agents can trust",
    template: "%s — Atlas",
  },
  description:
    "Atlas is the company facts your AI agents can trust: every one carries its source, its date, and the name of the person who approved it. Open source, runs in your VPC.",
  openGraph: {
    title: "Atlas — the company facts your AI agents can trust",
    description:
      "Atlas is the company facts your AI agents can trust: every one carries its source, its date, and the name of the person who approved it. Open source, runs in your VPC.",
    url: "https://www.useatlas.dev",
    siteName: "Atlas",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Atlas — the company facts your AI agents can trust",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Atlas — the company facts your AI agents can trust",
    description:
      "Atlas is the company facts your AI agents can trust: every one carries its source, its date, and the name of the person who approved it. Open source, runs in your VPC.",
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
      <body className="noise-overlay bg-bg font-sans text-fg antialiased">
        {children}
        <WebMCP />
      </body>
    </html>
  );
}

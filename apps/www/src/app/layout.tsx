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
  title: "Atlas — Ask your data anything, trust the answer.",
  description:
    "Atlas is an AI data analyst that turns plain-English questions into safe, validated SQL, grounded in a semantic layer you control. Run it in the cloud or self-host it — open source.",
  openGraph: {
    title: "Atlas — Ask your data anything, trust the answer.",
    description:
      "94% of AI-generated SQL fails at least one Atlas validator. Atlas reads your semantic layer, writes the SQL, and runs it read-only behind 7 validators. Cloud or self-hosted.",
    url: "https://www.useatlas.dev",
    siteName: "Atlas",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Atlas — Ask your data anything, trust the answer.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Atlas — Ask your data anything, trust the answer.",
    description:
      "Plain-English questions, safe validated SQL, grounded in a semantic layer you control. Cloud or self-hosted, open source.",
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

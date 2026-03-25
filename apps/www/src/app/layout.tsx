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
  title: "Atlas — Quit copying SQL from ChatGPT",
  description:
    "Stop pasting AI-generated SQL into your database client and hoping it works. Atlas connects to your actual schema, writes validated queries, and runs them. Open-source, self-hosted or cloud.",
  openGraph: {
    title: "Atlas — Quit copying SQL from ChatGPT",
    description:
      "AI writes better SQL than you — let it. Atlas connects to your schema, validates queries, and runs them. Open-source with 7 databases, 20+ plugins, and enterprise cloud.",
    url: "https://useatlas.dev",
    siteName: "Atlas",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Atlas — Quit copying SQL from ChatGPT",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Atlas — Quit copying SQL from ChatGPT",
    description:
      "Stop pasting AI-generated SQL and hoping it works. Atlas connects to your schema, validates every query, and runs it. Open-source or cloud.",
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
      </body>
    </html>
  );
}

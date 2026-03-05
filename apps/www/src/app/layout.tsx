import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Atlas — Ask your data anything",
  description:
    "Deploy-anywhere text-to-SQL agent. Connect your database, auto-generate a semantic layer, and query your data in natural language.",
  openGraph: {
    title: "Atlas — Ask your data anything",
    description:
      "Deploy-anywhere text-to-SQL agent. Connect your database, auto-generate a semantic layer, and query your data in natural language.",
    url: "https://useatlas.dev",
    siteName: "Atlas",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Atlas — Ask your data anything",
    description:
      "Deploy-anywhere text-to-SQL agent with auto-generated semantic layer and production-grade security.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="noise-overlay bg-zinc-950 font-sans text-zinc-300 antialiased">
        {children}
      </body>
    </html>
  );
}

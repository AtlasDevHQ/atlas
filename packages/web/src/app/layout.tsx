import type { Metadata } from "next";
import { NuqsAdapter } from "nuqs/adapters/next/app";
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
        {/* Inline script to set dark class before first paint — prevents flash.
            Reads atlas-theme from localStorage: "dark" → always dark, "light" → always light,
            "system" or missing → follows prefers-color-scheme. */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("atlas-theme");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}` }} />
      </head>
      <body className="bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <NuqsAdapter>{children}</NuqsAdapter>
      </body>
    </html>
  );
}

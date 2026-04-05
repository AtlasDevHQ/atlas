import type { Metadata } from "next";
import { QueryProvider } from "@atlas/web/ui/components/query-provider";
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
    <html lang="en">
      <body className="bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}

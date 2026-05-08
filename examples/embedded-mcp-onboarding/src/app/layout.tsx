import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Embedded Atlas MCP onboarding",
  description: "Demonstrates @useatlas/react useMcpConnect end-to-end.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
          background: "#0a0a0a",
          color: "#fafafa",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}

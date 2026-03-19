import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Try Atlas — Interactive Demo",
  description:
    "Try Atlas against a sample cybersecurity dataset — no signup required.",
};

export default function DemoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main id="main" className="flex h-dvh flex-col bg-background">
      {children}
    </main>
  );
}

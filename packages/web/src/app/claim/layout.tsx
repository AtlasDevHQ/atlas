import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Claim your workspace — Atlas",
  description: "Finish setting up the Atlas trial you started from the CLI or MCP.",
};

export default function ClaimLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main
      id="main"
      className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-4"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10
          bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklch,var(--primary)_10%,transparent)_0%,transparent_70%)]"
      />
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

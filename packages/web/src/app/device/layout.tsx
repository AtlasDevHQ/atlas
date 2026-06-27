import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Authorize a device — Atlas",
  description: "Approve or deny a device (e.g. the Atlas CLI) requesting access to your workspace.",
  // The device-verification screen carries a one-shot user code and must never
  // be indexed or cached. (#4043 / ADR-0026.)
  robots: { index: false, follow: false },
};

export default function DeviceLayout({
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

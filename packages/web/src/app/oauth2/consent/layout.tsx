import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Authorize — Atlas",
  description: "Review the permissions an application is requesting and approve or deny.",
  // OAuth consent must never be cached or scraped — pages bind a one-shot
  // signed query and render scope-specific copy that's meaningless out of
  // context. `noindex` keeps the URL out of search indexes if a logged-in
  // browser ever exfiltrates it.
  robots: { index: false, follow: false },
};

export default function ConsentLayout({
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

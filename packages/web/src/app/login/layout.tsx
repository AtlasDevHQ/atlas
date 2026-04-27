import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in — Atlas",
  description: "Sign in to your Atlas account",
};

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main
      id="main"
      className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-4"
    >
      {/* Soft brand backdrop — radial wash sits well below the card so the
       * focal point is the form, not the aura. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10
          bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklch,var(--primary)_10%,transparent)_0%,transparent_70%)]"
      />
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

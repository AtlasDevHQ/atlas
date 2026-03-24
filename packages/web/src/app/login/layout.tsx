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
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      {children}
    </main>
  );
}

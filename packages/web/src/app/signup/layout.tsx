import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign up — Atlas",
  description: "Create your Atlas account and start querying data",
};

export default function SignupLayout({
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

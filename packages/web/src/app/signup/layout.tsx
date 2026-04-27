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
  // Each /signup/* route renders its own <SignupShell>, which provides the
  // top bar (logo + step indicator) and the centered content area. This
  // layout intentionally stays a passthrough so the shell isn't wrapped in
  // a competing <main>.
  return <>{children}</>;
}

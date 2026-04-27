import type { Metadata } from "next";
import { SignupContextProvider } from "@/ui/components/signup/signup-context-provider";

export const metadata: Metadata = {
  title: "Sign up — Atlas",
  description: "Create your Atlas account and start querying data",
};

export default function SignupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The provider does the residency probe once for the whole signup session
  // so the step indicator never reflows between routes. Each /signup/* page
  // then renders its own <SignupShell> for the visible chrome.
  return <SignupContextProvider>{children}</SignupContextProvider>;
}

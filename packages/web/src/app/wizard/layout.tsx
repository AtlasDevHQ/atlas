import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "Set up Atlas — Semantic layer",
  description: "Profile a database and build a semantic layer Atlas can query.",
};

export default function WizardLayout({ children }: { children: React.ReactNode }) {
  // The wizard page renders its own <OnboardingShell /> — this layout exists
  // only to host page metadata and the Suspense boundary that nuqs needs for
  // useQueryStates to read URL params on first render.
  return <Suspense>{children}</Suspense>;
}

import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "Set up Atlas — Semantic layer",
  description: "Profile a database and build a semantic layer Atlas can query.",
};

export default function WizardLayout({ children }: { children: React.ReactNode }) {
  // Suspense boundary is required by nuqs `useQueryStates` to read URL params
  // during the first render of the page below.
  return <Suspense>{children}</Suspense>;
}

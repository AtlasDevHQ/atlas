"use client";

import { Suspense } from "react";

export default function WizardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <Suspense>{children}</Suspense>
    </div>
  );
}

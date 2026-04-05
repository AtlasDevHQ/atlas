"use client";

import { Suspense } from "react";
import { AtlasProvider } from "@/ui/context";
import { authClient } from "@/lib/auth/client";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";

export default function WizardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AtlasProvider config={{ apiUrl: getApiUrl(), isCrossOrigin: isCrossOrigin(), authClient }}>
      <div className="min-h-dvh bg-background">
        <Suspense>{children}</Suspense>
      </div>
    </AtlasProvider>
  );
}

"use client";

import { Suspense } from "react";
import { AtlasUIProvider } from "@/ui/context";
import { authClient } from "@/lib/auth/client";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";

export default function WizardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AtlasUIProvider config={{ apiUrl: API_URL, isCrossOrigin: IS_CROSS_ORIGIN, authClient }}>
      <div className="min-h-dvh bg-background">
        <Suspense>{children}</Suspense>
      </div>
    </AtlasUIProvider>
  );
}

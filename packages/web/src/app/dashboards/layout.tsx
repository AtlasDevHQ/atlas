"use client";

import { Suspense } from "react";
import { AtlasProvider } from "@/ui/context";
import { authClient } from "@/lib/auth/client";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";

export default function DashboardsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AtlasProvider config={{ apiUrl: getApiUrl(), isCrossOrigin: isCrossOrigin(), authClient }}>
      <Suspense>{children}</Suspense>
    </AtlasProvider>
  );
}

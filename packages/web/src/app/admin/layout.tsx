"use client";

import { Suspense } from "react";
import { AtlasUIProvider } from "@/ui/context";
import { authClient } from "@/lib/auth/client";
import { API_URL, IS_CROSS_ORIGIN } from "@/lib/api-url";
import { AdminLayout } from "@/ui/components/admin/admin-layout";
import { BrandingHead } from "@/ui/components/branding-head";

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <AtlasUIProvider config={{ apiUrl: API_URL, isCrossOrigin: IS_CROSS_ORIGIN, authClient }}>
      <BrandingHead />
      <AdminLayout>
        <Suspense>{children}</Suspense>
      </AdminLayout>
    </AtlasUIProvider>
  );
}

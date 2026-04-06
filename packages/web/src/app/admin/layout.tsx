"use client";

import { AtlasProvider } from "@/ui/context";
import { authClient } from "@/lib/auth/client";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { AdminLayout } from "@/ui/components/admin/admin-layout";
import { BrandingHead } from "@/ui/components/branding-head";

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <AtlasProvider config={{ apiUrl: getApiUrl(), isCrossOrigin: isCrossOrigin(), authClient }}>
      <BrandingHead />
      <AdminLayout>
        {children}
      </AdminLayout>
    </AtlasProvider>
  );
}

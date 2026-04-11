"use client";

import { AdminLayout } from "@/ui/components/admin/admin-layout";
import { BrandingHead } from "@/ui/components/branding-head";

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <BrandingHead />
      <AdminLayout>
        {children}
      </AdminLayout>
    </>
  );
}

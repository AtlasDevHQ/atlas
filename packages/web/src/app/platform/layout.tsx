"use client";

import { AdminLayout } from "@/ui/components/admin/admin-layout";
import { BrandingHead } from "@/ui/components/branding-head";

/**
 * Platform-admin layout.
 *
 * Mirrors the `/admin` layout (same shell, same sidebar) so the platform
 * surface inherits the existing admin chrome — only the URL prefix differs.
 * Lifting `/platform/*` out from under `/admin/platform/*` is purely a URL
 * disambiguation: workspace-scoped admin pages live at `/admin/*`,
 * cross-tenant platform-admin pages live at `/platform/*`. Page-level
 * `usePlatformAdminGuard` calls inside each page stay untouched and still
 * redirect non-platform-admins to `/admin`.
 */
export default function PlatformRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <BrandingHead />
      <AdminLayout>
        {children}
      </AdminLayout>
    </>
  );
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUserRole } from "@/ui/hooks/use-platform-admin-guard";
import { UsersPage } from "./_users-page";

/**
 * Workspace-scoped users page. Members of the active org only — invite,
 * change role within the org, remove from workspace.
 *
 * Platform admins land here too (they're admins everywhere) but should
 * be using `/platform/users` for cross-tenant operations. We redirect
 * them on mount so the URL matches the data they're about to operate
 * on. Workspace admins (`role = 'admin'`) stay here.
 */
export default function AdminUsersPage() {
  const router = useRouter();
  const userRole = useUserRole();

  useEffect(() => {
    if (userRole === "platform_admin") {
      router.replace("/platform/users");
    }
  }, [router, userRole]);

  if (userRole === "platform_admin") {
    return null;
  }

  return <UsersPage scope="workspace" />;
}

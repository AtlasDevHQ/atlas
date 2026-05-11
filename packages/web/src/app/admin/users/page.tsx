"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAtlasConfig } from "@/ui/context";
import { UsersPage } from "./_users-page";

/**
 * Workspace-scoped users page. Members of the active org only — invite,
 * change role within the org, remove from workspace.
 *
 * Platform admins land here too (they're admins everywhere) but should
 * be using `/platform/users` for cross-tenant operations. We redirect
 * them on mount so the URL matches the data they're about to operate
 * on. Workspace admins (`role = 'admin'`) stay here.
 *
 * The redirect mirrors `usePlatformAdminGuard`'s pending-aware shape:
 * we MUST gate on `session.isPending` before deciding what to render,
 * otherwise a platform admin briefly sees the workspace UI (and fires
 * stray fetches for the user list / stats / invitations) during the
 * one-render window where `useSession()` returns
 * `{ data: undefined, isPending: true }` before resolving.
 */
export default function AdminUsersPage() {
  const router = useRouter();
  const { authClient } = useAtlasConfig();
  const session = authClient.useSession();
  const isPending = session.isPending;
  const userRole = session.data?.user?.role;

  useEffect(() => {
    if (isPending) return;
    if (userRole === "platform_admin") {
      router.replace("/platform/users");
    }
  }, [isPending, userRole, router]);

  if (isPending || userRole === "platform_admin") {
    return null;
  }

  return <UsersPage scope="workspace" />;
}

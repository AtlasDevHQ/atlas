"use client";

import { usePlatformAdminGuard } from "@/ui/hooks/use-platform-admin-guard";
import { UsersPage } from "../../admin/users/_users-page";

/**
 * Platform-scoped users page. Cross-tenant — lists every user in the
 * deployment, surfaces the global Ban / Unban actions, and routes the
 * destructive verbs through `removeEndpointForRole(true)` to the
 * platform-admin endpoints.
 *
 * The page implementation lives at `/admin/users/_users-page.tsx`
 * because (a) workspace admins also need it at `/admin/users` and (b)
 * the underscore-prefixed filename keeps Next.js from routing it
 * directly.
 */
export default function PlatformUsersPage() {
  const { blocked } = usePlatformAdminGuard();
  if (blocked) return null;
  return <UsersPage scope="platform" />;
}

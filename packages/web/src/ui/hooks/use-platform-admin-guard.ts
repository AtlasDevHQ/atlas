"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAtlasConfig } from "@/ui/context";

/**
 * Returns the user's role from the Better Auth session.
 * Used by the sidebar for item-level visibility and by page guards.
 */
export function useUserRole(): string | undefined {
  const { authClient } = useAtlasConfig();
  const session = authClient.useSession();
  return (session.data?.user as Record<string, unknown> | undefined)?.role as
    | string
    | undefined;
}

/**
 * Redirects non-platform-admin users to /admin.
 *
 * Call at the top of any page component that should be restricted to
 * platform admins only. Returns `true` while the role is still loading
 * or a redirect is in progress — the caller should render nothing (or a
 * loading spinner) until it returns `false`.
 */
export function usePlatformAdminGuard(): { blocked: boolean } {
  const { authClient } = useAtlasConfig();
  const session = authClient.useSession();
  const router = useRouter();

  const role = (session.data?.user as Record<string, unknown> | undefined)
    ?.role as string | undefined;
  const isPending = session.isPending;

  useEffect(() => {
    if (isPending) return;
    if (role !== "platform_admin") {
      router.replace("/admin");
    }
  }, [isPending, role, router]);

  // Block rendering while pending or when the user is not platform_admin
  const blocked = isPending === true || role !== "platform_admin";
  return { blocked };
}

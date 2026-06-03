"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_ROLES, type AdminRole } from "@useatlas/types";
import { useAtlasConfig } from "@/ui/context";

const ADMIN_ROLES_SET: ReadonlySet<string> = new Set<AdminRole>(ADMIN_ROLES);

/**
 * Returns the user's effective role for client-side admin gating.
 *
 * Better Auth keeps two role surfaces separate by design: `user.role`
 * (admin plugin, system-wide — `platform_admin` / `admin` / `user`) and
 * `member.role` (organization plugin, per-org — `owner` / `admin` /
 * `member`). The server's `customSession` callback merges them and
 * exposes the max as `user.effectiveRole` — read that here so an org
 * admin whose `user.role` defaulted to "user" (the standard signup →
 * accept-invite flow) still sees admin chrome.
 *
 * Falls back to `user.role` for older sessions issued before
 * customSession landed; both fields disappear gracefully when missing.
 * This is the single source of truth for role extraction — all call
 * sites should use this hook.
 */
export function useUserRole(): string | undefined {
  const { authClient } = useAtlasConfig();
  const session = authClient.useSession();
  const user = session.data?.user;
  // `effectiveRole`/`role` are both `string | null`; collapse a null role
  // to `undefined` so the "no role" case is a single value for callers.
  return user?.effectiveRole ?? user?.role ?? undefined;
}

/**
 * Boolean form of {@link useUserRole} — `true` when the caller has any
 * admin-grade role (`admin` / `owner` / `platform_admin`). Use this
 * everywhere admin chrome is gated; the underlying source-of-truth set
 * is `ADMIN_ROLES` from `@useatlas/types`, so adding a new admin tier
 * lights up every consumer at once.
 *
 * Direct `user.role === "admin" || ...` chains miss the org-merged role
 * and silently underreport for org admins whose `user.role` is the
 * signup-default "user" — see the customSession plugin in
 * `packages/api/src/lib/auth/server.ts`.
 */
export function useIsAdmin(): boolean {
  const role = useUserRole();
  return role !== undefined && ADMIN_ROLES_SET.has(role);
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
  const role = useUserRole();
  const { authClient } = useAtlasConfig();
  const isPending = authClient.useSession().isPending;
  const router = useRouter();

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

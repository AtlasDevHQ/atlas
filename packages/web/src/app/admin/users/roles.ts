// Shared role constants + demotion helper used by page.tsx and tested in
// isolation (see __tests__/roles.test.ts). Extracted so the fail-closed
// behavior on unknown roles is exercised without mounting the page.

export const ROLES = ["member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

// Rank for detecting demotions — higher is more privileged.
const ROLE_RANK: Record<Role, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

/**
 * Decide whether changing `from` → `to` should route through the
 * "confirm destructive change" AlertDialog. Promotions skip the confirm;
 * demotions gate behind it.
 *
 * Fail-closed on unknown `from` roles (anything outside {member, admin,
 * owner} — legacy "guest", a future "billing-admin", DB drift, etc.).
 * Silently treating unknown → member as rank 0 would let a stray role
 * skip the confirm for *every* target role, defeating the safeguard on
 * exactly the users hardest to reason about. Unknown → always confirm.
 */
export function isDemotion(from: string, to: Role): boolean {
  const fromRank = ROLE_RANK[from as Role];
  if (fromRank === undefined) return true;
  return ROLE_RANK[to] < fromRank;
}

/**
 * Pick the endpoint for the destructive "remove user from list" action
 * based on the caller's role. Extracted from `page.tsx` so the branch is
 * unit-testable — the contract here is load-bearing for F-14 (security
 * audit 1.2.3): workspace admins must NEVER hit `POST /ban` (which is
 * platform-admin-only and returns 403), and platform admins must route
 * through `POST /ban` for the global ban, not `/membership`.
 */
export interface RemoveEndpoint {
  readonly path: (userId: string) => string;
  readonly method: "POST" | "DELETE";
  readonly label: string;
}

export function removeEndpointForRole(isPlatformAdmin: boolean): RemoveEndpoint {
  if (isPlatformAdmin) {
    return {
      path: (userId) => `/api/v1/admin/users/${userId}/ban`,
      method: "POST",
      label: "Ban user",
    };
  }
  return {
    path: (userId) => `/api/v1/admin/users/${userId}/membership`,
    method: "DELETE",
    label: "Remove from workspace",
  };
}

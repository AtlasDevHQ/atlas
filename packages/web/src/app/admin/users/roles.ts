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

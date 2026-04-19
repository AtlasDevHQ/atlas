// Display-only helpers for org-member role badges used by the detail sheet.
// Extracted so the fallback behavior on unknown roles is exercised by a unit
// test without mounting the page (see __tests__/roles.test.ts).
//
// The server is authoritative on the role enum, but the UI must still render
// safely if it ever ships a value Atlas doesn't recognize (legacy "guest", a
// future "billing-admin", DB drift). This helper is **fail-safe** (render a
// readable default), not fail-closed in the security sense — compare with
// `app/admin/users/roles.ts`'s `isDemotion`, which is fail-*closed* (unknown
// → always route through the confirm dialog). Same pattern shape, opposite
// safety posture: the demote gate protects against accidental privilege
// strip; this gate protects against an unreadable sheet.
//
// Unknown roles trigger a one-time `console.warn` per role so server drift
// is detectable in browser devtools without spamming the console on every
// render.

import { Crown, Shield, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const KNOWN_ORG_ROLES = ["owner", "admin", "member"] as const;
type KnownOrgRole = (typeof KNOWN_ORG_ROLES)[number];

const ROLE_ICONS: Record<KnownOrgRole, LucideIcon> = {
  owner: Crown,
  admin: ShieldCheck,
  member: Shield,
};

// Mirrors the color-coded role badges in `app/admin/users/columns.tsx` so the
// two operator surfaces stay visually consistent. If those classes drift,
// update this map too — there's no single source today.
const ROLE_BADGE_CLASS: Record<KnownOrgRole, string> = {
  owner: "border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-400",
  admin: "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400",
  member: "border-primary/50 text-primary",
};

interface RoleBadge {
  readonly Icon: LucideIcon;
  readonly className: string;
}

// Module-scoped so repeated renders of the same unknown role only warn once.
// Cleared on full page reload (fine — drift is a "once you see it, you
// investigate" signal, not a rate-limited alert).
const warnedUnknownRoles = new Set<string>();

/**
 * Resolve icon + badge classes for a workspace-member role. Unknown roles
 * fall back to the neutral member variant (fail-safe rendering) and emit a
 * one-time `console.warn` so server drift is detectable in devtools.
 */
export function roleBadge(role: string): RoleBadge {
  if (!(KNOWN_ORG_ROLES as readonly string[]).includes(role)) {
    if (!warnedUnknownRoles.has(role)) {
      warnedUnknownRoles.add(role);
      console.warn(
        `[admin/organizations] Unknown workspace role "${role}" — rendering neutral fallback. Investigate server drift or update KNOWN_ORG_ROLES.`,
      );
    }
    return { Icon: ROLE_ICONS.member, className: ROLE_BADGE_CLASS.member };
  }
  const known = role as KnownOrgRole;
  return { Icon: ROLE_ICONS[known], className: ROLE_BADGE_CLASS[known] };
}

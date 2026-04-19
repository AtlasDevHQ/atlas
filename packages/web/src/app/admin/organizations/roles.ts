// Display-only helpers for org-member role badges used by the detail sheet.
// Extracted so the fallback behavior on unknown roles is exercised by a unit
// test without mounting the page (see __tests__/roles.test.ts). The server
// is authoritative on the role enum, but the UI must render safely if the
// server ever ships a value Atlas doesn't recognize (legacy "guest", a
// future "billing-admin", DB drift) — fallback to the neutral member
// variant keeps the sheet readable instead of rendering a bare class name.

import { Crown, Shield, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const KNOWN_ORG_ROLES = ["owner", "admin", "member"] as const;
export type KnownOrgRole = (typeof KNOWN_ORG_ROLES)[number];

const ROLE_ICONS: Record<KnownOrgRole, LucideIcon> = {
  owner: Crown,
  admin: ShieldCheck,
  member: Shield,
};

// Mirrors the color-coded role badges on /admin/users so the two operator
// surfaces stay visually consistent. Keyed on the known enum; anything else
// routes through the neutral fallback in `roleBadge()`.
const ROLE_BADGE_CLASS: Record<KnownOrgRole, string> = {
  owner: "border-purple-300 text-purple-700 dark:border-purple-700 dark:text-purple-400",
  admin: "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400",
  member: "border-primary/50 text-primary",
};

export interface RoleBadge {
  Icon: LucideIcon;
  className: string;
}

/**
 * Resolve icon + badge classes for a workspace-member role. Unknown roles
 * fall back to the neutral member variant so the sheet renders safely
 * regardless of server drift.
 */
export function roleBadge(role: string): RoleBadge {
  const known = (KNOWN_ORG_ROLES as readonly string[]).includes(role)
    ? (role as KnownOrgRole)
    : "member";
  return {
    Icon: ROLE_ICONS[known],
    className: ROLE_BADGE_CLASS[known],
  };
}

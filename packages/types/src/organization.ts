/**
 * Organization types shared across API, frontend, and SDK.
 *
 * These align with Better Auth's organization plugin schema.
 * Atlas uses organizations as the tenant boundary — all data
 * (conversations, audit logs, connections, etc.) is scoped to an org.
 */

import type { AtlasRole } from "./auth";

// Re-export the canonical ORG_ROLES tuple from auth.ts so consumers can keep
// importing `OrgRole` / `ORG_ROLES` from the organization module.
export { ORG_ROLES } from "./auth";
export type { OrgRole } from "./auth";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * A member row's wire shape. The DB column stores any AtlasRole value — including
 * `platform_admin` for cross-org administrators — so this field is typed as
 * AtlasRole rather than the narrower OrgRole (which is the *assignable* subset).
 */
export interface OrgMember {
  id: string;
  organizationId: string;
  userId: string;
  role: AtlasRole;
  createdAt: string;
  user?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
}

export interface OrgInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: AtlasRole;
  status: "pending" | "accepted" | "rejected" | "canceled";
  inviterId: string;
  expiresAt: string;
  createdAt: string;
  organization?: {
    id: string;
    name: string;
    slug: string;
  };
}

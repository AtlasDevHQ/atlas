/**
 * Organization types shared across API, frontend, and SDK.
 *
 * These align with Better Auth's organization plugin schema.
 * Atlas uses organizations as the tenant boundary — all data
 * (conversations, audit logs, connections, etc.) is scoped to an org.
 */

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface OrgMember {
  id: string;
  organizationId: string;
  userId: string;
  role: OrgRole;
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
  role: OrgRole;
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

/** Org roles in descending privilege order. */
export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

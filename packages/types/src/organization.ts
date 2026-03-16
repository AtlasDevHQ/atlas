/**
 * Organization types shared across API, frontend, and SDK.
 *
 * These align with Better Auth's organization plugin schema.
 * Atlas uses organizations as the tenant boundary — all data
 * (conversations, audit logs, connections, etc.) is scoped to an org.
 */

import type { AtlasRole } from "./auth";
import { ATLAS_ROLES } from "./auth";

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

/**
 * Org roles in descending privilege order. Same values as AtlasRole,
 * listed high-to-low for display. Single source of truth is ATLAS_ROLES
 * in auth.ts — this is a reversed view for convenience.
 */
export const ORG_ROLES: readonly AtlasRole[] = [...ATLAS_ROLES].reverse();
export type OrgRole = AtlasRole;

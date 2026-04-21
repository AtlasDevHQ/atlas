/**
 * Auth types shared across API, frontend, and SDK.
 *
 * AuthMode determines how requests are authenticated.
 * AtlasRole determines the user's permission level for action approval.
 * AtlasMode determines the UI/API surface (developer preview vs published).
 * AtlasUser represents a verified identity attached to a request.
 */

export const AUTH_MODES = ["none", "simple-key", "managed", "byot"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * Org-level roles — the assignable subset at workspace boundaries.
 *
 * These are the only roles a workspace admin may grant through routes like
 * `PATCH /api/v1/admin/users/:id/role` and `POST /api/v1/admin/invitations`.
 * Adding a role here means "workspace admins may hand this out." See F-10 in
 * .claude/research/security-audit-1-2-3.md.
 */
export const ORG_ROLES = ["member", "admin", "owner"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * Platform-level roles — cross-org privileges.
 *
 * Granting one of these must go through a platform-admin-gated endpoint, never
 * the per-workspace admin surface. Adding a role here means "only platform
 * admins may hand this out." Keep this tuple and ORG_ROLES disjoint.
 */
export const PLATFORM_ROLES = ["platform_admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * All Atlas role values — union of ORG_ROLES ∪ PLATFORM_ROLES. Derived so
 * that adding a new role forces a conscious bucket choice (org-assignable
 * vs platform-only). The user.role column may legitimately hold any of
 * these values.
 */
export const ATLAS_ROLES = [...ORG_ROLES, ...PLATFORM_ROLES] as const;
export type AtlasRole = (typeof ATLAS_ROLES)[number];

export const ATLAS_MODES = ["developer", "published"] as const;
export type AtlasMode = (typeof ATLAS_MODES)[number];

/** Roles that qualify for admin-level features (developer mode, admin console, etc.). */
export const ADMIN_ROLES = ["admin", "owner", "platform_admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

// ── Client-side auth interfaces ────────────────────────────────────
// Shared between @atlas/web and @useatlas/react so each package has
// a single source of truth for auth client shapes.

/**
 * Duck-typed interface that matches better-auth's client shape.
 * Components like ManagedAuthCard call signIn/signUp/signOut and useSession().
 */
export interface AtlasAuthClient {
  signIn: {
    email: (opts: { email: string; password: string }) => Promise<{ error?: { message?: string } | null }>;
  };
  signUp: {
    email: (opts: { email: string; password: string; name: string }) => Promise<{ error?: { message?: string } | null }>;
  };
  signOut: () => Promise<unknown>;
  useSession: () => { data?: { user?: { email?: string; role?: string } } | null; isPending: boolean };
}

/** Auth helpers passed to action approval cards via context. */
export interface ActionAuthValue {
  getHeaders: () => Record<string, string>;
  getCredentials: () => "include" | "omit" | "same-origin";
}

export interface AtlasUser {
  id: string;
  mode: Exclude<AuthMode, "none">;
  label: string;
  /** Permission role for action approval. Defaults based on auth mode when not set. */
  role?: AtlasRole;
  /** Active organization ID from session. All data is scoped to this org. */
  activeOrganizationId?: string;
  /** Auth-source claims for RLS policy evaluation (JWT payload, session user, or env-derived). */
  claims?: Readonly<Record<string, unknown>>;
}

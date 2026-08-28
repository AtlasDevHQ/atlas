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
 * vs platform-only). This union spans both role surfaces: as of #2890 the
 * admin-plugin `user.role` column only ever holds `platform_admin` (or a
 * non-admin default), while `owner`/`admin`/`member` live on the org
 * plugin's `member.role`. An effective role (the merge of the two) may be
 * any value in this tuple.
 */
export const ATLAS_ROLES = [...ORG_ROLES, ...PLATFORM_ROLES] as const;
export type AtlasRole = (typeof ATLAS_ROLES)[number];

export const ATLAS_MODES = ["developer", "published"] as const;
export type AtlasMode = (typeof ATLAS_MODES)[number];

/**
 * Roles that qualify for admin-level features (developer mode, admin console, etc.).
 *
 * Single-sourced as of #2890: `owner` and `admin` are the org-plugin
 * `member.role` values (per-workspace), and `platform_admin` is the only
 * remaining admin-plugin `user.role` value (cross-tenant). The redundant
 * system-wide `user.role = "admin"` middle state was dropped — every tenant
 * admin now flows exclusively through `member.role`, so the `admin` here
 * comes from exactly one surface.
 */
export const ADMIN_ROLES = ["owner", "admin", "platform_admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

// ── Permission flags (granular RBAC) ───────────────────────────────

/**
 * Granular permission flags consumed by the enterprise custom-role surface
 * (`@atlas/ee/auth/roles`) and the API's `admin-router.ts` permission
 * middleware.
 *
 * ⚠️ **Publication sequencing (#5194).** This tuple moved here from
 * `packages/api/src/lib/auth/permissions.ts` in two gated stages: it was
 * added here and PUBLISHED (0.11.0) first, and only then did the api module
 * become a re-export — because Deploy Validation builds `packages/api`
 * against the published `@useatlas/types`, so a re-export of a symbol npm
 * doesn't have yet fails the scaffold build
 * (`Export PERMISSIONS doesn't exist in target module`), which is what
 * reverted the first attempt. Any future symbol promoted into this package
 * must follow the same sequence: publish first, re-export after.
 *
 * ⚠️ **This package publishes to npm, so these flag ids are public
 * contract**: removing or renaming a flag is a breaking change for external
 * consumers, not an internal refactor. Additions are safe; renames need a
 * major-version conversation.
 *
 * Flag semantics, the per-route enforcement tables, and the add-a-flag
 * checklist (backfill migration, `BUILTIN_ROLES`, `LEGACY_ROLE_PERMISSIONS`)
 * live with the enforcement code in `packages/api/src/lib/auth/permissions.ts`
 * and `packages/api/src/api/routes/dashboards.ts` — deliberately not
 * duplicated here, where they would drift unwatched.
 */
export const PERMISSIONS = [
  "query",
  "query:raw_data",
  // dashboards:read / dashboards:write split on "does this persist", not on
  // HTTP method (#5189); dashboards:share is a distinct authority — minting a
  // PUBLIC share token publishes workspace data to the unauthenticated
  // internet, which is not a degree of editing (#5192).
  "dashboards:read",
  "dashboards:write",
  "dashboards:share",
  "admin:users",
  "admin:connections",
  "admin:settings",
  "admin:audit",
  "admin:roles",
  "admin:semantic",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Validate that a string is a known permission flag. */
export function isValidPermission(p: string): p is Permission {
  return (PERMISSIONS as readonly string[]).includes(p);
}

// ── Client-side auth interfaces ────────────────────────────────────
// Shared between @atlas/web and @useatlas/react so each package has
// a single source of truth for auth client shapes.

/**
 * Duck-typed interface that matches better-auth's client shape. Only the
 * fields Atlas actually reads or calls are declared — adding a new
 * better-auth API to the surface is a deliberate edit here, which is the
 * right friction for an external dependency.
 *
 * Recurring `as unknown as { ... }` casts at call sites mean a field is
 * missing from this surface — widen here instead of widening one consumer.
 */
export interface AtlasAuthClient {
  signIn: {
    email: (opts: { email: string; password: string }) => Promise<{ error?: { message?: string } | null }>;
  };
  signUp: {
    email: (opts: { email: string; password: string; name: string }) => Promise<{ error?: { message?: string } | null }>;
  };
  signOut: () => Promise<unknown>;
  /**
   * Update the signed-in user's profile fields. Better Auth ships more
   * keys than `name`; declare only the ones Atlas actually writes.
   */
  updateUser?: (opts: { name?: string }) => Promise<{ error?: { message?: string } | null }>;
  useSession: () => {
    data?: {
      user?: {
        email?: string;
        // The underlying `user.role` column is nullable (no role assigned
        // yet). Better Auth's admin plugin types it `string | undefined`, but
        // the DB column and the server's `customSession` merge can surface a
        // `null`; mirror `| null` so consumers narrow instead of assuming a
        // string. `effectiveRole` below is `string | null` for the same reason.
        role?: string | null;
        /**
         * Org-merged effective role — `max(user.role, active-org member.role)`.
         * Stamped by the server's `customSession` plugin so an org admin
         * whose `user.role` defaulted to "user" still sees admin chrome.
         * Optional for back-compat with older sessions; consumers
         * (`useUserRole`) fall back to `role`.
         */
        effectiveRole?: string | null;
        /** Display name — present at runtime, not always populated. */
        name?: string;
        /**
         * True when TOTP is enrolled — surfaced by the two-factor plugin.
         * Better Auth's plugin type is `boolean`, but the underlying column
         * is nullable (`required: false`), so the runtime value can be `null`
         * before enrollment; mirror `| null`. Consumers compare `=== true`.
         */
        twoFactorEnabled?: boolean | null;
      };
      session?: {
        /** Session row id — used to identify "this session" in revoke flows. */
        id?: string;
        /** Active organization id — set by the organization plugin. */
        activeOrganizationId?: string;
        /** Active organization name — fallback when the org list hasn't loaded. */
        activeOrganizationName?: string;
      };
    } | null;
    isPending: boolean;
    /** Imperative refetch — better-auth exposes this on the React hook. */
    refetch?: () => unknown;
  };
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

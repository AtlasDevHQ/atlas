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
 * Granular permission flags — the sibling of `ATLAS_ROLES` above, and here for
 * the same reason (#5191).
 *
 * This lived in `packages/api/src/lib/auth/permissions.ts` and was exported
 * from no published package, so the web could not reach it. The cost was three
 * separate defects that all reduce to "a hand-written second copy":
 *
 *   • `packages/web/src/app/admin/roles/__tests__/permission-grouping.test.ts`
 *     restated the tuple, with a comment saying so.
 *   • `PERMISSION_LABELS` / `PERMISSION_GROUPS` in the roles editor were
 *     `Record<string, …>`, so a flag with no label rendered as a raw id in a
 *     badge instead of failing the build.
 *   • SEVEN API test mocks hand-enumerated it and every one was stale (the
 *     issue said six; `admin-residency.test.ts` is the seventh — counted with
 *     `git grep -l 'PERMISSIONS: \[' origin/main`).
 *
 * The web resolves this package as `workspace:*`, so no npm publish is needed
 * for a consumer to see a new flag — publishing happens on `/publish`'s own
 * cadence.
 *
 * ⚠️ Adding a flag still requires three more edits, and the FIRST is the one
 * that bites:
 *   1. A **backfill migration** reconciling seeded `custom_roles` rows.
 *      Without it the flag is silently absent for every workspace that has
 *      ever opened /admin/roles, because `resolvePermissions` returns the
 *      stored set rather than unioning it with the code definitions.
 *      `ee/src/auth/roles.test.ts` has a drift guard that reddens if the
 *      newest backfill disagrees with `BUILTIN_ROLES`.
 *   2. The right `BUILTIN_ROLES` entries in `ee/src/auth/roles.ts`. Only
 *      `admin` picks a new flag up automatically (`[...PERMISSIONS]`); the
 *      others are hand-listed, which is deliberate — see `dashboards:share`.
 *   3. `LEGACY_ROLE_PERMISSIONS` in
 *      `packages/api/src/lib/auth/permission-resolve.ts` for non-EE deploys.
 */
export const PERMISSIONS = [
  "query",
  "query:raw_data",
  // #5189 — the first pair ENFORCED outside the admin perimeter. Every
  // `admin:*` flag below is gated by `adminAuth` upstream, so those can only
  // ever *subtract* from admin; these are enforced by
  // `requireWorkspacePermission` and can therefore GRANT to an
  // analyst/viewer/member who is not an org admin. (`query`/`query:raw_data`
  // above are non-admin-named but are not enforced at any route today.)
  //
  // The read/write split is **does this persist**, not **is this a GET**. Read
  // covers non-persisting viewing: list/get/render/export/screenshot. Write
  // covers anything that persists — create/update/delete, cards, org share
  // links, BOTH refresh routes (they UPDATE the published card cache) and
  // `GET /{id}/draft` (the first call forks) — plus the authoring assists
  // `/suggest` and `/preview-card`. The per-route table and the full sweep
  // live in `api/routes/dashboards.ts`; keep the rule stated in one place and
  // this pointing at it, because an earlier draft of this comment stated the
  // method-based rule that was rejected, at the definition site a reader
  // reaches first.
  "dashboards:read",
  "dashboards:write",
  // #5192 — a THIRD dashboards flag, and the reason it is not a finer slice of
  // authoring: `POST /{id}/share` in `shareMode: "public"` mints a token
  // served by `publicDashboards` at `/api/public/dashboards/{token}`, which
  // bypasses auth entirely. That is publishing workspace data to the
  // unauthenticated internet — a distinct authority from "can edit a
  // dashboard", not a degree of it. #5189's two-flags-not-three decision was
  // about read-vs-write granularity within authoring and still stands.
  //
  // Withheld from `member`, `analyst` and `viewer`; admin/owner/platform_admin
  // pick it up through the `[...PERMISSIONS]` spreads. Enforced in the share
  // handler on the PUBLIC branch only — an `org`-mode share re-checks org
  // membership on read, so it is authoring-adjacent and stays on
  // `dashboards:write`, as does REVOKING a link (de-escalation must never be
  // harder than escalation).
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

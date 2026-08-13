/**
 * Permission resolution + check — moved to core in #2571 (slice 9/11
 * of #2017) so the `RolesPolicy` Tag's no-op default can answer
 * `checkPermission(...)` without a hard `@atlas/ee` dep.
 *
 * Two entry points:
 *
 *  - `checkPermissionLegacy` — pure legacy-mapping check, no DB read.
 *    Used by `NoopRolesPolicyLayer` so the self-hosted path doesn't
 *    burn an `internalQuery` call on every admin request (and so
 *    tests don't have to seed an extra mock-chain entry just to clear
 *    the F-53 chokepoint).
 *
 *  - `resolvePermissions` / `hasPermission` / `checkPermission` — the
 *    full resolution including the `custom_roles` table read. EE's
 *    `RolesPolicyLive` re-binds the Tag to these so workspaces with
 *    seeded custom roles see the granular permission set.
 *
 * **Load-bearing**: the legacy mapping below is the single source of
 * truth for what each built-in role grants on self-hosted (where EE
 * isn't loaded) AND for the fall-through when no `custom_roles` row
 * matches the user's `member.role` on enterprise. Removing or
 * narrowing entries is a security change — see F-53 in
 * `.claude/research/security-audit-1-2-3.md`.
 */

import { Effect } from "effect";
import {
  PERMISSIONS,
  isValidPermission,
  type Permission,
} from "@atlas/api/lib/auth/permissions";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type { AtlasRole } from "@useatlas/types";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth:permission-resolve");

/** Internal row shape from the `custom_roles` table. */
interface CustomRoleRow {
  id: string;
  org_id: string;
  name: string;
  description: string;
  permissions: string | string[];
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Legacy role-to-permission mapping. `platform_admin` and `admin` get
 * every flag; `member` gets the query read pair plus the dashboards pair;
 * unknown roles fall through to `member`. Adding a new built-in role to
 * `ATLAS_ROLES` requires a matching entry here.
 *
 * #5189 — `member` carries BOTH dashboards flags because a non-EE deploy has
 * no way to express a `viewer`: `member` is the analyst persona there, and
 * read-only would leave such a deploy with no author below admin. This is an
 * expansion from nothing rather than a relaxation — before #5189 `adminAuth`
 * denied `member` the dashboards surface outright.
 *
 * ⚠️ #5192 — `member` does NOT carry `dashboards:share`, and the omission is
 * the fix, not an oversight. That flag gates minting a PUBLIC share link, which
 * is readable by anyone on the internet with no account; #5190 moved the route
 * off `adminAuth` onto `dashboards:write` and thereby handed every `member` on
 * every non-EE self-hosted deploy a capability that had been admin-only. The
 * three `[...PERMISSIONS]` spreads above pick the flag up automatically; this
 * entry is hand-listed, so leaving it out is what withholds it. Adding it here
 * re-opens #5192.
 */
const LEGACY_ROLE_PERMISSIONS = {
  owner: [...PERMISSIONS],
  admin: [...PERMISSIONS],
  platform_admin: [...PERMISSIONS],
  member: ["query", "query:raw_data", "dashboards:read", "dashboards:write"],
  // `satisfies`, not an annotation: it makes a missing `AtlasRole` and a typo'd
  // key compile errors while the inferred type stays indexable by `string` for
  // the deliberate unknown-role fall-through below. Annotated as
  // `Record<string, …>` neither was caught — and since the fall-through target
  // is `member`, a typo in the `admin` key would have handed every admin on a
  // self-hosted deploy the member set with no test going red.
} satisfies Record<AtlasRole, readonly Permission[]>;

/**
 * The same mapping, keyed for a free-string lookup. `resolveLegacyPermissions`
 * is handed `user.role`, which is typed `AtlasRole` but at runtime carries EE
 * custom-role names — so the lookup key is genuinely a string, and a plain
 * object index would expose `Object.prototype` members to it.
 */
const LEGACY_ROLE_PERMISSION_LOOKUP: ReadonlyMap<string, readonly Permission[]> =
  new Map(Object.entries(LEGACY_ROLE_PERMISSIONS));

/**
 * Permissions for a user using only the legacy role mapping — no DB
 * read. Returns the full PERMISSIONS set for the `mode === "none"`
 * (no-auth dev) path so local development keeps working.
 */
const resolveLegacyPermissions = (
  user: AtlasUser | undefined,
): Effect.Effect<Set<Permission>> =>
  Effect.gen(function* () {
    if (!user) {
      const { detectAuthMode } = yield* Effect.promise(
        () => import("@atlas/api/lib/auth/detect"),
      );
      const mode = detectAuthMode();
      if (mode === "none") {
        return new Set([...PERMISSIONS]);
      }
      log.warn(
        "resolveLegacyPermissions called with undefined user in managed auth mode — denying all",
      );
      return new Set<Permission>();
    }
    const role = user.role ?? "member";
    // Look up through a Map, not by indexing the object literal. `role` is a
    // session-derived free string (it carries EE custom-role names), so
    // `role === "toString"` would index `Object.prototype` and return a
    // truthy FUNCTION — skipping the warn below and then throwing inside
    // `new Set(...)`, which surfaces as a 503 rather than the intended
    // fall-through. A Map has no prototype keys, and it drops the cast that was
    // re-widening what `satisfies` had just narrowed.
    const mapped = LEGACY_ROLE_PERMISSION_LOOKUP.get(role);
    if (!mapped) {
      // #5189 — the fall-through is deliberate, but it is now a GRANT: `member`
      // carries `dashboards:write`, so an unrecognized role name (a custom EE
      // role deleted while members still carry it) silently acquires dashboard
      // authoring. Before the dashboards flags it fell through to two harmless
      // query flags and saying nothing was defensible. Its sibling deny-path a
      // few lines up already logs; an authorization decision made on a name
      // nobody recognizes should not be the quiet one.
      log.warn(
        { userId: user.id, role, orgId: user.activeOrganizationId },
        "Unrecognized role — falling through to the `member` permission set (which includes dashboards:write)",
      );
    }
    return new Set(mapped ?? LEGACY_ROLE_PERMISSIONS.member);
  });

/**
 * Resolve the effective permissions for a user session.
 *
 * Resolution strategy:
 * 1. If internal DB has a `custom_roles` row matching the user's role,
 *    use its permission set.
 * 2. Otherwise fall back to the legacy role mapping.
 *
 * Does NOT call `requireEnterprise` — used during request handling
 * where the check should be transparent. EE's `RolesPolicyLive` wires
 * this as the Tag's `resolvePermissions`; the no-op default uses
 * `resolveLegacyPermissions` instead so self-hosted skips the DB read.
 */
export const resolvePermissions = (
  user: AtlasUser | undefined,
): Effect.Effect<Set<Permission>> =>
  Effect.gen(function* () {
    if (!user) {
      return yield* resolveLegacyPermissions(undefined);
    }

    const role = user.role ?? "member";

    // Try custom-role row if internal DB is available
    if (hasInternalDB() && user.activeOrganizationId) {
      const result = yield* Effect.tryPromise({
        try: () =>
          internalQuery<CustomRoleRow>(
            `SELECT id, org_id, name, description, permissions, is_builtin, created_at, updated_at
             FROM custom_roles
             WHERE org_id = $1 AND name = $2
             LIMIT 1`,
            [user.activeOrganizationId, role],
          ),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.map((rows) => {
          if (rows[0]) {
            const row = rows[0];
            let raw: string[];
            try {
              raw = typeof row.permissions === "string"
                ? (JSON.parse(row.permissions) as string[])
                : row.permissions;
            } catch (err) {
              log.error(
                {
                  roleId: row.id,
                  roleName: row.name,
                  err: err instanceof Error ? err.message : String(err),
                },
                "Failed to parse permissions JSON for role — defaulting to empty",
              );
              raw = [];
            }
            const unknown = raw.filter((p) => !isValidPermission(p));
            if (unknown.length > 0) {
              log.warn(
                { roleId: row.id, unknownPermissions: unknown },
                "Role contains unrecognized permissions — these will be ignored",
              );
            }
            return new Set(raw.filter(isValidPermission)) as Set<Permission>;
          }
          return null;
        }),
        Effect.catchAll((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("does not exist")) {
            log.debug(
              "custom_roles table not yet created — using legacy permissions",
            );
            return Effect.succeed(null);
          }
          // Defect on unexpected DB errors so the caller surfaces a
          // distinct 503 `permissions_unavailable`. F-53 explicitly
          // forbids the silent fallback to a stripped-down set here.
          log.error(
            { err: msg },
            "Failed to resolve custom role — surfacing as permissions_unavailable",
          );
          return Effect.die(err instanceof Error ? err : new Error(msg));
        }),
      );

      if (result !== null) return result;
    }

    // Legacy fallback
    return yield* resolveLegacyPermissions(user);
  });

/**
 * Check whether a user has a specific permission. Uses the full
 * `resolvePermissions` path (with custom-roles table read).
 */
export const hasPermission = (
  user: AtlasUser | undefined,
  permission: Permission,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const perms = yield* resolvePermissions(user);
    return perms.has(permission);
  });

/**
 * F-53 chokepoint — returns `null` when the user holds `permission`,
 * or a 403 body to surface to the caller. Uses the full
 * `resolvePermissions` path; EE's `RolesPolicyLive` binds this to the
 * Tag so the custom-roles table is consulted on enterprise.
 */
export const checkPermission = (
  user: AtlasUser | undefined,
  permission: Permission,
  requestId: string,
): Effect.Effect<{ body: Record<string, unknown>; status: 403 } | null> =>
  Effect.gen(function* () {
    const allowed = yield* hasPermission(user, permission);
    return permissionResponse(user, permission, requestId, allowed);
  });

/**
 * Legacy-only F-53 chokepoint — skips the `custom_roles` DB read.
 * Used by `NoopRolesPolicyLayer` so self-hosted doesn't burn an
 * internalQuery per admin request.
 */
export const checkPermissionLegacy = (
  user: AtlasUser | undefined,
  permission: Permission,
  requestId: string,
): Effect.Effect<{ body: Record<string, unknown>; status: 403 } | null> =>
  Effect.gen(function* () {
    const perms = yield* resolveLegacyPermissions(user);
    return permissionResponse(user, permission, requestId, perms.has(permission));
  });

function permissionResponse(
  user: AtlasUser | undefined,
  permission: Permission,
  requestId: string,
  allowed: boolean,
): { body: Record<string, unknown>; status: 403 } | null {
  if (allowed) return null;
  log.warn(
    { userId: user?.id, permission, requestId },
    "Permission check failed: user lacks %s",
    permission,
  );
  return {
    body: {
      error: "insufficient_permissions",
      message: `This action requires the "${permission}" permission.`,
      requestId,
    },
    status: 403,
  };
}

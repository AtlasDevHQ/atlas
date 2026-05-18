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
 * every flag; `member` gets the query read pair; unknown roles fall
 * through to `member`. Adding a new built-in role to `ATLAS_ROLES`
 * requires a matching entry here.
 */
const LEGACY_ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  owner: [...PERMISSIONS],
  admin: [...PERMISSIONS],
  platform_admin: [...PERMISSIONS],
  member: ["query", "query:raw_data"],
};

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
    const perms = LEGACY_ROLE_PERMISSIONS[role] ?? LEGACY_ROLE_PERMISSIONS.member;
    return new Set(perms);
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

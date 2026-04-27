/**
 * Factory functions for admin and platform routers.
 *
 * Eliminates the 4-line boilerplate (OpenAPIHono + adminAuth + requestContext +
 * eeOnError) repeated across 22 admin/platform route files, and the ~8-line
 * org-context extraction repeated in ~85 handlers.
 *
 * Usage:
 * ```ts
 * // Org-scoped admin route (most common)
 * const router = createAdminRouter();
 * router.use(requireOrgContext());
 * router.openapi(route, async (c) => {
 *   const { requestId, orgId } = c.get("orgContext");
 * });
 *
 * // Platform-wide admin route (no org scoping)
 * const router = createPlatformRouter();
 * router.openapi(route, async (c) => {
 *   const requestId = c.get("requestId");
 * });
 * ```
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { Effect } from "effect";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { createLogger } from "@atlas/api/lib/logger";
import { validationHook } from "./validation-hook";
import { eeOnError } from "./ee-error-handler";
import {
  adminAuth,
  platformAdminAuth,
  requestContext,
  type AuthEnv,
} from "./middleware";
import { mfaRequired } from "./admin-mfa-required";
import type { Permission } from "@atlas/ee/auth/roles";
import type { AtlasUser } from "@atlas/api/lib/auth/types";

const log = createLogger("admin-router:permission");

/**
 * Sentinel returned by `loadCheckPermission` when `@atlas/ee/auth/roles`
 * cannot be imported — surfaces as a distinct fail-closed branch in the
 * caller rather than collapsing into the generic "insufficient_permissions"
 * 403 response shape.
 */
const PERMISSION_LOAD_FAILED = Symbol("permissionLoadFailed");
type PermissionLoadFailed = typeof PERMISSION_LOAD_FAILED;

type CheckPermissionFn = (
  user: AtlasUser | undefined,
  permission: Permission,
  requestId: string,
) => Effect.Effect<{ body: Record<string, unknown>; status: 403 } | null>;

/**
 * Lazy-import `checkPermission` from `@atlas/ee/auth/roles`.
 *
 * The lazy pattern matches the IP-allowlist guard in `middleware.ts` — both
 * keep the EE module out of every test file that mocks `effect` with a
 * partial shim (those shims don't carry `Data.TaggedError`, which `roles.ts`
 * uses transitively).
 *
 * Failure handling differs from the IP-allowlist guard on purpose:
 * IP-allowlist treats "EE not installed" as feature-off and falls open. This
 * helper sits on the admin authorization chokepoint — if the module can't
 * load we cannot decide whether the caller's role carries the flag, so we
 * **fail closed**. Returning the sentinel lets the caller emit a typed 503
 * `service_unavailable` instead of a misleading 403 that would point a
 * frustrated admin at their role config when the actual fault is the EE
 * module being unavailable.
 */
async function loadCheckPermission(): Promise<CheckPermissionFn | PermissionLoadFailed> {
  try {
    const mod = (await import("@atlas/ee/auth/roles")) as { checkPermission: CheckPermissionFn };
    if (typeof mod.checkPermission !== "function") {
      log.error("loadCheckPermission: @atlas/ee/auth/roles loaded but did not export checkPermission");
      return PERMISSION_LOAD_FAILED;
    }
    return mod.checkPermission;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "loadCheckPermission: failed to import @atlas/ee/auth/roles — failing closed",
    );
    return PERMISSION_LOAD_FAILED;
  }
}

function permissionLoadFailedResponse(
  requestId: string,
): { body: Record<string, unknown>; status: 503 } {
  return {
    body: {
      error: "permissions_unavailable",
      message:
        "Authorization service is temporarily unavailable. Retry in a moment; if this persists, contact an operator.",
      requestId,
    },
    status: 503,
  };
}

// ---------------------------------------------------------------------------
// Env types
// ---------------------------------------------------------------------------

export type OrgContext = { requestId: string; orgId: string };

/**
 * Extends AuthEnv with the orgContext variable set by requireOrgContext().
 * Used by admin routers whose handlers need org-scoped context.
 */
export type OrgContextEnv = AuthEnv & {
  Variables: AuthEnv["Variables"] & {
    orgContext: OrgContext;
  };
};

// ---------------------------------------------------------------------------
// Router factories
// ---------------------------------------------------------------------------

/**
 * Create a pre-configured admin router.
 *
 * Wires up: validationHook, adminAuth, requestContext, eeOnError.
 * Add `router.use(requireOrgContext())` for org-scoped routes.
 */
export function createAdminRouter() {
  const router = new OpenAPIHono<OrgContextEnv>({ defaultHook: validationHook });
  router.use(adminAuth);
  // F-MFA — block admin access until the user has enrolled a TOTP second
  // factor. Order matters: must run after adminAuth (which sets authResult)
  // and before any handler. The middleware lets enrollment + sign-out
  // through so the user can complete setup. See #1925.
  router.use(mfaRequired);
  router.use(requestContext);
  router.onError(eeOnError);
  return router;
}

/**
 * Create a pre-configured platform admin router.
 *
 * Wires up: validationHook, platformAdminAuth, requestContext.
 */
export function createPlatformRouter() {
  const router = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });
  router.use(platformAdminAuth);
  // F-MFA — same gate as createAdminRouter. platform_admin role is
  // explicitly enforced inside mfaRequired.
  router.use(mfaRequired);
  router.use(requestContext);
  router.onError(eeOnError);
  return router;
}

// ---------------------------------------------------------------------------
// requireOrgContext middleware
// ---------------------------------------------------------------------------

/**
 * Middleware that validates hasInternalDB() and extracts the active org ID.
 *
 * On success, sets `c.var.orgContext = { requestId, orgId }`.
 * Returns 404 if no internal DB, 400 if no active organization.
 */
export function requireOrgContext() {
  return createMiddleware<OrgContextEnv>(async (c, next) => {
    const requestId = c.get("requestId");

    if (!hasInternalDB()) {
      return c.json(
        { error: "not_available", message: "No internal database configured.", requestId },
        404,
      );
    }

    const authResult = c.get("authResult");
    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json(
        {
          error: "bad_request",
          message: "No active organization. Set an active org first.",
          requestId,
        },
        400,
      );
    }

    c.set("orgContext", { requestId, orgId });
    await next();
  });
}

// ---------------------------------------------------------------------------
// requirePermission middleware (F-53)
// ---------------------------------------------------------------------------

/**
 * Refines `adminAuth`'s coarse role gate with a permission-flag check.
 *
 * `adminAuth` accepts any user whose role ∈ {admin, owner, platform_admin};
 * this middleware additionally verifies the user's role carries the
 * specified permission flag. Custom roles assigned via the EE custom-role
 * surface (`ee/src/auth/roles.ts`) get evaluated against their stored
 * permission set; legacy `member`/`admin`/`owner` roles fall through to the
 * `LEGACY_ROLE_PERMISSIONS` mapping so self-hosted deploys without EE
 * keep working.
 *
 * Add ONCE per router after `requireOrgContext()`. Composes cleanly with
 * future sibling guards (e.g. F-57 SCIM-provenance) — the middleware
 * runs `checkPermission` and short-circuits with 403 on denial; otherwise
 * it passes through.
 *
 * `auth mode === "none"` (local dev / self-hosted no-auth) is treated as
 * implicit admin: `adminAuth` lets the request through with `authResult.user`
 * possibly undefined, and `resolvePermissions` short-circuits an undefined
 * user in `mode === "none"` to the full PERMISSIONS set — so every flag
 * passes without consulting the legacy mapping or the custom-roles table.
 *
 * @example
 * ```ts
 * const router = createAdminRouter();
 * router.use(requireOrgContext());
 * router.use(requirePermission("admin:audit"));
 * ```
 */
export function requirePermission(permission: Permission) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const requestId = c.get("requestId");
    const authResult = c.get("authResult");

    // adminAuth has already 401'd unauthenticated requests and 403'd
    // non-admin roles. We're inside the admin perimeter — `authResult` is
    // always set when this middleware runs.
    const checkPermission = await loadCheckPermission();
    if (checkPermission === PERMISSION_LOAD_FAILED) {
      const failed = permissionLoadFailedResponse(requestId);
      return c.json(failed.body, failed.status);
    }

    let result: { body: Record<string, unknown>; status: 403 } | null;
    try {
      result = await Effect.runPromise(
        checkPermission(authResult.user as AtlasUser | undefined, permission, requestId),
      );
    } catch (err) {
      // Defect inside the Effect (e.g. unexpected throw) — fail closed with
      // a distinct 503 so the caller doesn't see an "insufficient_permissions"
      // 403 when the actual fault is the authorization layer crashing.
      log.error(
        { err: err instanceof Error ? err.message : String(err), permission, requestId },
        "checkPermission threw an unexpected error — failing closed",
      );
      const failed = permissionLoadFailedResponse(requestId);
      return c.json(failed.body, failed.status);
    }

    if (result) {
      return c.json(result.body, result.status);
    }

    await next();
  });
}

/**
 * Inline permission check for routes that authenticate within the handler
 * body (admin.ts pattern via `adminAuthAndContext`) rather than through
 * `createAdminRouter` middleware.
 *
 * Returns the 403 response shape on denial, or `null` to continue. Callers
 * surface the response directly:
 *
 * @example
 * ```ts
 * const { authResult, requestId } = await adminAuthAndContext(c);
 * const denied = await enforcePermission(authResult.user, "admin:users", requestId);
 * if (denied) return c.json(denied.body, denied.status);
 * ```
 */
export async function enforcePermission(
  user: AtlasUser | undefined,
  permission: Permission,
  requestId: string,
): Promise<{ body: Record<string, unknown>; status: 403 | 503 } | null> {
  const checkPermission = await loadCheckPermission();
  if (checkPermission === PERMISSION_LOAD_FAILED) {
    return permissionLoadFailedResponse(requestId);
  }
  try {
    return await Effect.runPromise(checkPermission(user, permission, requestId));
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), permission, requestId },
      "checkPermission threw an unexpected error — failing closed",
    );
    return permissionLoadFailedResponse(requestId);
  }
}

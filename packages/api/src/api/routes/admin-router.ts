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
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { validationHook } from "./validation-hook";
import { eeOnError } from "./ee-error-handler";
import {
  adminAuth,
  platformAdminAuth,
  requestContext,
  type AuthEnv,
} from "./middleware";

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

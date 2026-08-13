/**
 * Factory + permission gate for org-scoped routes that are NOT admin routes.
 *
 * ## Why this exists (#5189)
 *
 * Before this file, every permission-gated router in the tree was built through
 * `createAdminRouter()`, which mounts `adminAuth` first. `requirePermission` is
 * documented as *refining* that coarse gate — it assumes `adminAuth` already
 * ran and 403'd anyone outside `{admin, owner, platform_admin}`. The
 * consequence is structural: **the permission system could only ever subtract
 * from admin, never grant to a non-admin.** An `analyst` — a first-class
 * built-in role in `ee/src/auth/roles.ts`, whose entire description is querying
 * data — was 403'd by `adminAuth` before `checkPermission` was ever consulted.
 *
 * So a core analyst-loop surface had exactly two options: admin-only, or
 * ungated. Dashboards took the first and that is what produced #5188's login
 * loop. This module is the third option.
 *
 * ## What it is NOT
 *
 * Not a relaxation of the admin perimeter. The admin console, connections,
 * audit, billing, roles and settings keep `createAdminRouter()` and every gate
 * that comes with it. This is for surfaces that were never admin surfaces and
 * were only sitting behind the admin gate because it was the only gate wired to
 * the permission system.
 *
 * ## The MFA decision, made explicit rather than inherited
 *
 * `createAdminRouter()` mounts `mfaRequired`; this factory deliberately does
 * not. The `/privacy` §9 + `/dpa` Annex II commitment is about **admin**
 * access, and it is kept in full by the routers that stay admin.
 *
 * The load-bearing detail is that `mfaRequired` only enforces on
 * `admin` / `owner` / `platform_admin` (`ENFORCED_ROLES`). An `analyst` was
 * never gated by it. Carrying the gate onto a workspace surface would
 * therefore not make the *action* second-factor-protected — it would make it
 * protected for callers who happen to hold an admin org role and unprotected
 * for the analyst doing the same thing at the next desk, which is both weaker
 * than it looks and is precisely #5188's "the most privileged user has the
 * worst experience". The gate follows "is this an admin action", not "did the
 * route happen to use `createAdminRouter`". Recorded on #5189.
 *
 * @example
 * ```ts
 * const router = createWorkspaceRouter();
 * router.use(requireOrgContext());
 * router.openapi(
 *   createRoute({ method: "get", path: "/",
 *     middleware: [requireWorkspacePermission("dashboards:read")], … }),
 *   handler,
 * );
 * ```
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { resolveActorKind } from "@atlas/api/lib/auth/api-key-metadata";
import { createLogger } from "@atlas/api/lib/logger";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type { Permission } from "@atlas/api/lib/auth/permissions";
import { validationHook } from "./validation-hook";
import { eeOnError } from "./ee-error-handler";
import { standardAuth, requestContext, isSaasDeployMode, type AuthEnv } from "./middleware";
import { enforcePermission, type OrgContextEnv } from "./admin-router";

const log = createLogger("workspace-router");

/**
 * The two checks `standardAuth` does not do and `adminAuth` does, kept because
 * dropping either would make this router a WEAKER path to the same data than
 * the admin router it replaces.
 *
 *  1. **Workspace API keys stay denied.** `denyApiKeyOnAdmin` (#4110) blocks
 *     data-plane credentials at the admin chokepoint. A route moving out of
 *     that perimeter would silently become key-reachable, which is a real
 *     expansion of what a key can do and was asked for by nobody. The message
 *     names the workspace surface rather than "admin endpoints", because that
 *     is what the caller actually hit.
 *  2. **`mode: "none"` may not reach a permission gate under SaaS.** The
 *     no-auth local-dev carve-out resolves to the FULL permission set
 *     (`resolveLegacyPermissions`), so in SaaS it would be a total bypass.
 *     `adminAuth` carries this guard (#3342 L-1) and `standardAuth` does not —
 *     the guard exists precisely because the weaker tier was the unguarded one,
 *     and this router is a weaker tier.
 */
export const workspaceActorGuard = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (resolveActorKind(authResult.user?.claims) === "api_key") {
    log.warn(
      { requestId, userId: authResult.user?.id },
      "Workspace API key blocked from a permission-gated workspace route — keys are data-plane credentials",
    );
    return c.json(
      {
        error: "api_key_not_permitted",
        message:
          "Workspace API keys are scoped to data operations (SQL, metrics, explore) and cannot access this endpoint. Use an interactive session.",
        requestId,
      },
      403,
    );
  }

  if (authResult.mode === "none" && isSaasDeployMode()) {
    log.error(
      { requestId },
      'mode:"none" reached a workspace permission gate under SaaS deploy — rejecting',
    );
    return c.json(
      {
        error: "auth_misconfigured",
        message: "Workspace authorization is not configured.",
        requestId,
      },
      500,
    );
  }

  await next();
});

/**
 * Enforce a permission flag OUTSIDE the admin perimeter.
 *
 * The counterpart to `requirePermission`, and the difference is the whole
 * point: that one refines a gate that has already established the caller is an
 * admin, so it can only subtract. This one authorizes on its own, so a role
 * carrying the flag passes whether or not it is an org admin.
 *
 * Everything else is deliberately identical, because the fail-closed posture is
 * the part that must not fork:
 *
 *   • `enforcePermission` runs `checkPermission` through the `RolesPolicy` Tag,
 *     so EE's custom-role resolver and the self-hosted no-op behave here
 *     exactly as they do on admin routes — including the
 *     `permissions_unavailable` 503 when no real implementation is bound.
 *   • A throw inside the Effect fails closed with that same 503 rather than a
 *     403, so "the authorization layer crashed" is never reported as
 *     "you lack permission".
 *   • `mode === "none"` (local dev / self-hosted no-auth) resolves to the full
 *     `PERMISSIONS` set via `resolveLegacyPermissions`, so the implicit-admin
 *     carve-out survives — but only after `workspaceActorGuard` has refused
 *     that mode under SaaS.
 *
 * Mount PER ROUTE via `createRoute({ middleware: [...] })`, not once on the
 * router. Two routers sharing a mount path do not isolate their `use()` chains:
 * measured on hono 4 with `@hono/zod-openapi` 1.5, a read router mounted first
 * runs its gate on the write router's routes too, so a write would silently
 * require BOTH flags — passing today only because every write-capable role also
 * holds read.
 */
export function requireWorkspacePermission(permission: Permission) {
  return createMiddleware<OrgContextEnv>(async (c, next) => {
    const requestId = c.get("requestId");
    const authResult = c.get("authResult");

    const denied = await enforcePermission(
      authResult.user as AtlasUser | undefined,
      permission,
      requestId,
    );
    if (denied) {
      return c.json(denied.body, denied.status);
    }

    await next();
  });
}

/**
 * Create a pre-configured org-scoped workspace router.
 *
 * Wires up: validationHook, standardAuth, workspaceActorGuard, requestContext,
 * eeOnError. Add `router.use(requireOrgContext())` for org-scoped routes, and
 * `requireWorkspacePermission(flag)` per route.
 *
 * Note the absence of `mfaRequired` — see the module docstring.
 */
export function createWorkspaceRouter() {
  const router = new OpenAPIHono<OrgContextEnv>({ defaultHook: validationHook });
  router.use(standardAuth);
  router.use(workspaceActorGuard);
  router.use(requestContext);
  router.onError(eeOnError);
  return router;
}

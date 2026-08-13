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
 * built-in role in `ee/src/auth/roles.ts` whose purpose is the analyst loop,
 * and which this change gives both dashboards flags — was 403'd by `adminAuth`
 * before `checkPermission` was ever consulted.
 *
 * So a core analyst-loop surface had exactly two options: admin-only, or
 * ungated. Dashboards took the first and that is what produced #5188's login
 * loop. This module is the third option.
 *
 * ## What it is NOT
 *
 * Not a relaxation of the admin perimeter. The admin console, connections,
 * audit, roles and settings keep `createAdminRouter()` and every gate that
 * comes with it. (`billing` and `wizard` sit on bare `adminAuth` and never
 * carried `mfaRequired` — see `middleware.ts` §#4110.) This is for surfaces that were never admin surfaces and
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
import { standardAuth, requestContext, isSaasDeployMode } from "./middleware";
import { enforcePermission, type OrgContextEnv } from "./admin-router";

const log = createLogger("workspace-router");

/**
 * `OrgContextEnv` plus the flag `workspaceActorGuard` sets and
 * `requireWorkspacePermission` requires. Declaring it makes the dependency a
 * fact about the type rather than a sentence in a docstring.
 */
type WorkspaceGateEnv = OrgContextEnv & {
  Variables: OrgContextEnv["Variables"] & {
    workspaceActorChecked?: boolean;
  };
};

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
 *     (`resolveLegacyPermissions`, on its undefined-user branch), so in SaaS
 *     it would be a total bypass.
 *     `adminAuth` carries this guard (#3342 L-1) and `standardAuth` does not —
 *     the guard exists precisely because the weaker tier was the unguarded one,
 *     and this router is a weaker tier.
 */
export const workspaceActorGuard = createMiddleware<WorkspaceGateEnv>(async (c, next) => {
  const authResult = c.get("authResult");

  // Middleware-order contract, same guard `mfaRequired` carries for the same
  // reason: `authResult` is set by `standardAuth`, and if this ever runs first a
  // bare property read is an unlogged TypeError surfacing as an opaque 500.
  // Fail closed and say which contract broke.
  if (!authResult) {
    // ⚠️ SEED the request id, don't read one. There is no global request-id
    // middleware, and `standardAuth` — which sets both `requestId` and
    // `authResult` — cannot have run if `authResult` is missing. Reading it
    // emitted a 500 with no correlation handle and a log line with nothing to
    // grep, on the one path built to be a debugging aid. `region-routing.ts`
    // records the same lesson for the same reason.
    //
    // (`withRequestId` is the one opt-in middleware that sets `requestId`
    // ALONE; behind it this mints a second id, accepted as the cost of never
    // emitting a 500 with no handle at all.)
    const seeded = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("requestId", seeded);
    log.error(
      { requestId: seeded },
      "workspaceActorGuard ran before standardAuth — no authResult; failing closed",
    );
    return c.json(
      {
        error: "auth_misconfigured",
        message:
          "Workspace authorization is not configured — the request-authentication middleware did not run. This is a server wiring fault, not a credential problem; retrying will not help.",
        requestId: seeded,
      },
      500,
    );
  }

  const requestId = c.get("requestId");

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

  // Read by `requireWorkspacePermission`. The gate is mounted PER ROUTE and this
  // guard PER ROUTER, so the middleware that grants is not the middleware that
  // guards — a future file composing `standardAuth` + `requireWorkspacePermission`
  // by hand would silently lose both checks above and pass every test written
  // against the composed dashboards app. This makes that misuse fail closed on
  // the first request instead of shipping as a bypass.
  c.set("workspaceActorChecked", true);

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
 *     exactly as they do on admin routes — including the legacy-mapping
 *     fall-through the self-hosted no-op provides, and the
 *     `permissions_unavailable` 503 that a THROWN authorization layer
 *     produces (next bullet). The no-op itself answers allow/403, not 503.
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
  return createMiddleware<WorkspaceGateEnv>(async (c, next) => {
    const requestId = c.get("requestId");
    const authResult = c.get("authResult");

    if (!c.get("workspaceActorChecked")) {
      log.error(
        { requestId, permission },
        "requireWorkspacePermission mounted without workspaceActorGuard — failing closed",
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
  const router = new OpenAPIHono<WorkspaceGateEnv>({ defaultHook: validationHook });
  router.use(standardAuth);
  router.use(workspaceActorGuard);
  router.use(requestContext);
  router.onError(eeOnError);
  return router;
}

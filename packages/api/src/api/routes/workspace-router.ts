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

import { OpenAPIHono, createRoute, type RouteConfig } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { resolveActorKind } from "@atlas/api/lib/auth/api-key-metadata";
import { createLogger } from "@atlas/api/lib/logger";
import type { AtlasUser } from "@atlas/api/lib/auth/types";
import type { Permission } from "@atlas/api/lib/auth/permissions";
import { validationHook } from "./validation-hook";
import { eeOnError } from "./ee-error-handler";
import {
  workspaceAuth,
  requestContext,
  isSaasDeployMode,
  migrationWriteLock,
  type AuthEnv,
} from "./middleware";
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
export function requireWorkspacePermission(permission: Permission): WorkspaceGate {
  // The ONE place a `WorkspaceGate` is minted, and therefore the one cast.
  // `createMiddleware` cannot know about the brand; confining the assertion
  // here is what makes `middleware: [someOtherMiddleware]` a compile error at
  // all 26 call sites without a rule anybody has to remember.
  return asWorkspaceGate(createMiddleware<WorkspaceGateEnv>(async (c, next) => {
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
  }));
}

declare const workspaceGateBrand: unique symbol;

/**
 * A route-level gate for a workspace router — i.e. what
 * `requireWorkspacePermission(flag)` returns.
 *
 * ⚠️ **BRANDED, and the brand is the whole guarantee.** Round 1 of review
 * measured the unbranded version: `MiddlewareHandler<OrgContextEnv>` is
 * satisfied by *any* middleware, so `middleware: [requireOrgContext()]`
 * compiled — with a real, importable, plausible-looking middleware already
 * used in this very file. The compile-time property had degraded to
 * *"someone typed the word `middleware`"*, which is materially weaker than
 * what the docstring below claimed, and the docstring is what the next author
 * trusts.
 *
 * The brand is minted in exactly one place — `requireWorkspacePermission`, the
 * only function allowed to produce a gate — so there is one cast in the module
 * rather than a rule everyone has to remember. This is the repo's own recorded
 * lesson (*brand the OUTPUT, not just the parameter*) applied to the shape it
 * was written for.
 */
export type WorkspaceGate = MiddlewareHandler<OrgContextEnv> & {
  readonly [workspaceGateBrand]: true;
};

/**
 * The ONE place the brand is applied, and therefore the only cast.
 *
 * It has to be a double assertion: the brand is a phantom property no runtime
 * value carries, and hono's `MiddlewareHandler` is effectively invariant in its
 * Env, so `migrationWriteLock` (declared over `AuthEnv`) and
 * `requireWorkspacePermission`'s handler (over `WorkspaceGateEnv`) have no
 * common supertype to widen through. Confining that to one private function
 * with a named parameter type is the trade: two module-owned middlewares
 * convert here, and every other middleware in the tree is rejected at all 26
 * call sites.
 *
 * Do NOT export this. ⚠️ The brand cannot be minted ACCIDENTALLY outside this
 * module — it is not unforgeable, and an earlier draft of this line said it
 * was. Measured: `requireOrgContext() as WorkspaceGate` compiles in one token,
 * with no `unknown` hop, because `WorkspaceGate` is a subtype of
 * `MiddlewareHandler<OrgContextEnv>` and a downcast `as` is always permitted.
 *
 * What the brand does buy is verified: `middleware: [requireOrgContext()]`
 * WITHOUT a cast is now rejected (TS2322), and that bare form is the mistake
 * that was actually made. It stops the accident, not an author who decides to
 * cast.
 */
function asWorkspaceGate(
  m: MiddlewareHandler<AuthEnv> | MiddlewareHandler<WorkspaceGateEnv>,
): WorkspaceGate {
  return m as unknown as WorkspaceGate;
}

/**
 * `createRoute`, with `middleware` REQUIRED (#5191).
 *
 * Every route on a workspace router must declare its permission gate, and
 * before this "every route has one" was enforced only by the runtime tripwire
 * in `__tests__/dashboards-permission.test.ts`. A route added without a gate
 * therefore shipped ungated until that test ran — and it is the kind of test
 * that runs late.
 *
 * ⚠️ **The obvious fix does not work, and it was measured.** Making
 * `workspaceActorChecked` a required context variable produces no error at any
 * call site: `@hono/zod-openapi` types `openapi()`'s env as
 * `RouteMiddlewareParams<R>["env"] & E`, so the route middleware's Env is
 * INTERSECTED into the handler env rather than checked against the app's. It
 * adds a type lie, not a gate.
 *
 * Requiring the field at the DEFINITION site does work, because that is the one
 * place the config object is checked structurally.
 *
 * Two constraints found while probing, both load-bearing:
 *
 *   • `middleware` must be a MUTABLE array type, so `DASHBOARD_READ` /
 *     `DASHBOARD_WRITE` cannot become `as const`. ⚠️ The rejecting party is
 *     THIS function's own `middleware: WorkspaceGate[]` constraint (TS4104,
 *     *"is 'readonly' and cannot be assigned to the mutable type"*), not
 *     hono's `H[]` further down — an earlier draft named hono, which would
 *     mislead anyone relaxing the local constraint and expecting the framework
 *     to still refuse.
 *   • This proves a REAL gate is present — see `WorkspaceGate`'s brand — never
 *     that it is the RIGHT one. Read-vs-write correctness stays with the
 *     runtime route table, which is the right division of labour: the compiler
 *     cannot know that `/refresh` is a write.
 *
 * ⚠️ An EMPTY `middleware: []` still type-checks, and that is deliberate: it is
 * a route someone typed a gate list for and left empty, which the runtime table
 * in `dashboards-permission.test.ts` catches by seeing zero `checkPermission`
 * calls. Do not "fix" the type to reject it and assume the runtime check is
 * therefore redundant — the two guards cover different mistakes.
 */
export function createGatedRoute<
  P extends string,
  R extends Omit<RouteConfig, "path" | "middleware"> & {
    path: P;
    middleware: WorkspaceGate[];
  },
>(config: R) {
  return createRoute(config);
}

/**
 * Create a pre-configured org-scoped workspace router.
 *
 * Wires up: validationHook, workspaceAuth, workspaceActorGuard, requestContext,
 * eeOnError. Add `router.use(requireOrgContext())` for org-scoped routes, and
 * `requireWorkspacePermission(flag)` per route.
 *
 * Note the absence of `mfaRequired` — see the module docstring.
 *
 * ⚠️ #5191 — the rate-limit bucket this router uses is `workspace`, carried by
 * `workspaceAuth`. `adminAuth` passes `bucket: "admin"`; when dashboards moved
 * to `standardAuth` (#5190) the bucket silently became `default`, i.e. the same
 * budget as chat, for a surface that fires one render per card on every load.
 * That was not a decision anyone took.
 *
 * ⚠️ **`migrationWriteLock` is mounted PER WRITE GATE, not here** — see
 * {@link workspaceWriteGate}. Mounting it on the router looks equivalent and is
 * not: the lock keys on the HTTP METHOD, and this surface has read-classified
 * POSTs (`…/cards/{id}/render`, `…/export`). Router-wide, a region migration
 * would 409 every card on a dashboard anyone merely OPENED — an outage strictly
 * worse than the lost write it exists to prevent. Measured in review round 1.
 */
export function createWorkspaceRouter() {
  const router = new OpenAPIHono<WorkspaceGateEnv>({ defaultHook: validationHook });
  router.use(workspaceAuth);
  router.use(workspaceActorGuard);
  router.use(requestContext);
  router.onError(eeOnError);
  return router;
}

/**
 * The gate list for a WRITE route on a workspace router: the permission flag,
 * then the region-migration write lock.
 *
 * ⚠️ **`migrationWriteLock` had never been mounted on ANY router before #5191.**
 * An earlier draft of this comment said `adminAuth` "omits it on purpose" and
 * that this router "inherited the absence" — both false, and verifiable in one
 * command (`git grep migrationWriteLock` on the parent commit returns only the
 * definition). The `middleware.ts` line about admins managing a workspace
 * during migration is guidance on where to OPT IN, not evidence that anything
 * ever did. This is therefore the middleware's first production mount, and it
 * deserves the scrutiny of new code rather than of a restored invariant.
 *
 * What it buys: a `member` editing a dashboard mid-region-migration currently
 * has the edit land in the SOURCE region and silently lost, reported as a 200.
 * The lock answers 409 with a requestId and copy that says what to do.
 *
 * ⚠️ Known gap, stated rather than papered over: `GET /{id}/draft` is
 * WRITE-classified (its first call forks a draft — two INSERTs) but the lock
 * skips it, because `checkMigrationWriteLock` keys on the method and that route
 * is a GET. It was equally unlocked before this change, so this is an unclosed
 * gap rather than a regression. Closing it means teaching the lock about the
 * route's classification instead of its verb.
 */
export function workspaceWriteGate(permission: Permission): WorkspaceGate[] {
  // `migrationWriteLock` reads `authResult`, which `workspaceAuth` sets on the
  // router, so ordering within the request is already satisfied. Within this
  // array the permission check runs first: an unauthorized caller should be
  // told they lack the flag, not that the workspace is migrating.
  return [requireWorkspacePermission(permission), asWorkspaceGate(migrationWriteLock)];
}

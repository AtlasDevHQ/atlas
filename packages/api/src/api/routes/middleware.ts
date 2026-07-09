/**
 * Hono middleware for auth and request context.
 *
 * Replaces inline `adminAuthPreamble()` / `authPreamble()` calls and
 * `withRequestContext()` wrapping. Each middleware sets typed context
 * variables so route handlers can access them via `c.get()`.
 *
 * Usage:
 * ```ts
 * const app = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });
 * app.use(adminAuth);      // or standardAuth
 * app.use(requestContext);
 * ```
 */

import type { Env } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
  type RateLimitBucket,
} from "@atlas/api/lib/auth/middleware";
import { extractTrustDeviceIdentifier } from "@atlas/api/lib/auth/trust-device-cookie";
import { resolveActorKind } from "@atlas/api/lib/auth/api-key-metadata";
import {
  detectMisrouting,
  isStrictRoutingEnabled,
} from "@atlas/api/lib/residency/misrouting";
import { isWorkspaceMigrating } from "@atlas/api/lib/residency/readonly";
import { Effect } from "effect";
import { IpAllowlistPolicy } from "@atlas/api/lib/effect/services";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";

const log = createLogger("middleware");

// ---------------------------------------------------------------------------
// Auth error classification (shared with admin-auth.ts)
// ---------------------------------------------------------------------------

const EXPIRED_AUTH_ERRORS = new Set([
  "Session expired",
  "Session expired (idle timeout)",
  "Invalid or expired token",
  "Session data is invalid",
]);

function authErrorCode(error: string): "session_expired" | "auth_error" {
  return EXPIRED_AUTH_ERRORS.has(error) ? "session_expired" : "auth_error";
}

/**
 * #4110 — workspace API keys are DATA-PLANE credentials. They authenticate the
 * `standardAuth` surface (run SQL/metrics/explore, conversations, sessions,
 * tables, …) and the datasource CLI surface (ADR-0027 gate-parity:
 * `atlas datasource …`), but are denied on true console-admin: billing /
 * `/byot`, the install wizard, connection settings, audit, etc. — surfaces that
 * assume an interactive human (MFA, secret entry, provisioning).
 *
 * Deny by DEFAULT at the single admin chokepoint (`adminAuth` /
 * `platformAdminAuth`) so the boundary is ONE deliberate decision rather than
 * "did the route happen to use `createAdminRouter`". Before this,
 * `createAdminRouter` routes blocked keys only incidentally — via `mfaRequired`
 * (a key carries no MFA claim → 403 `mfa_enrollment_required`, a confusing code)
 * — while bare `.use(adminAuth)` routes (`billing` incl. `/byot`, `wizard`,
 * `datasources /{id}/profile`) let them straight through. This closes that split:
 * a clear, uniform 403 everywhere EXCEPT the explicitly key-allowed datasource
 * routers, which use `adminAuthAllowApiKey` to opt out.
 *
 * Returns a 403 descriptor when the actor is an api-key, else `null`.
 */
function denyApiKeyOnAdmin(
  authResult: AuthResult & { authenticated: true },
  requestId: string,
): { body: Record<string, unknown>; status: 403 } | null {
  if (resolveActorKind(authResult.user?.claims) !== "api_key") return null;
  log.warn(
    { requestId, userId: authResult.user?.id },
    "Workspace API key blocked from an admin route — keys are data-plane credentials",
  );
  return {
    body: {
      error: "api_key_not_permitted",
      message:
        "Workspace API keys are scoped to data operations (SQL, metrics, explore) and cannot access admin endpoints. Use an interactive admin session.",
      requestId,
    },
    status: 403,
  };
}

/**
 * Whether the current deploy mode is SaaS. Lazy-imported to avoid fighting
 * the module graph; getConfig() is a cheap singleton read after boot and
 * returning false if config isn't ready yet is the safe default (the gate
 * is only *stricter* in SaaS; self-hosted behaviour is unchanged).
 */
function isSaasDeployMode(): boolean {
  try {
    // oxlint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require("@atlas/api/lib/config") as {
      getConfig: () => { deployMode?: string } | null;
    };
    return getConfig()?.deployMode === "saas";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Env type — declares context variables set by middleware
// ---------------------------------------------------------------------------

export type AuthEnv = Env & {
  Variables: {
    authResult: AuthResult & { authenticated: true };
    requestId: string;
    atlasMode: import("@useatlas/types/auth").AtlasMode;
    /** See `lib/auth/trust-device-cookie.ts`. Set once by the auth middlewares; reads are uniform. */
    trustDeviceIdentifier: string | undefined;
  };
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function authenticate(
  req: Request,
  requestId: string,
): Promise<
  | { ok: true; authResult: AuthResult & { authenticated: true } }
  | { ok: false; body: Record<string, unknown>; status: number; headers?: Record<string, string> }
> {
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return { ok: false, body: { error: "auth_error", message: "Authentication system error", requestId }, status: 500 };
  }

  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    const body: Record<string, unknown> = {
      error: authErrorCode(authResult.error),
      message: authResult.error,
      requestId,
    };
    if (authResult.ssoRedirectUrl) {
      body.ssoRedirectUrl = authResult.ssoRedirectUrl;
    }
    return { ok: false, body, status: authResult.status };
  }

  return { ok: true, authResult };
}

async function rateLimitAndIPCheck(
  req: Request,
  authResult: AuthResult & { authenticated: true },
  requestId: string,
  bucket: RateLimitBucket = "default",
): Promise<{ body: Record<string, unknown>; status: number; headers?: Record<string, string> } | null> {
  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey, { bucket, orgId: authResult.user?.activeOrganizationId });
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      body: { error: "rate_limited", message: "Too many requests. Please wait before trying again.", retryAfterSeconds, requestId },
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  // IP allowlist — narrow `catch` for tests that omit `IpAllowlistPolicy`
  // from their EnterpriseLayer mock (Effect surfaces this as "Service
  // not found: IpAllowlistPolicy"). Everything else fails closed via 503.
  //
  // **Why the catch persists post-#2588.** The helper (#2588) covers the
  // three Pattern 1 tests. The two Pattern 2 tests (admin-residency,
  // admin-marketplace) mock the whole `effect` module with a synchronous
  // shim — `Layer.succeed`/`ManagedRuntime` don't exist there, so the
  // helper can't migrate them. Until those tests stop shimming `effect`
  // (a separate refactor), this catch is what keeps their middleware
  // path green. The narrow "Service not found: IpAllowlist" match is
  // intentional: broader patterns (Cannot find module / @atlas/ee
  // substring) would silently warn-log a real production EE-load
  // failure that mentions @atlas/ee in its message, bypassing the
  // allowlist.
  const orgId = authResult.user?.activeOrganizationId;
  if (orgId) {
    let ipCheck: { allowed: boolean } | null = null;
    try {
      ipCheck = await runEnterprise(
        Effect.gen(function* () {
          const policy = yield* IpAllowlistPolicy;
          return yield* policy.checkIPAllowlist(orgId, ip);
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isMissingTag =
        msg.includes("Service not found") && msg.includes("IpAllowlist");
      if (isMissingTag) {
        log.warn(
          { err: msg, requestId, orgId },
          "IpAllowlist Tag not provided — test-harness fall-through",
        );
      } else {
        log.error(
          { err: msg, requestId, orgId },
          "IP allowlist check failed — failing closed (no allowlist evaluation)",
        );
        return {
          body: {
            error: "service_unavailable",
            message: "IP allowlist check could not be evaluated. Try again in a moment.",
            requestId,
          },
          status: 503,
        };
      }
    }
    if (ipCheck && !ipCheck.allowed) {
      log.warn({ requestId, orgId, ip }, "IP not in workspace allowlist");
      return {
        body: { error: "ip_not_allowed", message: "Your IP address is not in the workspace's allowlist.", requestId },
        status: 403,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Misrouting detection — checks if the request reached the correct regional API
// ---------------------------------------------------------------------------

async function checkMisrouting(
  c: Context,
  authResult: AuthResult & { authenticated: true },
  requestId: string,
): Promise<{ body: Record<string, unknown>; status: number } | null> {
  const orgId = authResult.user?.activeOrganizationId;
  const result = await detectMisrouting(orgId, requestId);
  if (!result) return null;

  if (isStrictRoutingEnabled()) {
    return {
      body: {
        error: "misdirected_request",
        message: `This request should be directed to the ${result.expectedRegion} region API.`,
        correctApiUrl: result.correctApiUrl,
        expectedRegion: result.expectedRegion,
        actualRegion: result.actualRegion,
        requestId,
      },
      status: 421,
    };
  }

  // Graceful mode — log already happened in detectMisrouting, serve normally
  return null;
}

// ---------------------------------------------------------------------------
// Migration write-lock — reject writes during active region migration
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function checkMigrationWriteLock(
  method: string,
  authResult: AuthResult & { authenticated: true },
  requestId: string,
): Promise<{ body: Record<string, unknown>; status: number } | null> {
  if (!WRITE_METHODS.has(method)) return null;

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) return null;

  try {
    const migrating = await isWorkspaceMigrating(orgId);
    if (migrating) {
      log.warn({ requestId, orgId, method }, "Write rejected — workspace is migrating");
      return {
        body: {
          error: "workspace_migrating",
          message: "This workspace is currently being migrated to a new region. Write operations are temporarily disabled.",
          requestId,
        },
        status: 409,
      };
    }
  } catch (err) {
    // Fail closed — if we can't verify migration status, block writes to prevent data loss
    log.error(
      { err: err instanceof Error ? err.message : String(err), requestId, orgId },
      "Migration write-lock check failed — rejecting write as a precaution",
    );
    return {
      body: {
        error: "migration_check_failed",
        message: "Unable to verify workspace migration status. Write operations are temporarily unavailable.",
        requestId,
      },
      status: 503,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// adminAuth — authenticate + enforce admin role + rate limit + IP allowlist
// ---------------------------------------------------------------------------

/**
 * Build an admin-auth middleware.
 *
 * `allowApiKey` (default `false`) controls the #4110 data-plane boundary: by
 * default a workspace API key is DENIED on admin routes (see
 * {@link denyApiKeyOnAdmin}). The datasource CLI surface (`datasources.ts`
 * profile + `admin-openapi-datasources.ts` create/list/test/…) sets
 * `allowApiKey: true` because ADR-0027's gate-parity contract deliberately makes
 * those admin-floor routes reachable by `atlas datasource …` in unattended CI.
 * No other admin router should set it.
 */
function makeAdminAuth(opts: { allowApiKey?: boolean } = {}) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);

    const auth = await authenticate(c.req.raw, requestId);
    if (!auth.ok) {
      return c.json(auth.body, auth.status as 401, auth.headers);
    }
    const { authResult } = auth;

    // #4110 — workspace API keys are data-plane credentials. Deny them on admin
    // routes at this single chokepoint (clear 403, before role/MFA logic) UNLESS
    // this is the explicitly key-allowed datasource CLI surface.
    if (!opts.allowApiKey) {
      const apiKeyBlocked = denyApiKeyOnAdmin(authResult, requestId);
      if (apiKeyBlocked) {
        return c.json(apiKeyBlocked.body, apiKeyBlocked.status);
      }
    }

    // Defense-in-depth (#3342 L-1): `mode: "none"` is the no-auth local-dev
    // carve-out and must never reach an admin gate in SaaS. Mirrors the
    // platformAdminAuth guard below — the weaker tier was the unguarded one.
    if (authResult.mode === "none" && isSaasDeployMode()) {
      log.error({ requestId }, "mode:\"none\" reached adminAuth under SaaS deploy — rejecting");
      return c.json({ error: "auth_misconfigured", message: "Admin auth is not configured.", requestId }, 500);
    }

    // Enforce admin role — auth mode "none" (local dev) is an implicit admin
    if (
      authResult.mode !== "none" &&
      (!authResult.user ||
        (authResult.user.role !== "admin" &&
          authResult.user.role !== "owner" &&
          authResult.user.role !== "platform_admin"))
    ) {
      log.warn({ requestId, userId: authResult.user?.id, role: authResult.user?.role }, "Non-admin access attempt");
      return c.json({ error: "forbidden_role", message: "Admin role required.", requestId }, 403);
    }

    // Admin namespace gets its own rate-limit bucket (#2485). Interactive
    // forms (Add Connection, Test, Delete in quick succession) burst easily
    // past a low base RPM; bucketing them separately keeps a dogfood session
    // from depleting the cheap-read budget shared with chat.
    const blocked = await rateLimitAndIPCheck(c.req.raw, authResult, requestId, "admin");
    if (blocked) {
      return c.json(blocked.body, blocked.status as 429, blocked.headers);
    }

    const misrouted = await checkMisrouting(c, authResult, requestId);
    if (misrouted) {
      return c.json(misrouted.body, misrouted.status as 421);
    }

    // No migration write-lock for admin routes — admins need to manage
    // the workspace during migration (retry, cancel, configure).

    c.set("authResult", authResult);
    resolveModeForRequest(c, authResult, requestId);
    setTrustDeviceIdentifier(c);
    await next();
  });
}

/** Standard admin gate — denies workspace API keys (#4110). */
export const adminAuth = makeAdminAuth();

/**
 * Admin gate that ALLOWS workspace API keys (#4110). Reserved for the datasource
 * CLI surface — ADR-0027 gate-parity makes `atlas datasource …` key-reachable.
 * Pairs with `mfaRequired`'s api-key exemption so a key clears the factory
 * router's MFA gate too.
 */
export const adminAuthAllowApiKey = makeAdminAuth({ allowApiKey: true });

// ---------------------------------------------------------------------------
// platformAdminAuth — authenticate + enforce platform_admin role + rate limit + IP allowlist
// ---------------------------------------------------------------------------

export const platformAdminAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);

  const auth = await authenticate(c.req.raw, requestId);
  if (!auth.ok) {
    return c.json(auth.body, auth.status as 401, auth.headers);
  }
  const { authResult } = auth;

  // #4110 — a workspace API key is org-scoped and clamped to org roles, so it
  // can never carry `platform_admin`; deny it here anyway for a clear 403 and a
  // uniform admin boundary (a key clamped below the role check would otherwise
  // 403 with the less precise `forbidden_role`).
  const apiKeyBlocked = denyApiKeyOnAdmin(authResult, requestId);
  if (apiKeyBlocked) {
    return c.json(apiKeyBlocked.body, apiKeyBlocked.status);
  }

  // Defense-in-depth: `mode: "none"` is the no-auth local-dev carve-out and
  // must never reach a platform gate in SaaS. If deploy mode is saas and we
  // somehow produced mode:"none" at the auth layer (misconfigured env,
  // regressed detect logic), fail closed — refusing is always safer than
  // granting implicit cross-tenant admin.
  if (authResult.mode === "none" && isSaasDeployMode()) {
    log.error({ requestId }, "mode:\"none\" reached platformAdminAuth under SaaS deploy — rejecting");
    return c.json({ error: "auth_misconfigured", message: "Platform auth is not configured.", requestId }, 500);
  }

  // Enforce platform_admin role — auth mode "none" (local dev / self-hosted
  // no-auth) is an implicit admin. The SaaS guard above prevents this branch
  // from ever being the cross-tenant escape hatch in managed deploys.
  if (authResult.mode !== "none" && (!authResult.user || authResult.user.role !== "platform_admin")) {
    log.warn({ requestId, userId: authResult.user?.id, role: authResult.user?.role }, "Non-platform-admin access attempt");
    return c.json({ error: "forbidden_role", message: "Platform admin role required.", requestId }, 403);
  }

  // Platform admin shares the admin bucket — same interactive-form access
  // pattern (#2485). Cross-tenant operations still rate-limit per identity.
  const blocked = await rateLimitAndIPCheck(c.req.raw, authResult, requestId, "admin");
  if (blocked) {
    return c.json(blocked.body, blocked.status as 429, blocked.headers);
  }

  const misrouted = await checkMisrouting(c, authResult, requestId);
  if (misrouted) {
    return c.json(misrouted.body, misrouted.status as 421);
  }

  c.set("authResult", authResult);
  resolveModeForRequest(c, authResult, requestId);
  setTrustDeviceIdentifier(c);
  await next();
});

// ---------------------------------------------------------------------------
// standardAuth — authenticate + rate limit + IP allowlist (no admin check)
// ---------------------------------------------------------------------------

export const standardAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);

  const auth = await authenticate(c.req.raw, requestId);
  if (!auth.ok) {
    return c.json(auth.body, auth.status as 401, auth.headers);
  }
  const { authResult } = auth;

  const blocked = await rateLimitAndIPCheck(c.req.raw, authResult, requestId);
  if (blocked) {
    return c.json(blocked.body, blocked.status as 429, blocked.headers);
  }

  const misrouted = await checkMisrouting(c, authResult, requestId);
  if (misrouted) {
    return c.json(misrouted.body, misrouted.status as 421);
  }

  c.set("authResult", authResult);
  resolveModeForRequest(c, authResult, requestId);
  setTrustDeviceIdentifier(c);
  await next();
});

// ---------------------------------------------------------------------------
// migrationWriteLock — rejects writes during active region migration
// ---------------------------------------------------------------------------

/**
 * Opt-in middleware that rejects write operations (POST, PUT, PATCH, DELETE)
 * when the workspace is actively being migrated between regions.
 *
 * Apply to routes where writes would cause data loss during migration
 * (chat, conversations). Don't apply to admin routes — admins need to
 * manage the workspace during migration (retry, cancel, configure).
 */
export const migrationWriteLock = createMiddleware<AuthEnv>(async (c, next) => {
  const authResult = c.get("authResult");
  const requestId = c.get("requestId");

  const locked = await checkMigrationWriteLock(c.req.method, authResult, requestId);
  if (locked) {
    return c.json(locked.body, locked.status as 409);
  }

  await next();
});

// ---------------------------------------------------------------------------
// Mode resolution — reads atlas-mode cookie/header, enforces admin gate
// ---------------------------------------------------------------------------

/**
 * Roles that qualify for developer mode access. Derived from ATLAS_ROLES
 * rather than importing ADMIN_ROLES because this file is template-synced
 * to create-atlas — the published @useatlas/types may not have ADMIN_ROLES yet.
 */
const ADMIN_ROLE_SET = new Set(["admin", "owner", "platform_admin"]);

/**
 * Parse the `atlas-mode` cookie from the Cookie header.
 * Returns the raw cookie value, or undefined if not present.
 */
export function parseModeFromCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const [key, ...rest] = pair.split("=");
    if (key.trim() === "atlas-mode") {
      return rest.join("=").trim();
    }
  }
  return undefined;
}

/**
 * Resolve the effective atlas mode for this request.
 *
 * Priority: `atlas-mode` cookie → `X-Atlas-Mode` header → default (`published`).
 * Only admin/owner/platform_admin users may use `developer` mode — non-admin
 * requests always resolve to `published` regardless of cookie/header value.
 *
 * Called inline by adminAuth, standardAuth, and platformAdminAuth.
 * Exported as a pure function for testability.
 */
export function resolveMode(
  cookieHeader: string | null,
  xAtlasModeHeader: string | null,
  authResult: AuthResult & { authenticated: true },
): import("@useatlas/types/auth").AtlasMode {
  const raw = parseModeFromCookie(cookieHeader) ?? xAtlasModeHeader ?? undefined;

  if (raw !== "developer") return "published";

  // Auth mode "none" (local dev) is an implicit admin
  if (authResult.mode === "none") return "developer";

  // Check if user has an admin-level role
  if (authResult.user?.role && ADMIN_ROLE_SET.has(authResult.user.role)) {
    return "developer";
  }

  return "published";
}

/**
 * Surface the parsed cookie identifier on Hono context once, so the audit
 * logger and Effect bridge don't re-parse per call. Always sets the key —
 * `undefined` when absent — so reads are uniform.
 */
function setTrustDeviceIdentifier(c: {
  req: { raw: Request };
  set: (key: string, value: unknown) => void;
}): void {
  const cookieHeader = c.req.raw.headers.get("cookie");
  const identifier = extractTrustDeviceIdentifier(cookieHeader);
  c.set("trustDeviceIdentifier", identifier ?? undefined);
}

/**
 * Resolve mode and log when a developer request is downgraded due to
 * insufficient role. Used by the auth middlewares to centralize the
 * resolve + set + log pattern.
 */
function resolveModeForRequest(
  c: { req: { raw: Request }; set: (key: string, value: unknown) => void },
  authResult: AuthResult & { authenticated: true },
  requestId: string,
): void {
  const cookieHeader = c.req.raw.headers.get("cookie");
  const xAtlasModeHeader = c.req.raw.headers.get("x-atlas-mode");
  const mode = resolveMode(cookieHeader, xAtlasModeHeader, authResult);

  // Log security-relevant downgrade: someone requested developer mode but
  // lacks admin privileges. Could be a stale cookie, frontend bug, or probe.
  const requestedDeveloper =
    parseModeFromCookie(cookieHeader) === "developer" || xAtlasModeHeader === "developer";
  if (requestedDeveloper && mode === "published") {
    log.warn(
      { requestId, userId: authResult.user?.id, role: authResult.user?.role },
      "Developer mode request downgraded to published — insufficient role",
    );
  }

  c.set("atlasMode", mode);
}

// ---------------------------------------------------------------------------
// requestContext — wraps downstream handlers in withRequestContext
// ---------------------------------------------------------------------------

/** Requires adminAuth/standardAuth to run first (reads authResult + requestId). */
export const requestContext = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");
  const atlasMode = c.get("atlasMode");
  const trustDeviceIdentifier = c.get("trustDeviceIdentifier");
  await withRequestContext(
    { requestId, user: authResult.user, atlasMode, trustDeviceIdentifier },
    () => next(),
  );
});

// ---------------------------------------------------------------------------
// withRequestId — lightweight: generates requestId + wraps in withRequestContext
// ---------------------------------------------------------------------------

/**
 * Generates a requestId and wraps downstream in withRequestContext.
 * Does NOT run auth — use when auth is handled inline in the handler
 * (e.g. admin.ts which mixes admin and non-admin routes).
 *
 * The trust-device cookie is parsed here too — it's available pre-auth and
 * having it on the AsyncLocalStorage context from the start means
 * `logAdminAction` picks it up without per-handler ALS mutation. The
 * `adminAuth` family does the same via `setTrustDeviceIdentifier`; this
 * keeps both paths symmetric.
 */
export const withRequestId = createMiddleware<AuthEnv>(async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  const cookieHeader = c.req.raw.headers.get("cookie");
  const trustDeviceIdentifier =
    extractTrustDeviceIdentifier(cookieHeader) ?? undefined;
  c.set("trustDeviceIdentifier", trustDeviceIdentifier);
  await withRequestContext({ requestId, trustDeviceIdentifier }, () => next());
});

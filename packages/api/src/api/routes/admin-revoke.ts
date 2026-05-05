/**
 * Admin force-revoke for user auth artifacts (#2093).
 *
 * `POST /api/v1/admin/users/{id}/revoke-auth` is the single atomic
 * primitive for fired-contractor / compromised-account cleanup. Today
 * the workspace admin has to revoke each auth class independently —
 * `/admin/sessions` covers active web sessions, `/admin/users/:id/ban`
 * blocks future sign-ins, but neither cleans up trusted-device cookies
 * or enrolled passkeys. Without this surface, "off-board the
 * contractor" is a multi-tab forensic exercise where it's easy to
 * leave a passkey behind that can re-authenticate them on a returned
 * device the next time SSO/SAML is used as the first factor.
 *
 * `GET /api/v1/admin/users/{id}/revoke-auth/preview` returns the
 * per-artifact counts so the danger-zone UI can render
 * "5 sessions · 2 trusted browsers · 1 passkey" before the operator
 * confirms. The preview shares the same org-scoping and pre-checks as
 * the POST so a probe against a foreign-workspace user can never leak
 * counts that the revoke itself would refuse.
 *
 * Atomicity matches `admin-oauth-clients.ts:revoke`. The six DELETEs
 * (verification → trusted_device → session → passkey → oauthAccessToken
 * → oauthRefreshToken) run inside a single transaction so a transient
 * pool failure mid-sequence cannot leave a user partially revoked —
 * sessions gone but passkeys still admitting on the next SSO redirect
 * is exactly the failure mode this surface exists to prevent.
 *
 * Order rationale: `verification` rows are FK-reachable from
 * `trusted_device.identifier`, so deleting them first prevents an FK
 * violation if the verification adapter ever upgrades to RESTRICT.
 * Children (per-class artefacts) are independent of each other —
 * order between them is forensic preference, not correctness.
 *
 * Audit metadata carries every per-class count even on a zero-row
 * revoke. A "no-op" revoke is a forensic signal in itself: the admin
 * confirmed the action against a user who had no live credentials.
 *
 * Authorization: workspace admins are scoped to their org members via
 * `verifyOrgMembership`; platform admins cross-org. The non-member
 * branch returns 404 (not 403) so probing a foreign-workspace user
 * surfaces the same response as a missing user — same precedent as
 * the rest of /users/* in admin.ts.
 *
 * Registered directly on the admin router (not as a sub-router) so
 * the existing /users/* routes in admin.ts and the
 * /users/invitations/* routes in admin-invitations.ts share the same
 * middleware chain without sub-router-attached middleware leaking
 * across them. Same rationale as `registerInvitationRoutes`.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { getInternalDB, hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

const log = createLogger("admin-revoke");

// Cap on the `id` route param. Better Auth user ids are 32-char nanoid-ish;
// 255 is well clear of the upper bound and prevents adversarial inputs from
// bloating `admin_action_log.metadata` on the not-found audit branch.
const ID_MAX_LEN = 255;

// Cap on the operator-supplied audit reason. Long enough to record a real
// off-boarding rationale ("Contractor terminated 2026-05-05, badge revoked,
// HR ticket #1234"); short enough to keep `metadata.reason` from balloon-
// ing the JSONB column on a malicious paste. Mirrors the bound used by
// `ReasonDialog` callers elsewhere in the admin surface.
const REASON_MAX_LEN = 500;

/**
 * SQL phase the rolled-back transaction tripped on. Surfaced in the
 * failure-audit metadata so triage can answer "did anything actually
 * delete?" without grep-ing pino. Phases are listed in execution order so
 * a `phase: "passkey"` failure reads as "verifications + trust-devices +
 * sessions deleted, then bail" without consulting the source.
 */
type RevokePhase =
  | "verification"
  | "trusted_device"
  | "session"
  | "passkey"
  | "oauth_access"
  | "oauth_refresh"
  | "commit";

interface RevokeCounts {
  verificationRowsRevoked: number;
  trustedDevicesRevoked: number;
  sessionsRevoked: number;
  passkeysRevoked: number;
  oauthAccessTokensRevoked: number;
  oauthRefreshTokensRevoked: number;
}

type RevokeOutcome =
  | { status: "ok"; counts: RevokeCounts }
  | { status: "rolled_back"; phase: RevokePhase; error: Error };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PreviewResponseSchema = z.object({
  targetUserId: z.string(),
  targetUserEmail: z.string().nullable(),
  sessions: z.number().int().nonnegative(),
  trustedDevices: z.number().int().nonnegative(),
  passkeys: z.number().int().nonnegative(),
  oauthAccessTokens: z.number().int().nonnegative(),
  oauthRefreshTokens: z.number().int().nonnegative(),
});

const RevokeRequestSchema = z.object({
  reason: z.string().max(REASON_MAX_LEN).optional(),
});

const RevokeResponseSchema = z.object({
  success: z.boolean(),
  targetUserId: z.string(),
  sessionsRevoked: z.number().int().nonnegative(),
  trustedDevicesRevoked: z.number().int().nonnegative(),
  passkeysRevoked: z.number().int().nonnegative(),
  oauthAccessTokensRevoked: z.number().int().nonnegative(),
  oauthRefreshTokensRevoked: z.number().int().nonnegative(),
  verificationRowsRevoked: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const previewAuthArtifactsRoute = createRoute({
  method: "get",
  path: "/users/{id}/revoke-auth/preview",
  tags: ["Admin — Users"],
  summary: "Preview auth artifacts for force-revoke",
  description:
    "Returns the per-artifact counts (sessions, trusted devices, passkeys, OAuth access/refresh tokens) " +
    "that `POST /users/{id}/revoke-auth` would delete. Used by the danger-zone UI to surface scope before " +
    "the admin confirms. Workspace admins are scoped to org members; platform admins cross-org.",
  request: {
    params: z.object({
      id: z.string().min(1).max(ID_MAX_LEN).openapi({ param: { name: "id", in: "path" }, example: "user_abc123" }),
    }),
  },
  responses: {
    200: { description: "Auth artefact counts", content: { "application/json": { schema: PreviewResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "User not found or not in workspace", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeAuthArtifactsRoute = createRoute({
  method: "post",
  path: "/users/{id}/revoke-auth",
  tags: ["Admin — Users"],
  summary: "Force-revoke all auth artifacts for a user",
  description:
    "Atomically deletes every active session, trusted-device cookie (and adjacent verification rows), " +
    "passkey, and OAuth access/refresh token for the target user inside a single transaction. The user " +
    "can re-enroll if re-hired; the contractor / compromised-account scenario is the load-bearing case. " +
    "Workspace admins are scoped to their org members; platform admins cross-org.",
  request: {
    params: z.object({
      id: z.string().min(1).max(ID_MAX_LEN).openapi({ param: { name: "id", in: "path" }, example: "user_abc123" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: RevokeRequestSchema,
        },
      },
      required: false,
    },
  },
  responses: {
    200: { description: "Auth artifacts revoked", content: { "application/json": { schema: RevokeResponseSchema } } },
    400: { description: "Invalid request body", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "User not found or not in workspace", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Transactional revoke helper
// ---------------------------------------------------------------------------

/**
 * Atomically revoke every auth artifact for `userId`. All six DELETEs run
 * inside a single transaction; partial-state failures roll back so the
 * user never ends up with a deleted session but a live passkey that
 * still admits on the next SSO redirect.
 *
 * `verification` is deleted first so the trusted-device → verification
 * FK can never block the trust-device DELETE — Better Auth's
 * verification table doesn't define a CASCADE on this relationship and
 * the foreign key is the cookie identifier, not a column we control.
 *
 * Returns a discriminated outcome so the caller can branch on success /
 * rolled-back without exception handling. Mirrors
 * `admin-oauth-clients.ts:revokeAtomically` for the BEGIN/COMMIT/ROLLBACK
 * + `release(rollbackErr)` destroy-on-poison pattern.
 */
async function revokeAtomically(userId: string): Promise<RevokeOutcome> {
  const pool = getInternalDB();
  const client = await pool.connect();
  let phase: RevokePhase = "verification";
  let rollbackErr: Error | null = null;

  try {
    await client.query("BEGIN");

    // Better Auth pairs each trusted-device row with a verification row
    // keyed on the same `identifier`. Deleting the verification rows
    // first means the trust-device DELETE cannot be blocked by an FK
    // upgrade in a future Better Auth release.
    const verification = await client.query(
      `DELETE FROM verification
        WHERE identifier IN (
          SELECT identifier FROM trusted_device WHERE user_id = $1
        )
        RETURNING identifier`,
      [userId],
    );
    phase = "trusted_device";

    const trustedDevice = await client.query(
      `DELETE FROM trusted_device
        WHERE user_id = $1
        RETURNING identifier`,
      [userId],
    );
    phase = "session";

    const session = await client.query(
      `DELETE FROM session
        WHERE "userId" = $1
        RETURNING id`,
      [userId],
    );
    phase = "passkey";

    const passkey = await client.query(
      `DELETE FROM passkey
        WHERE "userId" = $1
        RETURNING id`,
      [userId],
    );
    phase = "oauth_access";

    const oauthAccess = await client.query(
      `DELETE FROM "oauthAccessToken"
        WHERE "userId" = $1
        RETURNING id`,
      [userId],
    );
    phase = "oauth_refresh";

    const oauthRefresh = await client.query(
      `DELETE FROM "oauthRefreshToken"
        WHERE "userId" = $1
        RETURNING id`,
      [userId],
    );

    phase = "commit";
    await client.query("COMMIT");

    return {
      status: "ok",
      counts: {
        verificationRowsRevoked: verification.rows.length,
        trustedDevicesRevoked: trustedDevice.rows.length,
        sessionsRevoked: session.rows.length,
        passkeysRevoked: passkey.rows.length,
        oauthAccessTokensRevoked: oauthAccess.rows.length,
        oauthRefreshTokensRevoked: oauthRefresh.rows.length,
      },
    };
  } catch (err) {
    // ROLLBACK can itself fail (TCP reset between BEGIN and ROLLBACK).
    // pg destroys the socket when `release(err)` is called with a
    // truthy arg, so a poisoned client doesn't return to the pool to
    // corrupt the next borrower's transaction.
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { err: rollbackErr.message, userId, phase },
        "ROLLBACK failed after auth revoke error — client will be destroyed",
      );
    });
    return {
      status: "rolled_back",
      phase,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  } finally {
    client.release(rollbackErr ?? undefined);
  }
}

// ---------------------------------------------------------------------------
// Per-artifact preview counts
// ---------------------------------------------------------------------------

/**
 * Per-class counts for the preview endpoint. Issued in parallel as five
 * independent COUNT(*) queries — there is no shared join key and a UNION
 * would only obscure the per-class results without saving a round-trip.
 *
 * Verification rows are not counted: they're FK-attached to the
 * trusted-device row and the operator-facing UI cares about
 * "trusted browsers", not the underlying Better Auth bookkeeping.
 */
async function loadArtifactCounts(userId: string): Promise<{
  sessions: number;
  trustedDevices: number;
  passkeys: number;
  oauthAccessTokens: number;
  oauthRefreshTokens: number;
}> {
  const [sessions, trustedDevices, passkeys, oauthAccess, oauthRefresh] = await Promise.all([
    internalQuery<{ count: string }>(`SELECT COUNT(*)::text AS count FROM session WHERE "userId" = $1`, [userId]),
    internalQuery<{ count: string }>(`SELECT COUNT(*)::text AS count FROM trusted_device WHERE user_id = $1`, [userId]),
    internalQuery<{ count: string }>(`SELECT COUNT(*)::text AS count FROM passkey WHERE "userId" = $1`, [userId]),
    internalQuery<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "oauthAccessToken" WHERE "userId" = $1`, [userId]),
    internalQuery<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "oauthRefreshToken" WHERE "userId" = $1`, [userId]),
  ]);
  return {
    sessions: parseInt(String(sessions[0]?.count ?? "0"), 10),
    trustedDevices: parseInt(String(trustedDevices[0]?.count ?? "0"), 10),
    passkeys: parseInt(String(passkeys[0]?.count ?? "0"), 10),
    oauthAccessTokens: parseInt(String(oauthAccess[0]?.count ?? "0"), 10),
    oauthRefreshTokens: parseInt(String(oauthRefresh[0]?.count ?? "0"), 10),
  };
}

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Auth result the registered helpers receive. Matches the return shape of
 * admin.ts' `adminAuthAndContext` (the `requireAdminAuth` precondition has
 * already pinned `authenticated: true` by the time the handler body runs)
 * so the caller can pass admin.ts' module-private `verifyOrgMembership`
 * straight through without an unsafe cast.
 */
type AuthenticatedResult = AuthResult & { authenticated: true };

/**
 * Register the force-revoke routes directly on the admin router.
 * Same dependency-injection pattern as `registerInvitationRoutes` —
 * `adminAuthAndContext` and `verifyOrgMembership` live inside admin.ts'
 * module closure, so we accept them as params instead of cyclically
 * importing.
 */
export function registerRevokeRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic admin router type
  admin: OpenAPIHono<any>,
  adminAuthAndContext: (
    c: { req: { raw: Request }; get(key: string): unknown; set?: (key: string, value: unknown) => void },
    permission?: import("@atlas/ee/auth/roles").Permission,
  ) => Promise<{ authResult: AuthenticatedResult; requestId: string }>,
  verifyOrgMembership: (authResult: AuthenticatedResult, targetUserId: string) => Promise<boolean>,
) {
  // GET /users/:id/revoke-auth/preview — per-artifact counts for the danger-zone UI.
  admin.openapi(previewAuthArtifactsRoute, async (c) => runHandler(c, "preview user auth artifacts", async () => {
    const { id: userId } = c.req.valid("param");
    const { authResult, requestId } = await adminAuthAndContext(c, "admin:users");

    if (!hasInternalDB() || detectAuthMode() !== "managed") {
      return c.json(
        { error: "not_available", message: "User auth management requires managed auth mode.", requestId },
        404,
      );
    }

    if (!(await verifyOrgMembership(authResult, userId))) {
      return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
    }

    const userRows = await internalQuery<{ id: string; email: string | null }>(
      `SELECT id, email FROM "user" WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (userRows.length === 0) {
      return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
    }

    const counts = await loadArtifactCounts(userId);
    return c.json(
      {
        targetUserId: userId,
        targetUserEmail: userRows[0]?.email ?? null,
        sessions: counts.sessions,
        trustedDevices: counts.trustedDevices,
        passkeys: counts.passkeys,
        oauthAccessTokens: counts.oauthAccessTokens,
        oauthRefreshTokens: counts.oauthRefreshTokens,
      },
      200,
    );
  }));

  // POST /users/:id/revoke-auth — atomic revoke of every auth artifact.
  admin.openapi(revokeAuthArtifactsRoute, async (c) => runHandler(c, "revoke user auth artifacts", async () => {
    const { id: userId } = c.req.valid("param");
    const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
    const { authResult, requestId } = await adminAuthAndContext(c, "admin:users");

    if (!hasInternalDB() || detectAuthMode() !== "managed") {
      return c.json(
        { error: "not_available", message: "User auth management requires managed auth mode.", requestId },
        404,
      );
    }

    if (!(await verifyOrgMembership(authResult, userId))) {
      // Probing a foreign-workspace user is a forensic signal — record
      // the attempt with `found: false` so the audit trail can show
      // which admin tried to reach across orgs.
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.authRevoke,
        targetType: "user",
        targetId: userId,
        ipAddress,
        metadata: { targetUserId: userId, found: false },
      });
      return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
    }

    // The body schema is optional — operators using ReasonDialog with
    // `required: false` may submit no JSON body at all. `c.req.valid`
    // would throw on an absent body when the route declares one as
    // optional, so parse manually with a safe default. Untrusted-shape
    // bodies are rejected (400) rather than silently dropping the
    // reason and continuing.
    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = RevokeRequestSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: "Invalid request body.", requestId }, 400);
    }
    const reason = parsed.data.reason?.trim() ? parsed.data.reason.trim() : undefined;

    // Pre-fetch the email for the audit row before the DELETEs strip
    // every artifact pointer. The session table already JOINs `user`
    // via userId, but we want the audit row to record who was revoked
    // even if the user later gets erased.
    const userRows = await internalQuery<{ id: string; email: string | null }>(
      `SELECT id, email FROM "user" WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (userRows.length === 0) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.authRevoke,
        targetType: "user",
        targetId: userId,
        ipAddress,
        metadata: { targetUserId: userId, found: false },
      });
      return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
    }
    const targetUserEmail = userRows[0]?.email ?? null;

    const outcome = await revokeAtomically(userId);

    if (outcome.status === "rolled_back") {
      // Transaction rolled back. Audit with the phase that tripped + the
      // scrubbed error message (errorMessage strips pg userinfo and caps
      // length), then re-fail through runHandler so the response surfaces
      // a 500 with requestId.
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.authRevoke,
        targetType: "user",
        targetId: userId,
        status: "failure",
        ipAddress,
        metadata: {
          targetUserId: userId,
          targetUserEmail,
          phase: outcome.phase,
          error: errorMessage(outcome.error),
          ...(reason !== undefined && { reason }),
        },
      });
      throw outcome.error;
    }

    log.info(
      {
        requestId,
        targetUserId: userId,
        actorId: authResult.user?.id,
        ...outcome.counts,
      },
      "User auth artifacts revoked",
    );
    logAdminAction({
      actionType: ADMIN_ACTIONS.user.authRevoke,
      targetType: "user",
      targetId: userId,
      ipAddress,
      metadata: {
        targetUserId: userId,
        targetUserEmail,
        ...outcome.counts,
        ...(reason !== undefined && { reason }),
      },
    });

    return c.json(
      {
        success: true,
        targetUserId: userId,
        ...outcome.counts,
      },
      200,
    );
  }));
}

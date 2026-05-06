/**
 * Wave 2B passkey-recovery surface (#2092):
 *
 *   - `POST /api/v1/admin/users/{id}/reset-mfa` — admin-mediated reset
 *     for a locked-out user (the load-bearing primitive of this file).
 *   - `GET  /api/v1/admin/me/mfa-factors`       — per-user factor snapshot
 *     consumed by the `BackupMethodBanner` on `/admin/settings/security`
 *     to compute the lockout-risk predicate (one passkey, no password,
 *     no TOTP). Light auth, no `mfaRequired` gate — by definition the
 *     banner has to render before the user has a backup method.
 *
 * Atomic primitive for "this user lost their only authenticator and is
 * locked out". Sibling to #2093's `admin-revoke.ts`: same transactional
 * shape, same workspace-vs-platform authz split, same `<ReasonDialog>` UI
 * contract — narrower scope. The reset surface only clears second-factor
 * artifacts so the user can re-enroll on next sign-in. Sessions, OAuth
 * grants, and trust-device cookies are deliberately left in place: the
 * goal is recovery, not off-boarding.
 *
 * Re-enrollment is forced by removing every credential the
 * `mfaRequired` middleware accepts:
 *   1. Every passkey row for the user
 *   2. Every `twoFactor` row (TOTP secret + backup-code batch are bundled
 *      together in Better Auth's plugin schema — one row per enrollment)
 *   3. `user.twoFactorEnabled = false` so the gate doesn't see a stale
 *      `claims.twoFactorEnabled = true` for an admin who has no actual
 *      backing twoFactor row
 *
 * No new column is needed. The existing `mfaRequired` middleware in
 * `admin-mfa-required.ts` already returns `mfa_enrollment_required` to
 * any admin/owner/platform_admin session whose claims show neither TOTP
 * nor a passkey — emptying both rows trips that gate on the next
 * admin-router request.
 *
 * Workspace admins are scoped to org members via `verifyOrgMembership`;
 * platform admins cross-org. The non-member branch returns 404 (not 403)
 * so probing a foreign-workspace user surfaces the same response as a
 * missing user.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { getInternalDB, hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { authenticateRequest } from "@atlas/api/lib/auth/middleware";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import type { AuthenticatedResult } from "@atlas/api/lib/auth/types";
import { authErrorCode } from "./admin-auth";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

const log = createLogger("admin-mfa-reset");

// Cap on the `id` route param. Better Auth user ids are 32-char nanoid-ish;
// 255 is well clear of the upper bound and prevents adversarial inputs
// from bloating `admin_action_log.metadata` on the not-found audit branch.
const ID_MAX_LEN = 255;

// Cap on the operator-supplied audit reason. Long enough for a real
// recovery rationale ("user reports stolen laptop, cross-checked with
// HR ticket TKT-1234"); short enough that a malicious paste can't
// balloon `admin_action_log.metadata`'s JSONB column.
const REASON_MAX_LEN = 500;

/**
 * SQL phase the rolled-back transaction tripped on. Surfaced in the
 * failure-audit metadata so triage can answer "did anything actually
 * delete?" without grep-ing pino. Phases are listed in execution order
 * so a `phase: "two_factor"` reads as "passkeys deleted, then bail".
 */
type ResetPhase = "passkey" | "two_factor" | "user_flag" | "commit";

interface ResetCounts {
  passkeysRevoked: number;
  totpSecretsRevoked: number;
  backupCodeBatchesRevoked: number;
}

type ResetOutcome =
  | { status: "ok"; counts: ResetCounts }
  | { status: "rolled_back"; phase: ResetPhase; error: Error };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ResetRequestSchema = z.object({
  reason: z.string().max(REASON_MAX_LEN).optional(),
});

const ResetResponseSchema = z.object({
  success: z.boolean(),
  targetUserId: z.string(),
  passkeysRevoked: z.number().int().nonnegative(),
  totpSecretsRevoked: z.number().int().nonnegative(),
  backupCodeBatchesRevoked: z.number().int().nonnegative(),
});

const MyMfaFactorsResponseSchema = z.object({
  hasPassword: z.boolean(),
  hasTotp: z.boolean(),
  passkeyCount: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const myMfaFactorsRoute = createRoute({
  method: "get",
  path: "/me/mfa-factors",
  tags: ["Admin — Security"],
  summary: "Per-user MFA factor snapshot",
  description:
    "Returns the calling user's password / TOTP / passkey-count snapshot " +
    "used by the BackupMethodBanner on /admin/settings/security to detect " +
    "the lockout-risk profile (one passkey, no password, no TOTP). Light " +
    "auth — by definition the banner has to render before the user has a " +
    "second factor enrolled.",
  responses: {
    200: { description: "Factor snapshot", content: { "application/json": { schema: MyMfaFactorsResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — SSO enforcement active", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const resetMfaRoute = createRoute({
  method: "post",
  path: "/users/{id}/reset-mfa",
  tags: ["Admin — Users"],
  summary: "Reset MFA enrollment for a user",
  description:
    "Atomically clears every second-factor artifact (passkey enrollments, " +
    "TOTP secrets, bundled backup-code batches) for the target user inside " +
    "a single transaction so a locked-out passkey-only user can re-enroll " +
    "on next sign-in. Sessions, OAuth grants, and trust-device cookies are " +
    "left untouched — this is recovery, not off-boarding (#2093 covers " +
    "off-boarding). Workspace admins are scoped to their org members; " +
    "platform admins cross-org.",
  request: {
    params: z.object({
      id: z.string().min(1).max(ID_MAX_LEN).openapi({ param: { name: "id", in: "path" }, example: "user_abc123" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: ResetRequestSchema,
        },
      },
      required: false,
    },
  },
  responses: {
    200: { description: "MFA artifacts reset", content: { "application/json": { schema: ResetResponseSchema } } },
    400: { description: "Invalid request body", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "User not found or not in workspace", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: AuthErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Transactional reset helper
// ---------------------------------------------------------------------------

/**
 * Atomically clear every second-factor artifact for `userId`. All three
 * mutating queries run inside a single transaction; partial-state failures
 * roll back so the user never ends up with passkeys deleted but
 * `twoFactorEnabled = true` lingering on the user row (the gate would
 * admit them silently).
 *
 * Returns a discriminated outcome so the caller can branch on success /
 * rolled-back without exception handling. Mirrors `admin-revoke.ts`'s
 * BEGIN/COMMIT/ROLLBACK + `release(rollbackErr)` destroy-on-poison
 * pattern verbatim — pg destroys the socket when `release(err)` is called
 * with a truthy arg, so a poisoned client doesn't return to the pool to
 * corrupt the next borrower's transaction.
 */
async function resetAtomically(userId: string): Promise<ResetOutcome> {
  const pool = getInternalDB();
  const client = await pool.connect();
  let phase: ResetPhase = "passkey";
  let rollbackErr: Error | null = null;

  try {
    await client.query("BEGIN");

    const passkey = await client.query(
      `DELETE FROM passkey
        WHERE "userId" = $1
        RETURNING id`,
      [userId],
    );
    phase = "two_factor";

    // Better Auth's twoFactor plugin stores the TOTP secret and the
    // backup-code batch in the same row — `secret` and `backupCodes`
    // are sibling columns. Counting `had_backup_codes` separately lets
    // the audit row distinguish "this user had codes" (a meaningful
    // recovery fact) from "TOTP secret only" — without a per-row
    // RETURNING the audit log would conflate the two.
    const twoFactor = await client.query(
      `DELETE FROM "twoFactor"
        WHERE "userId" = $1
        RETURNING id, ("backupCodes" IS NOT NULL AND "backupCodes" <> '') AS had_backup_codes`,
      [userId],
    );
    phase = "user_flag";

    // Even with no twoFactor row to delete, `user.twoFactorEnabled`
    // can still be `true` for accounts that enrolled and then dropped
    // their TOTP via Better Auth's disable path on a non-Atlas client
    // (rare, but possible). Clearing it unconditionally is cheap and
    // closes the silent-admit gap described in the file header.
    await client.query(
      `UPDATE "user"
          SET "twoFactorEnabled" = false
        WHERE id = $1`,
      [userId],
    );

    phase = "commit";
    await client.query("COMMIT");

    const backupCodeBatchesRevoked = twoFactor.rows.filter(
      (r) => (r as { had_backup_codes?: boolean }).had_backup_codes === true,
    ).length;

    return {
      status: "ok",
      counts: {
        passkeysRevoked: passkey.rows.length,
        totpSecretsRevoked: twoFactor.rows.length,
        backupCodeBatchesRevoked,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        { err: rollbackErr.message, userId, phase },
        "ROLLBACK failed after MFA reset error — client will be destroyed",
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
// Registration function
// ---------------------------------------------------------------------------

/**
 * Register the MFA-reset route directly on the admin router.
 * Same dependency-injection pattern as `registerRevokeRoutes` —
 * `adminAuthAndContext` and `verifyOrgMembership` live inside
 * admin.ts' module closure, so we accept them as params instead of
 * cyclically importing.
 */
export function registerMfaResetRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic admin router type
  admin: OpenAPIHono<any>,
  adminAuthAndContext: (
    c: { req: { raw: Request }; get(key: string): unknown; set?: (key: string, value: unknown) => void },
    permission?: import("@atlas/ee/auth/roles").Permission,
  ) => Promise<{ authResult: AuthenticatedResult; requestId: string }>,
  verifyOrgMembership: (authResult: AuthenticatedResult, targetUserId: string) => Promise<boolean>,
  reqId: (c: { get(key: string): unknown }) => string,
) {
  // GET /me/mfa-factors — per-user factor snapshot for the BackupMethodBanner.
  // Light auth path: same carve-out rationale as /me/password-status — the
  // banner is the surface that NUDGES the user toward a second factor, so it
  // has to be reachable before any factor is enrolled. mfaRequired stays off.
  admin.openapi(myMfaFactorsRoute, async (c) => {
    const req = c.req.raw;
    const requestId = reqId(c);

    let authResult: Awaited<ReturnType<typeof authenticateRequest>>;
    try {
      authResult = await authenticateRequest(req);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), requestId },
        "Authentication system error in mfa-factors check",
      );
      return c.json({ error: "auth_error", message: "Authentication system error", requestId }, 500);
    }
    if (!authResult.authenticated) {
      const code = authErrorCode(authResult.error);
      return c.json({ error: code, message: authResult.error, requestId }, authResult.status);
    }
    const user = authResult.user;
    // Non-managed sessions don't have a Better Auth-backed user record to
    // bucket — return a "no-risk" snapshot so the banner renders nothing
    // rather than 500-ing a self-hosted simple-key admin.
    if (authResult.mode !== "managed" || !user || !hasInternalDB()) {
      return c.json({ hasPassword: false, hasTotp: false, passkeyCount: 0 }, 200);
    }

    try {
      // Single round-trip: three EXISTS / scalar reads. The `account` JOIN
      // matches the credential-presence check in lib/auth/migrate.ts —
      // `providerId = 'credential'` is Better Auth's marker for a
      // password-backed account. SSO / OAuth-only accounts will land
      // `hasPassword = false`, which is the signal the banner needs.
      const rows = await internalQuery<{
        has_password: boolean;
        has_totp: boolean;
        passkey_count: number;
      }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM "account"
              WHERE "userId" = $1 AND "providerId" = 'credential'
           ) AS has_password,
           COALESCE((SELECT "twoFactorEnabled" FROM "user" WHERE id = $1), false) AS has_totp,
           (SELECT COUNT(*)::int FROM passkey WHERE "userId" = $1) AS passkey_count`,
        [user.id],
      );
      const row = rows[0];
      return c.json(
        {
          hasPassword: row?.has_password === true,
          hasTotp: row?.has_totp === true,
          passkeyCount: typeof row?.passkey_count === "number" ? row.passkey_count : 0,
        },
        200,
      );
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          userId: user.id,
          requestId,
        },
        "Failed to load /me/mfa-factors snapshot",
      );
      return c.json(
        {
          error: "internal_error",
          message: "Could not load your MFA status. Please refresh and try again.",
          requestId,
        },
        500,
      );
    }
  });

  admin.openapi(resetMfaRoute, async (c) => runHandler(c, "reset user mfa", async () => {
    const { id: userId } = c.req.valid("param");
    const ipAddress = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
    const { authResult, requestId } = await adminAuthAndContext(c, "admin:users");

    if (!hasInternalDB() || detectAuthMode() !== "managed") {
      return c.json(
        { error: "not_available", message: "MFA reset requires managed auth mode.", requestId },
        404,
      );
    }

    if (!(await verifyOrgMembership(authResult, userId))) {
      // Probing a foreign-workspace user is a forensic signal — record
      // the attempt with `found: false` so the audit trail can show
      // which admin tried to reach across orgs.
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.mfaReset,
        targetType: "user",
        targetId: userId,
        ipAddress,
        metadata: { targetUserId: userId, found: false },
      });
      return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
    }

    // Body schema is optional — operators using ReasonDialog with
    // `required: false` may submit no JSON body. Parse manually with a
    // safe default; safeParse rejects malformed shapes with 400.
    const rawBody = await c.req.json().catch(() => {
      // intentionally ignored: optional body — safeParse below validates the shape.
      return {};
    });
    const parsed = ResetRequestSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: "Invalid request body.", requestId }, 400);
    }
    const reason = parsed.data.reason?.trim() || undefined;

    // Pre-fetch the email for the audit row before the DELETEs strip
    // every artifact pointer. We want the audit row to record who was
    // reset even if the user later gets erased.
    const userRows = await internalQuery<{ id: string; email: string | null }>(
      `SELECT id, email FROM "user" WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (userRows.length === 0) {
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.mfaReset,
        targetType: "user",
        targetId: userId,
        ipAddress,
        metadata: { targetUserId: userId, found: false },
      });
      return c.json({ error: "not_found", message: "User not found.", requestId }, 404);
    }
    const targetUserEmail = userRows[0]?.email ?? null;

    const outcome = await resetAtomically(userId);

    if (outcome.status === "rolled_back") {
      // Transaction rolled back. Audit with the phase that tripped + the
      // scrubbed error message (errorMessage strips pg userinfo and caps
      // length), then re-fail through runHandler so the response surfaces
      // a 500 with requestId.
      logAdminAction({
        actionType: ADMIN_ACTIONS.user.mfaReset,
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
      "User MFA reset",
    );
    logAdminAction({
      actionType: ADMIN_ACTIONS.user.mfaReset,
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

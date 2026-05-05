/**
 * Admin security adoption telemetry — `/api/v1/admin/security/metrics`.
 *
 * Issue #2094 — closes the observability gap for the multi-method MFA
 * stack shipped by #2082 / #2088 / #2089. Without these counters a
 * workspace admin cannot answer "do my admins actually have MFA?" or
 * "is the trust-device cookie sticky?" without writing SQL by hand.
 *
 * **Single read-only aggregate** — one parameterized SELECT (with CTEs)
 * over the internal DB, scoped to the caller's active organization.
 * Buckets workspace admins by enrolled second-factor profile and counts
 * active trust-device grants among the same admin set. The query is
 * intentionally cheap: no per-request fan-out, no joins outside the
 * Better Auth tables we already maintain.
 *
 * Bucket semantics:
 *
 *   none           — admin has neither TOTP nor a passkey
 *   twoFactorOnly  — admin has TOTP, no passkey
 *   passkeyOnly    — admin has at least one passkey, no TOTP
 *   bothFactors    — admin has both TOTP and at least one passkey
 *
 * `none + twoFactorOnly + passkeyOnly + bothFactors === adminCount`.
 *
 * Trust-device counts are scoped to admin/owner members of the workspace
 * — surfacing platform-wide trust grants here would be a tenant leak.
 * `trustDeviceUsersInLast30Days` is "distinct admins with at least one
 * unexpired trust grant" because the trust window IS 30 days
 * (`trustDeviceMaxAge: 30 * 24 * 60 * 60` in `auth/server.ts`); an
 * "active" trust grant is by construction <= 30 days old.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-security-metrics");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SecurityMetricsSchema = z.object({
  adminCount: z.number().int().min(0),
  mfaEnrolled: z.number().int().min(0),
  twoFactorOnly: z.number().int().min(0),
  passkeyOnly: z.number().int().min(0),
  bothFactors: z.number().int().min(0),
  noFactors: z.number().int().min(0),
  activeTrustDevices: z.number().int().min(0),
  trustDeviceUsersInLast30Days: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const getMetricsRoute = createRoute({
  method: "get",
  path: "/metrics",
  tags: ["Admin — Security"],
  summary: "Workspace MFA + trust-device adoption",
  description:
    "Returns an aggregate count of admin-role users in the active workspace " +
    "bucketed by enrolled second-factor profile, plus active trust-device " +
    "grants. Read-only, single SELECT, scoped to the caller's organization.",
  responses: {
    200: {
      description: "Workspace security metrics",
      content: { "application/json": { schema: SecurityMetricsSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — internal DB not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminSecurityMetrics = createAdminRouter();
adminSecurityMetrics.use(requireOrgContext());

interface MetricsRow {
  admin_count: number;
  mfa_enrolled: number;
  two_factor_only: number;
  passkey_only: number;
  both_factors: number;
  no_factors: number;
  active_trust_devices: number;
  trust_device_users: number;
  [key: string]: unknown;
}

adminSecurityMetrics.openapi(getMetricsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId, orgId } = c.get("orgContext");

    if (!hasInternalDB()) {
      return c.json(
        { error: "not_available", message: "Security metrics require an internal database.", requestId },
        404,
      );
    }

    // Single SELECT, two CTEs, no DML. The trust-device CTE filters by
    // membership so cross-tenant grants never bleed into the workspace
    // counters — `verification.value` carries the userId Better Auth
    // wrote when the user opted in (see `me-trusted-devices.ts`).
    const rows = yield* Effect.tryPromise({
      try: () =>
        internalQuery<MetricsRow>(
          `WITH workspace_admins AS (
             SELECT
               u.id AS user_id,
               COALESCE(u."twoFactorEnabled", false) AS has_totp,
               EXISTS (
                 SELECT 1 FROM passkey p WHERE p."userId" = u.id
               ) AS has_passkey
             FROM member m
             JOIN "user" u ON u.id = m."userId"
             WHERE m."organizationId" = $1
               AND m.role IN ('admin', 'owner')
           ),
           trust_grants AS (
             SELECT v.value AS user_id
             FROM verification v
             JOIN member m ON m."userId" = v.value
             WHERE m."organizationId" = $1
               AND v.identifier LIKE 'trust-device-%'
               AND v."expiresAt" > NOW()
           )
           SELECT
             COUNT(*)::int AS admin_count,
             COUNT(*) FILTER (WHERE has_totp OR has_passkey)::int AS mfa_enrolled,
             COUNT(*) FILTER (WHERE has_totp AND NOT has_passkey)::int AS two_factor_only,
             COUNT(*) FILTER (WHERE NOT has_totp AND has_passkey)::int AS passkey_only,
             COUNT(*) FILTER (WHERE has_totp AND has_passkey)::int AS both_factors,
             COUNT(*) FILTER (WHERE NOT has_totp AND NOT has_passkey)::int AS no_factors,
             (SELECT COUNT(*)::int FROM trust_grants) AS active_trust_devices,
             (SELECT COUNT(DISTINCT user_id)::int FROM trust_grants) AS trust_device_users
           FROM workspace_admins`,
          [orgId],
        ),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    const row = rows[0];
    if (!row) {
      // Aggregate queries always return a row, but defend against shape
      // drift — a missing row would otherwise surface as a misleading
      // `undefined.admin_count` 500 with no requestId trail.
      log.error({ orgId, requestId }, "Security metrics aggregate returned no row");
      return c.json(
        { error: "internal_error", message: "Could not load security metrics.", requestId },
        500,
      );
    }

    return c.json(
      {
        adminCount: row.admin_count,
        mfaEnrolled: row.mfa_enrolled,
        twoFactorOnly: row.two_factor_only,
        passkeyOnly: row.passkey_only,
        bothFactors: row.both_factors,
        noFactors: row.no_factors,
        activeTrustDevices: row.active_trust_devices,
        trustDeviceUsersInLast30Days: row.trust_device_users,
      },
      200,
    );
  }), { label: "get workspace security metrics" });
});

export { adminSecurityMetrics };

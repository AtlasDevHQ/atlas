/**
 * Platform security adoption telemetry — `/api/v1/platform/security/metrics`.
 *
 * Cross-tenant counterpart to `admin-security-metrics.ts`. Issue #2094 —
 * platform admins running app.useatlas.dev need a workspace-by-workspace
 * view of MFA + passkey + trust-device adoption to make product calls
 * (e.g. "75% of workspaces have at least one passkey enrolled — promote
 * it to non-admin users").
 *
 * Returns two payloads from the same endpoint:
 *
 *   - `aggregate` — single SELECT bucketing every admin/owner-role
 *     member across every workspace. Same shape as the workspace
 *     endpoint so the platform dashboard can re-use the workspace
 *     traffic-light tile component.
 *   - `workspaces` — single SELECT producing one row per workspace
 *     with the same per-workspace bucket counts. Used to render the
 *     adoption table on the platform dashboard.
 *
 * Both queries are read-only single-statement SELECTs. The trust-device
 * counts are scoped to the same admin set, NOT all users — a
 * cross-tenant "active trust grants on the platform" number would
 * include trust grants for non-admin users on workspaces the platform
 * admin didn't ask about, which is noisier than useful.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("platform-security-metrics");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SecurityBucketsSchema = z.object({
  adminCount: z.number().int().min(0),
  mfaEnrolled: z.number().int().min(0),
  twoFactorOnly: z.number().int().min(0),
  passkeyOnly: z.number().int().min(0),
  bothFactors: z.number().int().min(0),
  noFactors: z.number().int().min(0),
  activeTrustDevices: z.number().int().min(0),
  trustDeviceUsersInLast30Days: z.number().int().min(0),
});

const WorkspaceMetricsSchema = SecurityBucketsSchema.extend({
  workspaceId: z.string(),
  workspaceName: z.string(),
  workspaceSlug: z.string().nullable(),
});

const PlatformMetricsResponseSchema = z.object({
  aggregate: SecurityBucketsSchema,
  workspaces: z.array(WorkspaceMetricsSchema),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const getPlatformMetricsRoute = createRoute({
  method: "get",
  path: "/metrics",
  tags: ["Platform — Security"],
  summary: "Cross-workspace MFA + trust-device adoption",
  description:
    "Returns the same aggregate buckets as the workspace endpoint, but " +
    "summed across every workspace, plus a per-workspace breakdown for " +
    "the platform-admin dashboard. Read-only SELECTs.",
  responses: {
    200: {
      description: "Platform security metrics",
      content: { "application/json": { schema: PlatformMetricsResponseSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — platform admin role required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not available — internal DB not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const platformSecurityMetrics = createPlatformRouter();

interface AggregateRow {
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

interface WorkspaceRow extends AggregateRow {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string | null;
}

function emptyAggregate(): AggregateRow {
  return {
    admin_count: 0,
    mfa_enrolled: 0,
    two_factor_only: 0,
    passkey_only: 0,
    both_factors: 0,
    no_factors: 0,
    active_trust_devices: 0,
    trust_device_users: 0,
  };
}

function bucketsFromRow(row: AggregateRow): z.infer<typeof SecurityBucketsSchema> {
  return {
    adminCount: row.admin_count,
    mfaEnrolled: row.mfa_enrolled,
    twoFactorOnly: row.two_factor_only,
    passkeyOnly: row.passkey_only,
    bothFactors: row.both_factors,
    noFactors: row.no_factors,
    activeTrustDevices: row.active_trust_devices,
    trustDeviceUsersInLast30Days: row.trust_device_users,
  };
}

platformSecurityMetrics.openapi(getPlatformMetricsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;

    if (!hasInternalDB()) {
      return c.json(
        { error: "not_available", message: "Security metrics require an internal database.", requestId },
        404,
      );
    }

    // Two parallel SELECTs:
    //   1. Cross-workspace aggregate — same bucketing as the workspace
    //      endpoint, but no organization filter. A user who is admin in
    //      multiple workspaces is counted once per workspace because the
    //      bucket is "this admin role in this workspace", which is what
    //      drives product decisions like "promote passkeys to admins
    //      who only have TOTP".
    //   2. Per-workspace breakdown — one row per workspace including
    //      empty workspaces (LEFT JOIN against organization). Suspended
    //      / soft-deleted workspaces are filtered out — they aren't
    //      taking new logins, so their counters would be misleading
    //      noise on the dashboard.
    const [aggregateRows, workspaceRows] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          internalQuery<AggregateRow>(
            `WITH platform_admins AS (
               SELECT
                 m."organizationId" AS org_id,
                 u.id AS user_id,
                 COALESCE(u."twoFactorEnabled", false) AS has_totp,
                 EXISTS (
                   SELECT 1 FROM passkey p WHERE p."userId" = u.id
                 ) AS has_passkey
               FROM member m
               JOIN "user" u ON u.id = m."userId"
               JOIN organization o ON o.id = m."organizationId"
               WHERE m.role IN ('admin', 'owner')
                 AND o.deleted_at IS NULL
                 AND o.suspended_at IS NULL
             ),
             trust_grants AS (
               SELECT v.value AS user_id, m."organizationId" AS org_id
               FROM verification v
               JOIN member m ON m."userId" = v.value
               JOIN organization o ON o.id = m."organizationId"
               WHERE m.role IN ('admin', 'owner')
                 AND v.identifier LIKE 'trust-device-%'
                 AND v."expiresAt" > NOW()
                 AND o.deleted_at IS NULL
                 AND o.suspended_at IS NULL
             )
             SELECT
               COUNT(*)::int AS admin_count,
               COUNT(*) FILTER (WHERE has_totp OR has_passkey)::int AS mfa_enrolled,
               COUNT(*) FILTER (WHERE has_totp AND NOT has_passkey)::int AS two_factor_only,
               COUNT(*) FILTER (WHERE NOT has_totp AND has_passkey)::int AS passkey_only,
               COUNT(*) FILTER (WHERE has_totp AND has_passkey)::int AS both_factors,
               COUNT(*) FILTER (WHERE NOT has_totp AND NOT has_passkey)::int AS no_factors,
               (SELECT COUNT(*)::int FROM trust_grants) AS active_trust_devices,
               (SELECT COUNT(DISTINCT (org_id, user_id))::int FROM trust_grants) AS trust_device_users
             FROM platform_admins`,
            [],
          ),
          internalQuery<WorkspaceRow>(
            `WITH workspace_admins AS (
               SELECT
                 m."organizationId" AS org_id,
                 u.id AS user_id,
                 COALESCE(u."twoFactorEnabled", false) AS has_totp,
                 EXISTS (
                   SELECT 1 FROM passkey p WHERE p."userId" = u.id
                 ) AS has_passkey
               FROM member m
               JOIN "user" u ON u.id = m."userId"
               WHERE m.role IN ('admin', 'owner')
             ),
             trust_grants AS (
               SELECT v.value AS user_id, m."organizationId" AS org_id
               FROM verification v
               JOIN member m ON m."userId" = v.value
               WHERE m.role IN ('admin', 'owner')
                 AND v.identifier LIKE 'trust-device-%'
                 AND v."expiresAt" > NOW()
             ),
             org_buckets AS (
               SELECT
                 wa.org_id,
                 COUNT(*)::int AS admin_count,
                 COUNT(*) FILTER (WHERE has_totp OR has_passkey)::int AS mfa_enrolled,
                 COUNT(*) FILTER (WHERE has_totp AND NOT has_passkey)::int AS two_factor_only,
                 COUNT(*) FILTER (WHERE NOT has_totp AND has_passkey)::int AS passkey_only,
                 COUNT(*) FILTER (WHERE has_totp AND has_passkey)::int AS both_factors,
                 COUNT(*) FILTER (WHERE NOT has_totp AND NOT has_passkey)::int AS no_factors
               FROM workspace_admins wa
               GROUP BY wa.org_id
             ),
             org_trust AS (
               SELECT
                 tg.org_id,
                 COUNT(*)::int AS active_trust_devices,
                 COUNT(DISTINCT tg.user_id)::int AS trust_device_users
               FROM trust_grants tg
               GROUP BY tg.org_id
             )
             SELECT
               o.id AS workspace_id,
               o.name AS workspace_name,
               o.slug AS workspace_slug,
               COALESCE(b.admin_count, 0) AS admin_count,
               COALESCE(b.mfa_enrolled, 0) AS mfa_enrolled,
               COALESCE(b.two_factor_only, 0) AS two_factor_only,
               COALESCE(b.passkey_only, 0) AS passkey_only,
               COALESCE(b.both_factors, 0) AS both_factors,
               COALESCE(b.no_factors, 0) AS no_factors,
               COALESCE(t.active_trust_devices, 0) AS active_trust_devices,
               COALESCE(t.trust_device_users, 0) AS trust_device_users
             FROM organization o
             LEFT JOIN org_buckets b ON b.org_id = o.id
             LEFT JOIN org_trust t ON t.org_id = o.id
             WHERE o.deleted_at IS NULL
               AND o.suspended_at IS NULL
             ORDER BY COALESCE(b.admin_count, 0) DESC, o.name ASC`,
            [],
          ),
        ]),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    const aggregateRow = aggregateRows[0] ?? emptyAggregate();
    if (!aggregateRows[0]) {
      // Same defensive branch as the workspace endpoint — aggregates
      // always return a row, but a missing row should be a logged
      // anomaly rather than a NaN-laden response.
      log.warn({ requestId }, "Platform security aggregate returned no row — treating as zero");
    }

    return c.json(
      {
        aggregate: bucketsFromRow(aggregateRow),
        workspaces: workspaceRows.map((r) => ({
          workspaceId: r.workspace_id,
          workspaceName: r.workspace_name,
          workspaceSlug: r.workspace_slug,
          ...bucketsFromRow(r),
        })),
      },
      200,
    );
  }), { label: "get platform security metrics" });
});

export { platformSecurityMetrics };

/**
 * Platform security adoption telemetry — `/api/v1/platform/admin/security/metrics`.
 *
 * Cross-tenant counterpart to `admin-security-metrics.ts`. Platform admins
 * running app.useatlas.dev need a workspace-by-workspace view of MFA +
 * passkey + trust-device adoption to make product calls (e.g. "75% of
 * workspaces have at least one passkey enrolled — promote it to non-admin
 * users").
 *
 * Returns two payloads from the same endpoint:
 *
 *   - `aggregate` — single SELECT bucketing every admin/owner-role
 *     member across every workspace. Same shape as the workspace
 *     endpoint so the platform dashboard can re-use the workspace
 *     traffic-light tile component. A user who is admin in N workspaces
 *     contributes N to the bucket counts (one per admin-membership)
 *     because the unit of analysis is "an admin in a workspace", which
 *     is what drives nudge decisions.
 *   - `workspaces` — single SELECT producing one row per workspace
 *     with the same per-workspace bucket counts. Capped at 1000 rows to
 *     bound the payload — more than that and the dashboard needs
 *     pagination, not a wall of rows.
 *
 * Trust-device counts are computed against the verification rows directly,
 * NOT against the `member × verification` join — a single trust cookie
 * for a user who is admin in three workspaces should count once in the
 * platform aggregate, not three times. The per-workspace breakdown
 * groups by `org_id` so the per-workspace numbers correctly reflect that
 * cookie in each of the three workspaces.
 *
 * All queries are read-only single-statement SELECTs.
 */

import { Effect } from "effect";
import { createRoute } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext } from "@atlas/api/lib/effect/services";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import {
  PlatformSecurityMetricsSchema,
  SecurityBucketsSchema,
} from "@useatlas/schemas";
import type { SecurityBuckets } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createPlatformRouter } from "./admin-router";

const log = createLogger("platform-security-metrics");

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * Hard cap on per-workspace breakdown rows. The platform dashboard renders
 * the breakdown as a single non-virtualized table; without the cap a
 * SaaS region with 10k workspaces would ship a multi-megabyte payload on
 * every page load. 1000 covers the foreseeable tier; a future operator
 * console that needs more should add proper pagination rather than raise
 * this number.
 */
const WORKSPACE_BREAKDOWN_LIMIT = 1000;

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
      content: { "application/json": { schema: PlatformSecurityMetricsSchema } },
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
  active_trust_device_users: number;
  [key: string]: unknown;
}

interface WorkspaceRow extends AggregateRow {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string | null;
}

function bucketsFromRow(row: AggregateRow): SecurityBuckets {
  return {
    adminCount: row.admin_count,
    mfaEnrolled: row.mfa_enrolled,
    twoFactorOnly: row.two_factor_only,
    passkeyOnly: row.passkey_only,
    bothFactors: row.both_factors,
    noFactors: row.no_factors,
    activeTrustDevices: row.active_trust_devices,
    activeTrustDeviceUsers: row.active_trust_device_users,
  };
}

/**
 * Tag thrown errors with which query produced them. Without provenance,
 * a `Promise.all([...])` rejection just surfaces "statement_timeout"
 * with no clue whether the aggregate or the per-workspace breakdown
 * blew the timer — and the latter has 4× the CTE depth.
 */
function tagError(query: "aggregate" | "workspaces"): (err: unknown) => Error {
  return (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    return Object.assign(e, { query });
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
    //      endpoint, but no organization filter. Suspended/soft-deleted
    //      workspaces are filtered out — they aren't taking new logins,
    //      so their counters would be misleading noise.
    //   2. Per-workspace breakdown — one row per active workspace,
    //      capped at WORKSPACE_BREAKDOWN_LIMIT.
    const aggregateEffect = Effect.tryPromise({
      try: () =>
        internalQuery<AggregateRow>(
          `WITH platform_admins AS (
             SELECT DISTINCT
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
             SELECT v.value AS user_id
             FROM verification v
             WHERE v.identifier LIKE 'trust-device-%'
               AND v."expiresAt" > NOW()
               AND v.value IN (SELECT user_id FROM platform_admins)
           )
           SELECT
             COUNT(*)::int AS admin_count,
             COUNT(*) FILTER (WHERE has_totp OR has_passkey)::int AS mfa_enrolled,
             COUNT(*) FILTER (WHERE has_totp AND NOT has_passkey)::int AS two_factor_only,
             COUNT(*) FILTER (WHERE NOT has_totp AND has_passkey)::int AS passkey_only,
             COUNT(*) FILTER (WHERE has_totp AND has_passkey)::int AS both_factors,
             COUNT(*) FILTER (WHERE NOT has_totp AND NOT has_passkey)::int AS no_factors,
             (SELECT COUNT(*)::int FROM trust_grants) AS active_trust_devices,
             (SELECT COUNT(DISTINCT user_id)::int FROM trust_grants) AS active_trust_device_users
           FROM platform_admins`,
          [],
        ),
      catch: tagError("aggregate"),
    });

    const workspacesEffect = Effect.tryPromise({
      try: () =>
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
               COUNT(DISTINCT tg.user_id)::int AS active_trust_device_users
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
             COALESCE(t.active_trust_device_users, 0) AS active_trust_device_users
           FROM organization o
           LEFT JOIN org_buckets b ON b.org_id = o.id
           LEFT JOIN org_trust t ON t.org_id = o.id
           WHERE o.deleted_at IS NULL
             AND o.suspended_at IS NULL
           ORDER BY COALESCE(b.admin_count, 0) DESC, o.name ASC
           LIMIT $1`,
          [WORKSPACE_BREAKDOWN_LIMIT],
        ),
      catch: tagError("workspaces"),
    });

    const [aggregateRows, workspaceRows] = yield* Effect.all(
      [aggregateEffect, workspacesEffect],
      { concurrency: 2 },
    );

    const aggregateRow = aggregateRows[0];
    if (!aggregateRow) {
      // Aggregate queries always return a row — a missing one means
      // shape drift, same as the workspace endpoint. Fail loudly with
      // 500 rather than coercing to all-zero buckets that would render
      // as "the entire SaaS has zero admins" on the dashboard.
      log.error({ requestId }, "Platform security aggregate returned no row");
      return c.json(
        {
          error: "internal_error",
          message: "Security metrics are temporarily unavailable. This is unexpected — please share the request ID with support.",
          requestId,
        },
        500,
      );
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

// `SecurityBucketsSchema` is re-exported for tests that need to assert
// the response shape against the canonical schema without traversing
// the `@useatlas/schemas` re-export chain.
export { platformSecurityMetrics, SecurityBucketsSchema };

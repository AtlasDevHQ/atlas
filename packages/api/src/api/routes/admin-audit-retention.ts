/**
 * Admin audit retention management routes.
 *
 * Mounted under /api/v1/admin/audit/retention. All routes require admin role AND
 * enterprise license (enforced within the retention service layer).
 *
 * Provides:
 * - GET  /                — current retention policy
 * - PUT  /                — update retention policy
 * - POST /export          — compliance export (CSV or JSON)
 * - POST /purge           — manually trigger soft-delete purge
 * - POST /hard-delete     — manually trigger hard-delete cleanup
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { RetentionError } from "@atlas/ee/audit/retention";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const retentionDomainError = domainError(RetentionError, { validation: 400, not_found: 404 });

/** Extract the caller's IP for audit row attribution. */
function clientIpFrom(headers: { header(name: string): string | undefined }): string | null {
  return headers.header("x-forwarded-for") ?? headers.header("x-real-ip") ?? null;
}

/** Render any thrown value to a string suitable for audit metadata. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RetentionPolicySchema = z.object({
  orgId: z.string(),
  retentionDays: z.number().nullable(),
  hardDeleteDelayDays: z.number(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  lastPurgeAt: z.string().nullable(),
  lastPurgeCount: z.number().nullable(),
});

const UpdateRetentionBodySchema = z.object({
  retentionDays: z.number().nullable().openapi({
    example: 90,
    description: "Number of days to retain audit entries. null = unlimited. Minimum 7.",
  }),
  hardDeleteDelayDays: z.number().optional().openapi({
    example: 30,
    description: "Days after soft-delete before permanent deletion. Default 30.",
  }),
});

const ExportBodySchema = z.object({
  format: z.enum(["csv", "json"]).openapi({
    example: "csv",
    description: "Export format: csv or json",
  }),
  startDate: z.string().optional().openapi({
    example: "2026-01-01",
    description: "Start date for export range (ISO 8601)",
  }),
  endDate: z.string().optional().openapi({
    example: "2026-03-22",
    description: "End date for export range (ISO 8601)",
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const getRetentionRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Audit Retention"],
  summary: "Get audit retention policy",
  description:
    "Returns the current audit retention policy for the admin's active organization. Returns null policy if no retention is configured (unlimited).",
  responses: {
    200: {
      description: "Current retention policy",
      content: {
        "application/json": {
          schema: z.object({ policy: RetentionPolicySchema.nullable() }),
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateRetentionRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Admin — Audit Retention"],
  summary: "Update audit retention policy",
  description:
    "Sets or updates the audit retention policy. Retention period must be at least 7 days or null (unlimited).",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: UpdateRetentionBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Updated retention policy",
      content: {
        "application/json": {
          schema: z.object({ policy: RetentionPolicySchema }),
        },
      },
    },
    400: {
      description: "Invalid retention configuration or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const exportRoute = createRoute({
  method: "post",
  path: "/export",
  tags: ["Admin — Audit Retention"],
  summary: "Export audit log for compliance",
  description:
    "Exports audit log entries in CSV or JSON format with optional date range filtering. SOC2-ready format. Enterprise feature.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: ExportBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Exported audit data (CSV or JSON download)",
      content: {
        "text/csv": { schema: z.string() },
        "application/json": { schema: z.record(z.string(), z.unknown()) },
      },
    },
    400: {
      description: "Invalid export parameters or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const purgeRoute = createRoute({
  method: "post",
  path: "/purge",
  tags: ["Admin — Audit Retention"],
  summary: "Trigger audit log purge",
  description:
    "Manually triggers soft-delete of audit log entries past the retention window. Normally runs automatically on a daily schedule.",
  responses: {
    200: {
      description: "Purge results",
      content: {
        "application/json": {
          schema: z.object({
            results: z.array(z.object({
              orgId: z.string(),
              softDeletedCount: z.number(),
            })),
          }),
        },
      },
    },
    400: {
      description: "No active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const hardDeleteRoute = createRoute({
  method: "post",
  path: "/hard-delete",
  tags: ["Admin — Audit Retention"],
  summary: "Trigger permanent deletion of purged entries",
  description:
    "Permanently deletes audit log entries that were soft-deleted longer ago than the hard-delete delay. Normally runs automatically on a daily schedule.",
  responses: {
    200: {
      description: "Hard delete results",
      content: {
        "application/json": {
          schema: z.object({ deletedCount: z.number() }),
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role or enterprise license required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Internal database not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminAuditRetention = createAdminRouter();

adminAuditRetention.use(requireOrgContext());

// GET / — get current retention policy
adminAuditRetention.openapi(getRetentionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const { getRetentionPolicy } = yield* Effect.promise(() => import("@atlas/ee/audit/retention"));
    const policy = yield* getRetentionPolicy(orgId!);
    return c.json({ policy }, 200);
  }), { label: "get retention policy", domainErrors: [retentionDomainError] });
});

// PUT / — update retention policy
adminAuditRetention.openapi(updateRetentionRoute, async (c) => {
  const ipAddress = clientIpFrom(c.req);
  return runEffect(c, Effect.gen(function* () {
    const { orgId, user } = yield* AuthContext;

    const body = c.req.valid("json");

    const { setRetentionPolicy, getRetentionPolicy } = yield* Effect.promise(
      () => import("@atlas/ee/audit/retention"),
    );

    // Snapshot the prior policy so the audit row captures a shrink
    // (e.g. 365 → 7 days to enable mass hard-delete). If the read fails
    // we propagate without auditing — no write was attempted.
    const previous = yield* getRetentionPolicy(orgId!);

    const baseMeta = {
      retentionDays: body.retentionDays,
      hardDeleteDelayDays: body.hardDeleteDelayDays ?? null,
      previousRetentionDays: previous?.retentionDays ?? null,
      previousHardDeleteDelayDays: previous?.hardDeleteDelayDays ?? null,
    };

    return yield* setRetentionPolicy(
      orgId!,
      {
        retentionDays: body.retentionDays,
        hardDeleteDelayDays: body.hardDeleteDelayDays,
      },
      user?.id ?? null,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          logAdminAction({
            actionType: ADMIN_ACTIONS.audit_retention.policyUpdate,
            targetType: "audit_retention",
            targetId: orgId!,
            metadata: baseMeta,
            ipAddress,
          });
        }),
      ),
      Effect.tapError((err) =>
        Effect.sync(() => {
          logAdminAction({
            actionType: ADMIN_ACTIONS.audit_retention.policyUpdate,
            targetType: "audit_retention",
            targetId: orgId!,
            status: "failure",
            metadata: { ...baseMeta, error: errorMessage(err) },
            ipAddress,
          });
        }),
      ),
      Effect.map((policy) => c.json({ policy }, 200)),
    );
  }), { label: "update retention policy", domainErrors: [retentionDomainError] });
});

// POST /export — compliance export
adminAuditRetention.openapi(exportRoute, async (c) => {
  const ipAddress = clientIpFrom(c.req);
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const body = c.req.valid("json");

    // Audit metadata records what was requested + how many rows came
    // back, never the actual exported content (would defeat the point of
    // export-rate-limit forensics if the trail itself contained the
    // exported PII / SQL).
    const baseMeta = {
      format: body.format,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
    };

    const { exportAuditLog } = yield* Effect.promise(() => import("@atlas/ee/audit/retention"));

    return yield* exportAuditLog({
      orgId: orgId!,
      format: body.format,
      startDate: body.startDate,
      endDate: body.endDate,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          logAdminAction({
            actionType: ADMIN_ACTIONS.audit_retention.export,
            targetType: "audit_retention",
            targetId: orgId!,
            metadata: { ...baseMeta, rowCount: result.rowCount },
            ipAddress,
          });
        }),
      ),
      Effect.tapError((err) =>
        Effect.sync(() => {
          logAdminAction({
            actionType: ADMIN_ACTIONS.audit_retention.export,
            targetType: "audit_retention",
            targetId: orgId!,
            status: "failure",
            metadata: { ...baseMeta, error: errorMessage(err) },
            ipAddress,
          });
        }),
      ),
      Effect.map((result) => {
        if (result.format === "csv") {
          const filename = `audit-log-${orgId}-${new Date().toISOString().slice(0, 10)}.csv`;
          return new Response(result.content, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="${filename}"`,
              ...(result.truncated && {
                "X-Export-Truncated": "true",
                "X-Export-Total": String(result.totalAvailable),
              }),
            },
          });
        }

        const filename = `audit-log-${orgId}-${new Date().toISOString().slice(0, 10)}.json`;
        return new Response(result.content, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            ...(result.truncated && {
              "X-Export-Truncated": "true",
              "X-Export-Total": String(result.totalAvailable),
            }),
          },
        });
      }),
    );
  }), { label: "export audit log", domainErrors: [retentionDomainError] });
});

// POST /purge — manual soft-delete purge
adminAuditRetention.openapi(purgeRoute, async (c) => {
  const ipAddress = clientIpFrom(c.req);
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const { purgeExpiredEntries, getRetentionPolicy } = yield* Effect.promise(
      () => import("@atlas/ee/audit/retention"),
    );

    // Snapshot retentionDays for the audit row — purge results don't
    // include the window, and we want it on both success and failure
    // rows so a forensic reader can see what threshold the admin invoked
    // the purge against.
    const policy = yield* getRetentionPolicy(orgId!);
    const retentionDays = policy?.retentionDays ?? null;

    return yield* purgeExpiredEntries(orgId!).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          const softDeletedCount = results.reduce(
            (sum, row) => sum + row.softDeletedCount,
            0,
          );
          logAdminAction({
            actionType: ADMIN_ACTIONS.audit_retention.manualPurge,
            targetType: "audit_retention",
            targetId: orgId!,
            metadata: { softDeletedCount, retentionDays },
            ipAddress,
          });
        }),
      ),
      Effect.tapError((err) =>
        Effect.sync(() => {
          logAdminAction({
            actionType: ADMIN_ACTIONS.audit_retention.manualPurge,
            targetType: "audit_retention",
            targetId: orgId!,
            status: "failure",
            metadata: { retentionDays, error: errorMessage(err) },
            ipAddress,
          });
        }),
      ),
      Effect.map((results) => c.json({ results }, 200)),
    );
  }), { label: "purge audit log entries", domainErrors: [retentionDomainError] });
});

// POST /hard-delete — manual hard-delete cleanup
adminAuditRetention.openapi(hardDeleteRoute, async (c) => {
  const ipAddress = clientIpFrom(c.req);
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const { hardDeleteExpired } = yield* Effect.promise(() => import("@atlas/ee/audit/retention"));

    return yield* hardDeleteExpired(orgId!).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          logAdminAction({
            actionType: ADMIN_ACTIONS.audit_retention.manualHardDelete,
            targetType: "audit_retention",
            targetId: orgId!,
            metadata: { deletedCount: result.deletedCount },
            ipAddress,
          });
        }),
      ),
      Effect.tapError((err) =>
        Effect.sync(() => {
          logAdminAction({
            actionType: ADMIN_ACTIONS.audit_retention.manualHardDelete,
            targetType: "audit_retention",
            targetId: orgId!,
            status: "failure",
            metadata: { error: errorMessage(err) },
            ipAddress,
          });
        }),
      ),
      Effect.map((result) => c.json(result, 200)),
    );
  }), { label: "hard-delete audit log entries", domainErrors: [retentionDomainError] });
});

export { adminAuditRetention };

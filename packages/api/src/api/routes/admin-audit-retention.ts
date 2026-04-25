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
import { logAdminActionAwait, ADMIN_ACTIONS, type AdminActionEntry } from "@atlas/api/lib/audit";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const retentionDomainError = domainError(RetentionError, { validation: 400, not_found: 404 });

const log = createLogger("admin-audit-retention");

function clientIpFrom(headers: { header(name: string): string | undefined }): string | null {
  // x-forwarded-for is comma-joined under multi-hop proxies; the leftmost
  // entry is the original client. Fall back to x-real-ip.
  const fwd = headers.header("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.header("x-real-ip") ?? null;
}

function errorContext(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const ctx: Record<string, unknown> = { message: err.message };
    const codeVal = (err as { code?: unknown }).code;
    if (typeof codeVal === "string") ctx.code = codeVal;
    const tagVal = (err as { _tag?: unknown })._tag;
    if (typeof tagVal === "string") ctx.tag = tagVal;
    return ctx;
  }
  return { message: String(err) };
}

/**
 * Synchronously emit an audit row. Wrapping `logAdminActionAwait` here
 * gives every retention route the same shape:
 *
 *   - Success path: tap returns the audit Effect; if the row fails to
 *     commit the request returns 500 so the admin retries (the EE writes
 *     are idempotent — `setRetentionPolicy` upserts, purge/hard-delete
 *     are time-windowed). A 200 with no audit row would defeat F-26.
 *   - Failure path: tap result is suppressed via `Effect.orElse` so an
 *     audit-emit failure can never replace the original EE error in the
 *     channel. We log the audit miss separately for triage.
 */
function emitAudit(entry: AdminActionEntry): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () => logAdminActionAwait(entry),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });
}

function emitAuditBestEffort(entry: AdminActionEntry): Effect.Effect<void> {
  return emitAudit(entry).pipe(
    Effect.catchAll((auditErr) =>
      Effect.sync(() => {
        log.error(
          { err: auditErr.message, actionType: entry.actionType, targetId: entry.targetId },
          "audit row failed during failure-path emission — original error still propagated",
        );
      }),
    ),
  );
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
// F-53 — audit retention configuration + export + purge are part of the
// audit-log surface; gate on admin:audit alongside admin-audit.ts.
adminAuditRetention.use(requirePermission("admin:audit"));

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

    // The prior policy must be read *before* the write so the audit row
    // captures the delta (a shrink from 365 → 7 days is the threat). If
    // the read fails we still emit a failure audit so an attacker can't
    // probe for a "policy_read transient failure → no audit row" gap.
    const requestedMeta = {
      retentionDays: body.retentionDays,
      hardDeleteDelayDays: body.hardDeleteDelayDays ?? null,
    };

    const previous = yield* getRetentionPolicy(orgId!).pipe(
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.audit_retention.policyUpdate,
          targetType: "audit_retention",
          targetId: orgId!,
          status: "failure",
          metadata: {
            ...requestedMeta,
            previousRetentionDays: null,
            previousHardDeleteDelayDays: null,
            stage: "policy_read",
            ...errorContext(err),
          },
          ipAddress,
        }),
      ),
    );

    const baseMeta = {
      ...requestedMeta,
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
        emitAudit({
          actionType: ADMIN_ACTIONS.audit_retention.policyUpdate,
          targetType: "audit_retention",
          targetId: orgId!,
          metadata: baseMeta,
          ipAddress,
        }),
      ),
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.audit_retention.policyUpdate,
          targetType: "audit_retention",
          targetId: orgId!,
          status: "failure",
          metadata: { ...baseMeta, ...errorContext(err) },
          ipAddress,
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

    // Metadata records what was requested + row count, never the
    // exported content — the trail must not contain the PII / SQL it's
    // auditing.
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
        emitAudit({
          actionType: ADMIN_ACTIONS.audit_retention.export,
          targetType: "audit_retention",
          targetId: orgId!,
          metadata: { ...baseMeta, rowCount: result.rowCount },
          ipAddress,
        }),
      ),
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.audit_retention.export,
          targetType: "audit_retention",
          targetId: orgId!,
          status: "failure",
          metadata: { ...baseMeta, ...errorContext(err) },
          ipAddress,
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
    // expose the window. Read failures emit a stage:policy_read failure
    // audit so a transient PG error doesn't leave an attempted purge
    // unrecorded.
    const policy = yield* getRetentionPolicy(orgId!).pipe(
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.audit_retention.manualPurge,
          targetType: "audit_retention",
          targetId: orgId!,
          status: "failure",
          metadata: { retentionDays: null, stage: "policy_read", ...errorContext(err) },
          ipAddress,
        }),
      ),
    );
    const retentionDays = policy?.retentionDays ?? null;

    return yield* purgeExpiredEntries(orgId!).pipe(
      Effect.tap((results) => {
        const softDeletedCount = results.reduce(
          (sum, row) => sum + row.softDeletedCount,
          0,
        );
        return emitAudit({
          actionType: ADMIN_ACTIONS.audit_retention.manualPurge,
          targetType: "audit_retention",
          targetId: orgId!,
          metadata: { softDeletedCount, retentionDays },
          ipAddress,
        });
      }),
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.audit_retention.manualPurge,
          targetType: "audit_retention",
          targetId: orgId!,
          status: "failure",
          metadata: { retentionDays, ...errorContext(err) },
          ipAddress,
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
        emitAudit({
          actionType: ADMIN_ACTIONS.audit_retention.manualHardDelete,
          targetType: "audit_retention",
          targetId: orgId!,
          metadata: { deletedCount: result.deletedCount },
          ipAddress,
        }),
      ),
      Effect.tapError((err) =>
        emitAuditBestEffort({
          actionType: ADMIN_ACTIONS.audit_retention.manualHardDelete,
          targetType: "audit_retention",
          targetId: orgId!,
          status: "failure",
          metadata: errorContext(err),
          ipAddress,
        }),
      ),
      Effect.map((result) => c.json(result, 200)),
    );
  }), { label: "hard-delete audit log entries", domainErrors: [retentionDomainError] });
});

export { adminAuditRetention };

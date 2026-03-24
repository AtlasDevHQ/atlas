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

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "@atlas/api/lib/logger";
import { EnterpriseError } from "@atlas/ee/index";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { adminAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("admin-audit-retention");

/**
 * Throw HTTPException for known retention errors. Enterprise license
 * errors → 403; RetentionError → 400/404. Unknown errors fall through.
 */
function throwIfRetentionError(err: unknown): void {
  if (err instanceof EnterpriseError) {
    throw new HTTPException(403, {
      res: Response.json({ error: "enterprise_required", message: err.message }, { status: 403 }),
    });
  }
  // Dynamically import to check error type
  if (err && typeof err === "object" && "code" in err && "name" in err) {
    const typedErr = err as { name: string; code: string; message: string };
    if (typedErr.name === "RetentionError") {
      const statusMap = { validation: 400, not_found: 404 } as const;
      const status = statusMap[typedErr.code as keyof typeof statusMap] ?? 400;
      throw new HTTPException(status, {
        res: Response.json({ error: typedErr.code, message: typedErr.message }, { status }),
      });
    }
  }
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

const adminAuditRetention = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

adminAuditRetention.use(adminAuth);
adminAuditRetention.use(requestContext);

adminAuditRetention.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Our thrown HTTPExceptions carry a JSON Response
    if (err.res) return err.res;
    // Framework 400 for malformed JSON
    if (err.status === 400) {
      return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
    }
  }
  throw err;
});

// GET / — get current retention policy
adminAuditRetention.openapi(getRetentionRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  try {
    const { getRetentionPolicy } = await import("@atlas/ee/audit/retention");
    const policy = await getRetentionPolicy(orgId);
    return c.json({ policy }, 200);
  } catch (err) {
    throwIfRetentionError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to get retention policy");
    return c.json({ error: "internal_error", message: "Failed to get retention policy.", requestId }, 500);
  }
});

// PUT / — update retention policy
adminAuditRetention.openapi(updateRetentionRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  const body = c.req.valid("json");

  try {
    const { setRetentionPolicy } = await import("@atlas/ee/audit/retention");
    const policy = await setRetentionPolicy(
      orgId,
      {
        retentionDays: body.retentionDays,
        hardDeleteDelayDays: body.hardDeleteDelayDays,
      },
      authResult.user?.id ?? null,
    );
    return c.json({ policy }, 200);
  } catch (err) {
    throwIfRetentionError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to update retention policy");
    return c.json({ error: "internal_error", message: "Failed to update retention policy.", requestId }, 500);
  }
});

// POST /export — compliance export
adminAuditRetention.openapi(exportRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  const body = c.req.valid("json");

  try {
    const { exportAuditLog } = await import("@atlas/ee/audit/retention");
    const result = await exportAuditLog({
      orgId,
      format: body.format,
      startDate: body.startDate,
      endDate: body.endDate,
    });

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

    // JSON format
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
  } catch (err) {
    throwIfRetentionError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to export audit log");
    return c.json({ error: "internal_error", message: "Failed to export audit log.", requestId }, 500);
  }
});

// POST /purge — manual soft-delete purge
adminAuditRetention.openapi(purgeRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
  }

  try {
    const { purgeExpiredEntries } = await import("@atlas/ee/audit/retention");
    const results = await purgeExpiredEntries(orgId);
    return c.json({ results }, 200);
  } catch (err) {
    throwIfRetentionError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId, orgId }, "Failed to purge audit log");
    return c.json({ error: "internal_error", message: "Failed to purge audit log entries.", requestId }, 500);
  }
});

// POST /hard-delete — manual hard-delete cleanup
adminAuditRetention.openapi(hardDeleteRoute, async (c) => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "No internal database configured." }, 404);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "no_organization", message: "No active organization.", requestId }, 404);
  }

  try {
    const { hardDeleteExpired } = await import("@atlas/ee/audit/retention");
    const result = await hardDeleteExpired(orgId);
    return c.json(result, 200);
  } catch (err) {
    throwIfRetentionError(err);
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to hard-delete audit log entries");
    return c.json({ error: "internal_error", message: "Failed to hard-delete audit log entries.", requestId }, 500);
  }
});

export { adminAuditRetention };

/**
 * Admin PII compliance routes.
 *
 * Mounted under /api/v1/admin/compliance. All routes require admin role AND
 * enterprise license (enforced within the compliance service layer).
 *
 * Provides:
 * - GET    /classifications       — list PII column classifications
 * - PUT    /classifications/:id   — update a classification (category, strategy, dismiss)
 * - DELETE /classifications/:id   — delete a classification
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { validationHook } from "./validation-hook";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { adminAuthPreamble } from "./admin-auth";
import {
  listPIIClassifications,
  updatePIIClassification,
  deletePIIClassification,
  invalidateClassificationCache,
  ComplianceError,
} from "@atlas/ee/compliance/masking";
import type { PIICategory, MaskingStrategy } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";

const log = createLogger("admin-compliance");

const COMPLIANCE_ERROR_STATUS = { validation: 400, not_found: 404, conflict: 409 } as const;

function complianceErrorResponse(err: unknown): { body: Record<string, unknown>; status: 400 | 403 | 404 | 409 } | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Enterprise features")) {
    return { body: { error: "enterprise_required", message }, status: 403 };
  }
  if (err instanceof ComplianceError) {
    return { body: { error: err.code, message: err.message }, status: COMPLIANCE_ERROR_STATUS[err.code] };
  }
  return null;
}

// ── Schemas ─────────────────────────────────────────────────────

const PIIClassificationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  tableName: z.string(),
  columnName: z.string(),
  connectionId: z.string(),
  category: z.string(),
  confidence: z.string(),
  maskingStrategy: z.string(),
  reviewed: z.boolean(),
  dismissed: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const UpdateClassificationBodySchema = z.object({
  category: z.enum(["email", "phone", "ssn", "credit_card", "name", "ip_address", "date_of_birth", "address", "passport", "driver_license", "other"]).optional().openapi({
    description: "Override PII category",
    example: "email",
  }),
  maskingStrategy: z.enum(["full", "partial", "hash", "redact"]).optional().openapi({
    description: "Masking strategy for this column",
    example: "partial",
  }),
  dismissed: z.boolean().optional().openapi({
    description: "Dismiss as false positive",
    example: false,
  }),
  reviewed: z.boolean().optional().openapi({
    description: "Mark as reviewed",
    example: true,
  }),
});

// ── Route definitions ───────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/classifications",
  tags: ["Admin — Compliance"],
  summary: "List PII column classifications",
  request: {
    query: z.object({
      connectionId: z.string().optional().openapi({ description: "Filter by connection ID" }),
    }),
  },
  responses: {
    200: { description: "PII classifications", content: { "application/json": { schema: z.object({ classifications: z.array(PIIClassificationSchema) }) } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateRoute = createRoute({
  method: "put",
  path: "/classifications/:id",
  tags: ["Admin — Compliance"],
  summary: "Update a PII classification",
  request: {
    body: { required: true, content: { "application/json": { schema: UpdateClassificationBodySchema } } },
  },
  responses: {
    200: { description: "Updated classification", content: { "application/json": { schema: z.object({ classification: PIIClassificationSchema }) } } },
    400: { description: "Invalid input or no active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/classifications/:id",
  tags: ["Admin — Compliance"],
  summary: "Delete a PII classification",
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Router ──────────────────────────────────────────────────────

export const adminCompliance = new OpenAPIHono({ defaultHook: validationHook });

adminCompliance.onError((err, c) => {
  if (err instanceof HTTPException && err.status === 400) {
    return c.json({ error: "bad_request", message: "Invalid JSON body." }, 400);
  }
  throw err;
});

// GET /classifications
adminCompliance.openapi(listRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
    }
    const { connectionId } = c.req.valid("query");

    try {
      const classifications = await listPIIClassifications(orgId, connectionId);
      return c.json({ classifications }, 200);
    } catch (err) {
      const mapped = complianceErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to list PII classifications");
      return c.json({ error: "internal_error", message: "Failed to list PII classifications.", requestId }, 500);
    }
  }) as never;
});

// PUT /classifications/:id
adminCompliance.openapi(updateRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
    }

    const id = c.req.param("id");
    const body = c.req.valid("json");

    try {
      const updated = await updatePIIClassification(orgId, id, {
        category: body.category as PIICategory | undefined,
        maskingStrategy: body.maskingStrategy as MaskingStrategy | undefined,
        dismissed: body.dismissed,
        reviewed: body.reviewed,
      });
      invalidateClassificationCache(orgId);
      return c.json({ classification: updated }, 200);
    } catch (err) {
      const mapped = complianceErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to update PII classification");
      return c.json({ error: "internal_error", message: "Failed to update PII classification.", requestId }, 500);
    }
  }) as never;
});

// DELETE /classifications/:id
adminCompliance.openapi(deleteRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await adminAuthPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "No internal database configured." }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "bad_request", message: "No active organization. Set an active org first." }, 400);
    }

    const id = c.req.param("id");

    try {
      await deletePIIClassification(orgId, id);
      invalidateClassificationCache(orgId);
      return c.json({ deleted: true }, 200);
    } catch (err) {
      const mapped = complianceErrorResponse(err);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to delete PII classification");
      return c.json({ error: "internal_error", message: "Failed to delete PII classification.", requestId }, 500);
    }
  }) as never;
});

/**
 * Admin compliance routes (PII classifications + reporting).
 *
 * Mounted under /api/v1/admin/compliance. All routes require admin role AND
 * enterprise license (enforced within the compliance service layer).
 *
 * Provides:
 * - GET    /classifications             — list PII column classifications
 * - PUT    /classifications/:id         — update a classification (category, strategy, dismiss)
 * - DELETE /classifications/:id         — delete a classification
 * - GET    /reports/data-access         — data access compliance report
 * - GET    /reports/user-activity       — user activity compliance report
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { runEffect, domainError } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import {
  listPIIClassifications,
  updatePIIClassification,
  deletePIIClassification,
  invalidateClassificationCache,
  ComplianceError,
} from "@atlas/ee/compliance/masking";
import {
  generateDataAccessReport,
  generateUserActivityReport,
  dataAccessReportToCSV,
  userActivityReportToCSV,
  ReportError,
} from "@atlas/ee/compliance/reports";
import type { PIICategory, MaskingStrategy } from "@useatlas/types";
import { ErrorSchema, AuthErrorSchema, DeletedResponseSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const complianceDomainError = domainError(ComplianceError, { validation: 400, not_found: 404, conflict: 409 });
const reportDomainError = domainError(ReportError, { validation: 400, not_available: 404 });

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
  path: "/classifications/{id}",
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
  path: "/classifications/{id}",
  tags: ["Admin — Compliance"],
  summary: "Delete a PII classification",
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: DeletedResponseSchema } } },
    400: { description: "No active organization", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Router ──────────────────────────────────────────────────────

export const adminCompliance = createAdminRouter();

adminCompliance.use(requireOrgContext());

// GET /classifications
adminCompliance.openapi(listRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const { connectionId } = c.req.valid("query");

    const classifications = yield* listPIIClassifications(orgId!, connectionId);
    return c.json({ classifications }, 200);
  }), { label: "list PII classifications", domainErrors: [complianceDomainError, reportDomainError] });
});

// PUT /classifications/:id
adminCompliance.openapi(updateRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const updated = yield* updatePIIClassification(orgId!, id, {
      category: body.category as PIICategory | undefined,
      maskingStrategy: body.maskingStrategy as MaskingStrategy | undefined,
      dismissed: body.dismissed,
      reviewed: body.reviewed,
    });
    invalidateClassificationCache(orgId!);
    return c.json({ classification: updated }, 200);
  }), { label: "update PII classification", domainErrors: [complianceDomainError, reportDomainError] });
});

// DELETE /classifications/:id
adminCompliance.openapi(deleteRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const id = c.req.param("id");

    yield* deletePIIClassification(orgId!, id);
    invalidateClassificationCache(orgId!);
    return c.json({ deleted: true }, 200);
  }), { label: "delete PII classification", domainErrors: [complianceDomainError, reportDomainError] });
});

// ── Report schemas ──────────────────────────────────────────────

const ReportQuerySchema = z.object({
  startDate: z.string().openapi({ description: "Start date (ISO 8601)", example: "2026-01-01" }),
  endDate: z.string().openapi({ description: "End date (ISO 8601)", example: "2026-03-01" }),
  userId: z.string().optional().openapi({ description: "Filter by user ID" }),
  role: z.string().optional().openapi({ description: "Filter by role" }),
  table: z.string().optional().openapi({ description: "Filter by table name" }),
  format: z.enum(["json", "csv"]).optional().default("json").openapi({ description: "Response format", example: "json" }),
});

const DataAccessRowSchema = z.object({
  tableName: z.string(),
  userId: z.string(),
  userEmail: z.string().nullable(),
  userRole: z.string().nullable(),
  queryCount: z.number(),
  uniqueColumns: z.array(z.string()),
  hasPII: z.boolean(),
  firstAccess: z.string(),
  lastAccess: z.string(),
});

const DataAccessReportSchema = z.object({
  rows: z.array(DataAccessRowSchema),
  summary: z.object({
    totalQueries: z.number(),
    uniqueUsers: z.number(),
    uniqueTables: z.number(),
    piiTablesAccessed: z.number(),
  }),
  filters: z.object({
    startDate: z.string(),
    endDate: z.string(),
    userId: z.string().optional(),
    role: z.string().optional(),
    table: z.string().optional(),
  }),
  generatedAt: z.string(),
});

const UserActivityRowSchema = z.object({
  userId: z.string(),
  userEmail: z.string().nullable(),
  role: z.string().nullable(),
  totalQueries: z.number(),
  tablesAccessed: z.array(z.string()),
  lastActiveAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
});

const UserActivityReportSchema = z.object({
  rows: z.array(UserActivityRowSchema),
  summary: z.object({
    totalUsers: z.number(),
    activeUsers: z.number(),
    totalQueries: z.number(),
  }),
  filters: z.object({
    startDate: z.string(),
    endDate: z.string(),
    userId: z.string().optional(),
    role: z.string().optional(),
    table: z.string().optional(),
  }),
  generatedAt: z.string(),
});

// ── Report route definitions ────────────────────────────────────

const dataAccessReportRoute = createRoute({
  method: "get",
  path: "/reports/data-access",
  tags: ["Admin — Compliance"],
  summary: "Generate data access compliance report",
  description: "Returns a report of who queried what tables, when, and how often within the specified date range.",
  request: { query: ReportQuerySchema },
  responses: {
    200: { description: "Data access report", content: { "application/json": { schema: DataAccessReportSchema } } },
    400: { description: "Invalid parameters", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const userActivityReportRoute = createRoute({
  method: "get",
  path: "/reports/user-activity",
  tags: ["Admin — Compliance"],
  summary: "Generate user activity compliance report",
  description: "Returns a report of user query activity, last login timestamp, and role information within the specified date range.",
  request: { query: ReportQuerySchema },
  responses: {
    200: { description: "User activity report", content: { "application/json": { schema: UserActivityReportSchema } } },
    400: { description: "Invalid parameters", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Forbidden — admin role or enterprise license required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Report handlers ─────────────────────────────────────────────

// GET /reports/data-access
adminCompliance.openapi(dataAccessReportRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const query = c.req.valid("query");

    const report = yield* generateDataAccessReport(orgId!, {
      startDate: query.startDate,
      endDate: query.endDate,
      userId: query.userId,
      role: query.role,
      table: query.table,
    });

    if (query.format === "csv") {
      const csv = dataAccessReportToCSV(report);
      const safeOrgId = orgId!.replace(/[^a-zA-Z0-9_-]/g, "");
      const filename = `data-access-report-${safeOrgId}-${new Date().toISOString().slice(0, 10)}.csv`;
      // CSV responses bypass OpenAPI typed returns via HTTPException + res
      throw new HTTPException(200, {
        res: new Response(csv, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        }),
      });
    }

    return c.json(report, 200);
  }), { label: "generate data access report", domainErrors: [complianceDomainError, reportDomainError] });
});

// GET /reports/user-activity
adminCompliance.openapi(userActivityReportRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;
    const query = c.req.valid("query");

    const report = yield* generateUserActivityReport(orgId!, {
      startDate: query.startDate,
      endDate: query.endDate,
      userId: query.userId,
      role: query.role,
      table: query.table,
    });

    if (query.format === "csv") {
      const csv = userActivityReportToCSV(report);
      const safeOrgId = orgId!.replace(/[^a-zA-Z0-9_-]/g, "");
      const filename = `user-activity-report-${safeOrgId}-${new Date().toISOString().slice(0, 10)}.csv`;
      // CSV responses bypass OpenAPI typed returns via HTTPException + res
      throw new HTTPException(200, {
        res: new Response(csv, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        }),
      });
    }

    return c.json(report, 200);
  }), { label: "generate user activity report", domainErrors: [complianceDomainError, reportDomainError] });
});

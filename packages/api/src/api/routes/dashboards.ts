/**
 * Dashboard REST routes — CRUD for dashboards and cards, sharing, refresh.
 *
 * Admin routes use `adminAuth` + `requireOrgContext` middleware.
 * Public shared endpoint bypasses auth (rate limited per IP).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { z } from "zod";
import { createLogger, hashShareToken } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import {
  createDashboard,
  getDashboard,
  listDashboards,
  updateDashboard,
  deleteDashboard,
  addCard,
  updateCard,
  removeCard,
  refreshCard,
  getCard,
  shareDashboard,
  unshareDashboard,
  getShareStatus,
  getSharedDashboard,
  setRefreshSchedule,
  CardLayoutSchema,
  resolveCardConnectionId,
  NoGroupMembersError,
  type CrudFailReason,
  type SharedDashboardFailReason,
} from "@atlas/api/lib/dashboards";
import { CHART_TYPES } from "@atlas/api/lib/dashboard-types";
import { SHARE_MODES } from "@useatlas/types/share";
import { ErrorSchema, parsePagination } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";
import { validationHook } from "./validation-hook";
import {
  authenticateRequest,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  createPublicRateLimiter,
  warnIfTrustProxyMissingForPublicShare,
} from "@atlas/api/lib/public-rate-limit";

const log = createLogger("dashboard-routes");

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ChartConfigSchema = z.object({
  type: z.enum(CHART_TYPES),
  categoryColumn: z.string(),
  valueColumns: z.array(z.string()).min(1),
});

const CreateDashboardSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
});

const UpdateDashboardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  refreshSchedule: z.string().nullable().optional(),
});

const AddCardSchema = z.object({
  title: z.string().min(1).max(200),
  sql: z.string().min(1),
  chartConfig: ChartConfigSchema.nullable().optional(),
  cachedColumns: z.array(z.string()).nullable().optional(),
  cachedRows: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  /** Group-scoped execution target (1.4.4). Resolved to a physical
   * connection at view time via the group's primary member. */
  connectionGroupId: z.string().nullable().optional(),
  layout: CardLayoutSchema.nullable().optional(),
});

const UpdateCardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  chartConfig: ChartConfigSchema.nullable().optional(),
  position: z.number().int().min(0).optional(),
  layout: CardLayoutSchema.nullable().optional(),
});

const ShareSchema = z.object({
  expiresIn: z.enum(["1h", "24h", "7d", "30d", "never"]).nullable().optional(),
  shareMode: z.enum(SHARE_MODES).optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

function crudFailResponse(reason: CrudFailReason, requestId?: string) {
  switch (reason) {
    case "no_db":
      return { body: { error: "not_available", message: "Dashboards require an internal database." }, status: 404 as const };
    case "not_found":
      return { body: { error: "not_found", message: "Dashboard not found." }, status: 404 as const };
    case "error":
      return { body: { error: "internal_error", message: "A database error occurred. Please try again.", ...(requestId && { requestId }) }, status: 500 as const };
    default: {
      const _exhaustive: never = reason;
      return { body: { error: "internal_error", message: `Unexpected failure: ${_exhaustive}`, ...(requestId && { requestId }) }, status: 500 as const };
    }
  }
}

type UserQueryOutcomeResponse = {
  body: Record<string, unknown>;
  status: 200 | 400 | 401 | 403 | 409 | 429 | 500 | 503;
};

function userQueryOutcomeToResponse(
  outcome: import("@atlas/api/lib/tools/sql").UserQueryOutcome,
  requestId: string,
): UserQueryOutcomeResponse {
  switch (outcome.kind) {
    case "ok":
      return {
        body: {
          columns: outcome.columns,
          rows: outcome.rows,
          rowCount: outcome.rowCount,
          executionMs: outcome.executionMs,
          truncated: outcome.truncated,
          maskingApplied: outcome.maskingApplied,
        },
        status: 200,
      };
    case "validation_failed":
      return { body: { error: "invalid_sql", message: outcome.message, requestId }, status: 400 };
    case "plugin_rejected":
      return { body: { error: "plugin_rejected", message: outcome.message, requestId }, status: 400 };
    case "query_failed":
      return { body: { error: "query_failed", message: outcome.message, requestId }, status: 400 };
    case "rls_failed":
      return { body: { error: "rls_blocked", message: outcome.message, requestId }, status: 403 };
    case "approval_required":
      return {
        body: {
          error: "approval_required",
          approvalRequestId: outcome.approvalRequestId,
          matchedRules: outcome.matchedRules,
          message: outcome.message,
          requestId,
        },
        status: 409,
      };
    case "approval_identity_missing":
      return { body: { error: "auth_required", message: outcome.message, requestId }, status: 401 };
    case "approval_unavailable":
      return { body: { error: "approval_unavailable", message: outcome.message, requestId }, status: 503 };
    case "rate_limited":
      return {
        body: {
          error: "rate_limited",
          message: outcome.message,
          ...("retryAfterMs" in outcome && outcome.retryAfterMs != null && { retryAfterMs: outcome.retryAfterMs }),
          requestId,
        },
        status: 429,
      };
    case "concurrency_limited":
      return { body: { error: "concurrency_limited", message: outcome.message, requestId }, status: 429 };
    case "connection_unavailable":
      return {
        body: {
          error: "connection_unavailable",
          message: outcome.message,
          connectionId: outcome.connectionId,
          requestId,
        },
        status: 503,
      };
    case "no_datasource":
      return { body: { error: "no_datasource", message: outcome.message, requestId }, status: 503 };
    case "pool_exhausted":
      return { body: { error: "pool_exhausted", message: outcome.message, requestId }, status: 503 };
    default: {
      const _exhaustive: never = outcome;
      return {
        body: { error: "internal_error", message: `Unhandled outcome: ${(_exhaustive as { kind: string }).kind}`, requestId },
        status: 500,
      };
    }
  }
}

function sharedDashboardFailResponse(reason: SharedDashboardFailReason) {
  switch (reason) {
    case "expired":
      return { body: { error: "expired", message: "This share link has expired." }, status: 410 as const };
    case "no_db":
      return { body: { error: "not_available", message: "Sharing is not available." }, status: 404 as const };
    case "not_found":
      return { body: { error: "not_found", message: "Dashboard not found." }, status: 404 as const };
    case "error":
      return { body: { error: "internal_error", message: "A server error occurred. Please try again." }, status: 500 as const };
    default: {
      const _exhaustive: never = reason;
      return { body: { error: "internal_error", message: `Unexpected failure: ${_exhaustive}` }, status: 500 as const };
    }
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (public endpoint)
// ---------------------------------------------------------------------------

const PUBLIC_RATE_MAX = 30;

const publicRateLimiter = createPublicRateLimiter({ maxRpm: PUBLIC_RATE_MAX });

/** Interval for dashboard rate-limit cleanup. Exported for SchedulerLayer. */
export const DASHBOARD_RATE_CLEANUP_INTERVAL_MS = 60_000;

/**
 * Evict expired dashboard rate-limit entries. Called periodically by the
 * SchedulerLayer fiber in lib/effect/layers.ts.
 */
export function dashboardRateLimitCleanupTick(): void {
  publicRateLimiter.cleanup();
}

/** @internal — test-only. Drop all dashboard rate-limit state between tests. */
export function _resetDashboardRateLimit(): void {
  publicRateLimiter.reset();
}

// Fire-once startup hint when ATLAS_TRUST_PROXY is unset — see F-73 in the
// security audit. Mirrors the conversations public route.
warnIfTrustProxyMissingForPublicShare();

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listDashboardsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Dashboards"],
  summary: "List dashboards",
  description: "Returns dashboards for the active organization. Requires admin role.",
  request: {
    query: z.object({
      limit: z.string().optional().openapi({ param: { name: "limit", in: "query" }, description: "Maximum number of items (1-100, default 20)." }),
      offset: z.string().optional().openapi({ param: { name: "offset", in: "query" }, description: "Number of items to skip (default 0)." }),
    }),
  },
  responses: {
    200: { description: "Paginated list of dashboards", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Not available", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createDashboardRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Dashboards"],
  summary: "Create a dashboard",
  description: "Creates a new dashboard. Requires admin role.",
  request: { body: { content: { "application/json": { schema: CreateDashboardSchema } }, required: true } },
  responses: {
    201: { description: "Dashboard created", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Not available", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getDashboardRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Dashboards"],
  summary: "Get dashboard with cards",
  description: "Returns a dashboard with all its cards. Requires admin role.",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) },
  responses: {
    200: { description: "Dashboard with cards", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateDashboardRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Dashboards"],
  summary: "Update a dashboard",
  description: "Updates dashboard title, description, or refresh schedule. Requires admin role.",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
    body: { content: { "application/json": { schema: UpdateDashboardSchema } }, required: true },
  },
  responses: {
    200: { description: "Updated dashboard", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    204: { description: "Update succeeded (re-fetch failed)" },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteDashboardRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Dashboards"],
  summary: "Delete a dashboard",
  description: "Soft-deletes a dashboard and its cards. Requires admin role.",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) },
  responses: {
    204: { description: "Dashboard deleted" },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const addCardRoute = createRoute({
  method: "post",
  path: "/{id}/cards",
  tags: ["Dashboards"],
  summary: "Add a card to a dashboard",
  description: "Adds a query result card with optional cached data. Requires admin role.",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
    body: { content: { "application/json": { schema: AddCardSchema } }, required: true },
  },
  responses: {
    201: { description: "Card added", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateCardRoute = createRoute({
  method: "patch",
  path: "/{id}/cards/{cardId}",
  tags: ["Dashboards"],
  summary: "Update a card",
  description: "Updates card title, chart config, or position. Requires admin role.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
      cardId: z.string().openapi({ param: { name: "cardId", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
    body: { content: { "application/json": { schema: UpdateCardSchema } }, required: true },
  },
  responses: {
    200: { description: "Card updated", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    204: { description: "Update succeeded (re-fetch failed)" },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Card not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const removeCardRoute = createRoute({
  method: "delete",
  path: "/{id}/cards/{cardId}",
  tags: ["Dashboards"],
  summary: "Remove a card",
  description: "Removes a card from a dashboard. Requires admin role.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
      cardId: z.string().openapi({ param: { name: "cardId", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    204: { description: "Card removed" },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Card not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const PreviewCardSchema = z.object({
  sql: z.string().min(1),
  connectionId: z.string().nullable().optional(),
});

const previewCardRoute = createRoute({
  method: "post",
  path: "/preview-card",
  tags: ["Dashboards"],
  summary: "Preview a card query without saving",
  description:
    "Validates and executes SQL against the analytics datasource through the full Atlas pipeline (validation, approval, RLS, auto-LIMIT, audit, masking). Used by the chat-side dashboard canvas to render live previews of cards the agent has proposed but the user has not yet saved. Requires admin role.",
  request: { body: { content: { "application/json": { schema: PreviewCardSchema } }, required: true } },
  responses: {
    200: { description: "Query results", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid SQL, plugin rejection, or query failure", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden or blocked by RLS", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    409: { description: "Approval required before execution", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
    429: { description: "Rate or concurrency limit", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Connection or approval system unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const refreshCardRoute = createRoute({
  method: "post",
  path: "/{id}/cards/{cardId}/refresh",
  tags: ["Dashboards"],
  summary: "Refresh a card",
  description: "Re-executes the card's SQL through the full Atlas pipeline and updates cached results. Requires admin role.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
      cardId: z.string().openapi({ param: { name: "cardId", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: { description: "Card refreshed with new data", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    204: { description: "Refresh succeeded (re-fetch failed)" },
    400: { description: "Invalid ID, SQL validation failure, plugin rejection, or query failure", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden or blocked by RLS", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Card not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Approval required before execution", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate or concurrency limit", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Connection or approval system unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const refreshAllCardsRoute = createRoute({
  method: "post",
  path: "/{id}/refresh",
  tags: ["Dashboards"],
  summary: "Refresh all cards",
  description: "Re-executes SQL for all cards in a dashboard. Requires admin role.",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
  },
  responses: {
    200: { description: "All cards refreshed", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const shareDashboardRoute = createRoute({
  method: "post",
  path: "/{id}/share",
  tags: ["Dashboards"],
  summary: "Share a dashboard",
  description: "Generates a share token for public or org-scoped access. Requires admin role.",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
    body: { content: { "application/json": { schema: ShareSchema } }, required: false },
  },
  responses: {
    200: { description: "Share token generated", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const unshareDashboardRoute = createRoute({
  method: "delete",
  path: "/{id}/share",
  tags: ["Dashboards"],
  summary: "Revoke dashboard share",
  description: "Revokes the share token. Requires admin role.",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) },
  responses: {
    204: { description: "Share revoked" },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getShareStatusRoute = createRoute({
  method: "get",
  path: "/{id}/share",
  tags: ["Dashboards"],
  summary: "Get share status",
  description: "Returns the current share status of a dashboard. Requires admin role.",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) },
  responses: {
    200: { description: "Share status", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const suggestCardsRoute = createRoute({
  method: "post",
  path: "/{id}/suggest",
  tags: ["Dashboards"],
  summary: "Suggest new cards via AI",
  description: "Analyzes existing dashboard cards and proposes 2-3 complementary cards using the AI model and semantic layer. Requires admin role.",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
  },
  responses: {
    200: { description: "Suggested cards", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID or dashboard has no cards", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getSharedDashboardRoute = createRoute({
  method: "get",
  path: "/{token}",
  tags: ["Dashboards"],
  summary: "View a shared dashboard",
  description: "Returns the content of a shared dashboard. No auth required for public shares. Rate limited per IP.",
  request: {
    params: z.object({ token: z.string().openapi({ param: { name: "token", in: "path" }, example: "abc123def456ghi789jk" }) }),
  },
  responses: {
    200: { description: "Shared dashboard content", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Authentication required for org-scoped shares", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    410: { description: "Share link expired", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Router setup
// ---------------------------------------------------------------------------

const authed = createAdminRouter();
authed.use(requireOrgContext());

// Outer app for the authenticated admin routes
const dashboards = new OpenAPIHono({ defaultHook: validationHook });

// Public router for shared dashboards
const publicDashboards = new OpenAPIHono({ defaultHook: validationHook });

// ---------------------------------------------------------------------------
// GET / — list dashboards
// ---------------------------------------------------------------------------

authed.openapi(listDashboardsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { limit, offset } = parsePagination(c, { limit: 20, maxLimit: 100 });
    const result = yield* Effect.promise(() => listDashboards({ orgId, limit, offset }));
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.json(result.data, 200);
  }), { label: "list dashboards" });
});

// ---------------------------------------------------------------------------
// POST / — create dashboard
// ---------------------------------------------------------------------------

authed.openapi(
  createDashboardRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId, user } = yield* AuthContext;
      const parsed = c.req.valid("json");

      const result = yield* Effect.promise(() => createDashboard({
        ownerId: user?.id ?? "anonymous",
        orgId,
        title: parsed.title,
        description: parsed.description ?? null,
      }));

      if (!result.ok) {
        const fail = crudFailResponse(result.reason, requestId);
        return c.json(fail.body, fail.status);
      }
      return c.json(result.data, 201);
    }), { label: "create dashboard" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json({ error: "validation_error", message: "Invalid request body.", details: result.error.issues }, 422);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /:id — get dashboard with cards
// ---------------------------------------------------------------------------

authed.openapi(getDashboardRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const result = yield* Effect.promise(() => getDashboard(id, { orgId }));
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.json(result.data, 200);
  }), { label: "get dashboard" });
});

// ---------------------------------------------------------------------------
// PATCH /:id — update dashboard
// ---------------------------------------------------------------------------

authed.openapi(
  updateDashboardRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      const { id } = c.req.valid("param");
      if (!UUID_RE.test(id)) {
        return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
      }

      const parsed = c.req.valid("json");

      // Handle refreshSchedule separately (needs cron validation + next_refresh_at)
      if (parsed.refreshSchedule !== undefined) {
        if (parsed.refreshSchedule) {
          const { validateCronExpression, computeNextRun } = yield* Effect.promise(() => import("@atlas/api/lib/scheduled-tasks"));
          const cronCheck = validateCronExpression(parsed.refreshSchedule);
          if (!cronCheck.valid) {
            return c.json({ error: "invalid_request", message: `Invalid cron expression: ${cronCheck.error}` }, 400);
          }
          const schedResult = yield* Effect.promise(() => setRefreshSchedule(id, { orgId }, parsed.refreshSchedule!, computeNextRun));
          if (!schedResult.ok) {
            const fail = crudFailResponse(schedResult.reason, requestId);
            return c.json(fail.body, fail.status);
          }
        } else {
          // Disabling auto-refresh (null)
          const { computeNextRun } = yield* Effect.promise(() => import("@atlas/api/lib/scheduled-tasks"));
          const schedResult = yield* Effect.promise(() => setRefreshSchedule(id, { orgId }, null, computeNextRun));
          if (!schedResult.ok) {
            const fail = crudFailResponse(schedResult.reason, requestId);
            return c.json(fail.body, fail.status);
          }
        }
      }

      // Apply remaining updates (title, description)
      const { refreshSchedule: _, ...otherUpdates } = parsed;
      if (Object.keys(otherUpdates).length > 0) {
        const result = yield* Effect.promise(() => updateDashboard(id, { orgId }, otherUpdates));
        if (!result.ok) {
          const fail = crudFailResponse(result.reason, requestId);
          return c.json(fail.body, fail.status);
        }
      }

      // Return updated dashboard
      const updated = yield* Effect.promise(() => getDashboard(id, { orgId }));
      if (!updated.ok) return c.body(null, 204);
      return c.json(updated.data, 200);
    }), { label: "update dashboard" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json({ error: "validation_error", message: "Invalid request body.", details: result.error.issues }, 422);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id — soft delete dashboard
// ---------------------------------------------------------------------------

authed.openapi(deleteDashboardRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const result = yield* Effect.promise(() => deleteDashboard(id, { orgId }));
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  }), { label: "delete dashboard" });
});

// ---------------------------------------------------------------------------
// POST /:id/cards — add card
// ---------------------------------------------------------------------------

authed.openapi(
  addCardRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      const { id } = c.req.valid("param");
      if (!UUID_RE.test(id)) {
        return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
      }

      // Verify dashboard exists and belongs to org
      const dash = yield* Effect.promise(() => getDashboard(id, { orgId }));
      if (!dash.ok) {
        const fail = crudFailResponse(dash.reason, requestId);
        return c.json(fail.body, fail.status);
      }

      const parsed = c.req.valid("json");
      const result = yield* Effect.promise(() => addCard({
        dashboardId: id,
        title: parsed.title,
        sql: parsed.sql,
        chartConfig: parsed.chartConfig ?? null,
        cachedColumns: parsed.cachedColumns ?? null,
        cachedRows: parsed.cachedRows ?? null,
        connectionGroupId: parsed.connectionGroupId ?? null,
        layout: parsed.layout ?? null,
      }));

      if (!result.ok) {
        const fail = crudFailResponse(result.reason, requestId);
        return c.json(fail.body, fail.status);
      }
      return c.json(result.data, 201);
    }), { label: "add card" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json({ error: "validation_error", message: "Invalid request body.", details: result.error.issues }, 422);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /:id/cards/:cardId — update card
// ---------------------------------------------------------------------------

authed.openapi(
  updateCardRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      const { id, cardId } = c.req.valid("param");
      if (!UUID_RE.test(id) || !UUID_RE.test(cardId)) {
        return c.json({ error: "invalid_request", message: "Invalid ID format." }, 400);
      }

      // Verify dashboard ownership
      const dash = yield* Effect.promise(() => getDashboard(id, { orgId }));
      if (!dash.ok) {
        const fail = crudFailResponse(dash.reason, requestId);
        return c.json(fail.body, fail.status);
      }

      const parsed = c.req.valid("json");
      const result = yield* Effect.promise(() => updateCard(cardId, id, parsed));
      if (!result.ok) {
        const fail = crudFailResponse(result.reason, requestId);
        return c.json(fail.body, fail.status);
      }

      const updated = yield* Effect.promise(() => getCard(cardId, id));
      if (!updated.ok) return c.body(null, 204);
      return c.json(updated.data, 200);
    }), { label: "update card" });
  },
  (result, c) => {
    if (!result.success) {
      return c.json({ error: "validation_error", message: "Invalid request body.", details: result.error.issues }, 422);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id/cards/:cardId — remove card
// ---------------------------------------------------------------------------

authed.openapi(removeCardRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { id, cardId } = c.req.valid("param");
    if (!UUID_RE.test(id) || !UUID_RE.test(cardId)) {
      return c.json({ error: "invalid_request", message: "Invalid ID format." }, 400);
    }

    const dash = yield* Effect.promise(() => getDashboard(id, { orgId }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const result = yield* Effect.promise(() => removeCard(cardId, id));
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  }), { label: "remove card" });
});

// ---------------------------------------------------------------------------
// POST /preview-card — run SQL for canvas preview through the full Atlas
// pipeline (validation, approval, RLS, auto-LIMIT, audit, masking).
// ---------------------------------------------------------------------------

authed.openapi(previewCardRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { sql, connectionId } = c.req.valid("json");

    const { runUserQueryPipeline } = yield* Effect.promise(() => import("@atlas/api/lib/tools/sql"));
    const outcome = yield* Effect.promise(() =>
      runUserQueryPipeline({
        sql,
        ...(connectionId && { connectionId }),
        explanation: "Dashboard card preview",
      }),
    );
    const { body, status } = userQueryOutcomeToResponse(outcome, requestId);
    // The OpenAPI route response is typed per-status; the helper's body
    // shape is guaranteed by its switch but TS can't narrow across the
    // status-set, so cast at the boundary.
    return c.json(body as never, status);
  }), { label: "preview card" });
});

// ---------------------------------------------------------------------------
// POST /:id/cards/:cardId/refresh — refresh single card
// ---------------------------------------------------------------------------

authed.openapi(refreshCardRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { id, cardId } = c.req.valid("param");
    if (!UUID_RE.test(id) || !UUID_RE.test(cardId)) {
      return c.json({ error: "invalid_request", message: "Invalid ID format." }, 400);
    }

    const dash = yield* Effect.promise(() => getDashboard(id, { orgId }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const cardResult = yield* Effect.promise(() => getCard(cardId, id));
    if (!cardResult.ok) {
      return c.json({ error: "not_found", message: "Card not found." }, 404);
    }

    // Resolve group-scoped execution. A card pointing at a group with
    // zero members must NOT silently fall back to the workspace
    // default — return a typed 500 with requestId so the admin can
    // see exactly which group needs members.
    let resolvedConnectionId: string | null;
    try {
      resolvedConnectionId = yield* Effect.promise(() =>
        resolveCardConnectionId(
          { connectionGroupId: cardResult.data.connectionGroupId },
          dash.data.orgId,
        ),
      );
    } catch (err) {
      if (err instanceof NoGroupMembersError) {
        log.warn({ cardId, groupId: err.groupId, orgId: err.orgId, requestId }, "Card refresh: group has no members");
        return c.json(
          {
            error: "group_no_members",
            message: `Connection group "${err.groupId}" has no members. Add a connection or repoint the card.`,
            requestId,
          },
          500,
        );
      }
      throw err;
    }
    const { runUserQueryPipeline } = yield* Effect.promise(() => import("@atlas/api/lib/tools/sql"));
    const outcome = yield* Effect.promise(() =>
      runUserQueryPipeline({
        sql: cardResult.data.sql,
        ...(resolvedConnectionId && { connectionId: resolvedConnectionId }),
        explanation: `Dashboard card refresh: ${cardResult.data.title}`,
      }),
    );

    if (outcome.kind !== "ok") {
      const { body, status } = userQueryOutcomeToResponse(outcome, requestId);
      return c.json(body as never, status);
    }

    const refreshResult = yield* Effect.promise(() => refreshCard(cardId, id, {
      columns: outcome.columns,
      rows: outcome.rows,
    }));
    if (!refreshResult.ok) {
      const fail = crudFailResponse(refreshResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const updated = yield* Effect.promise(() => getCard(cardId, id));
    if (!updated.ok) return c.body(null, 204);
    return c.json(updated.data, 200);
  }), { label: "refresh card" });
});

// ---------------------------------------------------------------------------
// POST /:id/refresh — refresh all cards
// ---------------------------------------------------------------------------

authed.openapi(refreshAllCardsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const dashResult = yield* Effect.promise(() => getDashboard(id, { orgId }));
    if (!dashResult.ok) {
      const fail = crudFailResponse(dashResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const { runUserQueryPipeline } = yield* Effect.promise(() => import("@atlas/api/lib/tools/sql"));
    const cards = dashResult.data.cards;
    let refreshed = 0;
    let failed = 0;
    const errors: Array<{ cardId: string; cardTitle: string; reason: string; message: string }> = [];

    // Sequential to avoid overloading the source. Each card flows through
    // the full pipeline (validation + approval + RLS + audit) — the bulk
    // entry point is not a license to skip per-query governance.
    for (const card of cards) {
      // Resolve group → primary member per card. A "no members" group
      // counts as a per-card failure with `reason: "group_no_members"`
      // so the bulk loop keeps draining instead of failing the whole
      // refresh; the response surfaces the offending group in `errors`.
      let resolvedConnectionId: string | null;
      try {
        resolvedConnectionId = yield* Effect.promise(() =>
          resolveCardConnectionId(
            { connectionGroupId: card.connectionGroupId },
            dashResult.data.orgId,
          ),
        );
      } catch (err) {
        if (err instanceof NoGroupMembersError) {
          failed++;
          errors.push({
            cardId: card.id,
            cardTitle: card.title,
            reason: "group_no_members",
            message: `Connection group "${err.groupId}" has no members.`,
          });
          continue;
        }
        throw err;
      }
      const outcome = yield* Effect.promise(() =>
        runUserQueryPipeline({
          sql: card.sql,
          ...(resolvedConnectionId && { connectionId: resolvedConnectionId }),
          explanation: `Dashboard bulk refresh: ${card.title}`,
        }),
      );

      if (outcome.kind !== "ok") {
        failed++;
        errors.push({
          cardId: card.id,
          cardTitle: card.title,
          reason: outcome.kind,
          message: outcome.message,
        });
        continue;
      }

      const result = yield* Effect.promise(() => refreshCard(card.id, id, {
        columns: outcome.columns,
        rows: outcome.rows,
      }));
      if (result.ok) {
        refreshed++;
      } else {
        failed++;
        errors.push({
          cardId: card.id,
          cardTitle: card.title,
          reason: "persist_failed",
          message: result.reason,
        });
      }
    }

    return c.json({ refreshed, failed, total: cards.length, errors }, 200);
  }), { label: "refresh all cards" });
});

// ---------------------------------------------------------------------------
// POST /:id/share — generate share token
// ---------------------------------------------------------------------------

authed.openapi(
  shareDashboardRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId } = yield* AuthContext;
      const { id } = c.req.valid("param");
      if (!UUID_RE.test(id)) {
        return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
      }

      let parsed: { expiresIn?: string | null; shareMode?: string } = {};
      try {
        const body = yield* Effect.promise(() => c.req.json().catch(() => null));
        if (body) {
          parsed = ShareSchema.parse(body);
        }
      } catch (err) {
        // intentionally ignored: body is optional, invalid values fall back to defaults
        log.debug({ err: err instanceof Error ? err.message : String(err) }, "Share body parse/validation failed, using defaults");
      }

      const result = yield* Effect.promise(() => shareDashboard(id, { orgId }, {
        expiresIn: (parsed.expiresIn as "1h" | "24h" | "7d" | "30d" | "never" | null) ?? null,
        shareMode: (parsed.shareMode as "public" | "org") ?? "public",
      }));

      if (!result.ok) {
        if (result.reason === "invalid_org_scope") {
          return c.json({
            error: "invalid_request",
            message: "Cannot create an org-scoped share for a dashboard with no organization.",
          }, 400);
        }
        const fail = crudFailResponse(result.reason, requestId);
        return c.json(fail.body, fail.status);
      }
      return c.json(result.data, 200);
    }), { label: "share dashboard" });
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id/share — revoke share
// ---------------------------------------------------------------------------

authed.openapi(unshareDashboardRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const result = yield* Effect.promise(() => unshareDashboard(id, { orgId }));
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  }), { label: "unshare dashboard" });
});

// ---------------------------------------------------------------------------
// GET /:id/share — get share status
// ---------------------------------------------------------------------------

authed.openapi(getShareStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const result = yield* Effect.promise(() => getShareStatus(id, { orgId }));
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.json(result.data, 200);
  }), { label: "get share status" });
});

// ---------------------------------------------------------------------------
// POST /:id/suggest — AI-driven card suggestions
// ---------------------------------------------------------------------------

authed.openapi(suggestCardsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const dash = yield* Effect.promise(() => getDashboard(id, { orgId }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    if (dash.data.cards.length === 0) {
      return c.json({ error: "invalid_request", message: "Dashboard has no cards. Add cards first before requesting suggestions." }, 400);
    }

    // Load semantic layer context for grounding suggestions
    const { getOrgSemanticIndex } = yield* Effect.promise(() => import("@atlas/api/lib/semantic"));
    const semanticIndex = yield* Effect.tryPromise({
      try: () => getOrgSemanticIndex(orgId ?? "default"),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.catchAll((err) => {
      log.warn({ err: err.message, orgId, dashboardId: id }, "Failed to load semantic index for suggestions — proceeding without semantic context");
      return Effect.succeed("");
    }));

    // Optionally load learned patterns for extra context
    const { buildLearnedPatternsSection } = yield* Effect.promise(() => import("@atlas/api/lib/learn/pattern-cache"));
    const patternsSection = yield* Effect.tryPromise({
      try: () => buildLearnedPatternsSection(orgId ?? null, "dashboard suggestions"),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.catchAll((err) => {
      log.warn({ err: err.message, orgId, dashboardId: id }, "Failed to load learned patterns for suggestions — proceeding without patterns");
      return Effect.succeed("");
    }));

    // Build LLM prompt from existing cards
    const existingCards = dash.data.cards.map((card) => ({
      title: card.title,
      sql: card.sql,
      chartType: card.chartConfig?.type ?? "table",
    }));

    const systemPrompt = [
      "You are a data analyst helping design effective dashboards.",
      "Given the semantic layer (available tables and columns) and existing dashboard cards, suggest 2-3 new cards that would complement the dashboard.",
      "",
      "Guidelines:",
      "- Suggest metrics that add perspective: trends over time, breakdowns by dimension, comparisons, or anomaly detection.",
      "- Use ONLY tables and columns defined in the semantic layer below.",
      "- Write valid, read-only SELECT queries.",
      "- Choose the most appropriate chart type for each suggestion.",
      "- Provide a clear reason explaining why each card is useful.",
      "",
      "## Semantic Layer (available tables and columns)",
      semanticIndex || "(No semantic layer available — use tables referenced in existing cards.)",
      patternsSection ? `\n${patternsSection}` : "",
    ].join("\n");

    const userPrompt = [
      `Dashboard: "${dash.data.title}"`,
      dash.data.description ? `Description: ${dash.data.description}` : "",
      "",
      "Existing cards:",
      ...existingCards.map((card, i) => `${i + 1}. "${card.title}" (${card.chartType})\n   SQL: ${card.sql}`),
      "",
      "Respond with a JSON array of 2-3 suggestions. Each suggestion must have exactly these fields:",
      '- "title": string (concise card title)',
      '- "sql": string (valid SELECT query)',
      '- "chartType": one of "bar", "line", "pie", "area", "scatter", "table"',
      '- "categoryColumn": string (column for x-axis/category)',
      '- "valueColumns": string[] (columns for y-axis/values)',
      '- "reason": string (why this card complements the dashboard)',
      "",
      "Return ONLY the JSON array, no markdown fencing or extra text.",
    ].filter(Boolean).join("\n");

    // Call LLM — resolve model imperatively (runEffect only supports RequestContext/AuthContext)
    const { getModel } = yield* Effect.promise(() => import("@atlas/api/lib/providers"));
    const model = getModel();
    const { generateText } = yield* Effect.promise(() => import("ai"));

    const llmResult = yield* Effect.tryPromise({
      try: () => generateText({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxOutputTokens: 2000,
      }),
      catch: (err) => err instanceof Error ? err : new Error(String(err)),
    }).pipe(Effect.catchAll((err) => {
      log.error({ err: err.message, dashboardId: id, requestId }, "LLM call failed for card suggestions");
      return Effect.succeed(null);
    }));

    if (!llmResult) {
      return c.json({ error: "ai_unavailable", message: "AI model is unavailable. Check your provider configuration or try again later.", requestId }, 500);
    }

    // Parse LLM response using Zod for safe validation
    const RawSuggestionSchema = z.array(z.object({
      title: z.string(),
      sql: z.string(),
      chartType: z.string(),
      categoryColumn: z.string(),
      valueColumns: z.array(z.string()),
      reason: z.string(),
    }));

    let rawSuggestions: z.infer<typeof RawSuggestionSchema>;

    try {
      const text = llmResult.text.trim();
      // Strip markdown code fencing if present
      const jsonStr = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
      const parsed = RawSuggestionSchema.safeParse(JSON.parse(jsonStr));
      if (!parsed.success) {
        log.warn({ errors: parsed.error.issues, dashboardId: id }, "AI suggestions failed schema validation");
        return c.json({ error: "internal_error", message: "AI returned invalid suggestion format. Please try again.", requestId }, 500);
      }
      rawSuggestions = parsed.data;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), text: llmResult.text.slice(0, 500), dashboardId: id }, "Failed to parse AI suggestions");
      return c.json({ error: "internal_error", message: "Failed to parse AI suggestions. Please try again.", requestId }, 500);
    }

    // Validate each suggestion's SQL and build response
    const { validateSQL } = yield* Effect.promise(() => import("@atlas/api/lib/tools/sql"));
    const validChartTypes = new Set(CHART_TYPES);

    // validateSQL is now async (lazy-loads the per-org whitelist).
    // Run validations concurrently — map → Promise.all → filter, same
    // shape as the prior sync map, with the per-call await contained.
    const suggestionsResolved = yield* Effect.promise(() =>
      Promise.all(rawSuggestions.map(async (s) => {
        const validation = await validateSQL(s.sql, undefined);
        if (!validation.valid) return null;
        const chartType = validChartTypes.has(s.chartType as typeof CHART_TYPES[number]) ? s.chartType : "table";
        return {
          title: s.title.slice(0, 200),
          sql: s.sql,
          chartConfig: {
            type: chartType as import("@atlas/api/lib/dashboard-types").ChartType,
            categoryColumn: s.categoryColumn,
            valueColumns: s.valueColumns,
          },
          reason: s.reason.slice(0, 500),
        };
      }))
    );
    const suggestions = suggestionsResolved
      .filter((s): s is NonNullable<typeof s> => s !== null);

    return c.json({ suggestions }, 200);
  }), { label: "suggest cards" });
});

// Mount authenticated routes
dashboards.route("/", authed);

// ---------------------------------------------------------------------------
// Public: GET /api/public/dashboards/:token — shared dashboard view
// ---------------------------------------------------------------------------

publicDashboards.openapi(getSharedDashboardRoute, async (c) => {
  const requestId = crypto.randomUUID();

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Sharing is not available." }, 404);
  }

  const ip = getClientIP(c.req.raw);
  if (!publicRateLimiter.check(ip)) {
    // F-73: anonymous=true means the request landed in the shared
    // anonymous bucket because the route layer could not resolve a
    // canonical client IP — usually a missing ATLAS_TRUST_PROXY.
    log.warn({ requestId, ip, anonymous: ip === null }, "Public dashboard rate limited");
    return c.json({ error: "rate_limited", message: "Too many requests. Please wait before trying again.", requestId }, 429);
  }

  const { token } = c.req.valid("param");
  if (!SHARE_TOKEN_RE.test(token)) {
    return c.json({ error: "not_found", message: "Dashboard not found." }, 404);
  }

  const tokenHash = hashShareToken(token);
  const result = await getSharedDashboard(token);
  if (!result.ok) {
    const fail = sharedDashboardFailResponse(result.reason);
    if (result.reason === "error") {
      log.error({ requestId, tokenHash }, "Public dashboard fetch failed due to DB error");
    }
    return c.json(fail.body, fail.status);
  }

  // Org-scoped shares require authentication
  if (result.data.shareMode === "org") {
    let authResult: AuthResult;
    try {
      authResult = await authenticateRequest(c.req.raw);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), requestId, tokenHash },
        "Auth check failed for org-scoped dashboard share",
      );
      return c.json({ error: "internal_error", message: "Authentication check failed. Please try again.", requestId }, 500);
    }
    if (!authResult.authenticated) {
      return c.json({ error: "auth_required", message: "This shared dashboard requires authentication.", requestId }, 403);
    }
    // Verify authenticated user belongs to the dashboard's org. Fail closed
    // when the dashboard row has no orgId: the schema allows NULL org_id with
    // share_mode='org' (createShareLink does not stamp orgId), so a truthy-check
    // here would silently fall through and leak the dashboard cross-tenant —
    // same class of bug as #1727 (conversations). See #1736.
    if (!result.data.orgId || authResult.user?.activeOrganizationId !== result.data.orgId) {
      log.warn(
        {
          requestId,
          tokenHash,
          hasOrgId: Boolean(result.data.orgId),
          actorUserId: authResult.user?.id,
          actorOrgId: authResult.user?.activeOrganizationId,
        },
        "Org-scoped dashboard share access denied — requester is not a member of the dashboard's org",
      );
      return c.json({ error: "forbidden", message: "You do not have access to this dashboard.", requestId }, 403);
    }
  }

  return c.json(result.data, 200);
});

export { dashboards, publicDashboards };

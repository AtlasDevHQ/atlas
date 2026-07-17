/**
 * Dashboard REST routes — CRUD for dashboards and cards, sharing, refresh.
 *
 * Admin routes use `adminAuth` + `requireOrgContext` middleware.
 * Public shared endpoint bypasses auth (rate limited per IP).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { RequestContext, AuthContext } from "@atlas/api/lib/effect/services";
import { z } from "zod";
import { createLogger, hashShareToken } from "@atlas/api/lib/logger";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { isConnectionVisibleInMode } from "@atlas/api/lib/db/connection";
import { verifyGroupBelongsToOrg } from "@atlas/api/lib/conversations";
import {
  listSessionsForDashboard,
  getSessionTranscript,
} from "@atlas/api/lib/bound-chat-context";
import { screenshotDashboard, exportDashboard } from "@atlas/api/lib/dashboard-screenshot";
import { toCsv, csvFilename } from "@atlas/api/lib/csv";
import { corsResponseHeaders } from "@atlas/api/lib/cors";
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
  refreshDashboardCards,
  getCard,
  shareDashboard,
  unshareDashboard,
  getShareStatus,
  getSharedDashboard,
  setRefreshSchedule,
  TextCardLayoutSchema,
  resolveCardConnectionId,
  NoGroupMembersError,
  type CrudFailReason,
  type SharedDashboardFailReason,
} from "@atlas/api/lib/dashboards";
import { CHART_TYPES, DASHBOARD_GRID } from "@atlas/api/lib/dashboard-types";
import type { DashboardCard, DashboardWithCards } from "@atlas/api/lib/dashboard-types";
import {
  forkOrLoadDraft,
  loadDraft,
  discardDraft,
  publishDraft,
  rebaseDraft,
  materializeDraftView,
  applyEditToDraft,
  type DashboardSnapshotCard,
  type ApplyEditToDraftResult,
  type DraftChange,
} from "@atlas/api/lib/dashboard-versioning";
import {
  loadDraftCardCache,
  saveDraftCardCache,
  EMPTY_DRAFT_CARD_CACHE,
} from "@atlas/api/lib/dashboard-draft-cache";
import { SHARE_MODES } from "@useatlas/types/share";
import { dashboardParametersSchema, renderCardRequestSchema, renderCardQuerySchema, refreshCardQuerySchema, dashboardChartConfigSchema, dashboardCardAnnotationsSchema, dashboardCardKindSchema, dashboardTextCardContentSchema } from "@useatlas/schemas";
import {
  resolveDashboardParameterValues,
  extractPlaceholderNames,
  derivePriorPeriodValues,
  validateAutoComparison,
} from "@atlas/api/lib/dashboard-parameters";
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

/** Shared chart/table/KPI config (#3137) — carries the optional `kpi` block so
 *  add/update-card round-trip the comparison query instead of stripping it. */
const ChartConfigSchema = dashboardChartConfigSchema;

const CreateDashboardSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  /** Top-level parameter definitions (#2267) — cards bind via `:<key>`. */
  parameters: dashboardParametersSchema.optional(),
});

const UpdateDashboardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  refreshSchedule: z.string().nullable().optional(),
  /** Replace the dashboard's parameter definitions (#2267). */
  parameters: dashboardParametersSchema.optional(),
});

const AddCardSchema = z
  .object({
    title: z.string().min(1).max(200),
    // #4318 — `kind` defaults to "chart" so every existing caller (which omits
    // it) keeps working unchanged. A "text" / section card carries `content`
    // (markdown) and NO `sql`; a "chart" card carries `sql` and no `content`.
    // This widens the REST input surface to the parity the draft / bound-editor
    // path already has (text cards + a card kind) — the routing itself stays
    // draft-first via `applyEditToDraft`.
    kind: dashboardCardKindSchema.optional(),
    // Optional at the object level; the kind-specific requirement is enforced in
    // the `.superRefine` below (chart → sql required; text → sql forbidden).
    sql: z.string().min(1).optional(),
    /** Markdown body of a text / section card (#3138). Required for a text
     *  card, rejected on a chart card (enforced in `.superRefine`). */
    content: dashboardTextCardContentSchema.optional(),
    chartConfig: ChartConfigSchema.nullable().optional(),
    /** Event annotations (#3209) — dated markers rendered as vertical reference
     *  lines on a line / area card. Omitted → the card has none. */
    annotations: dashboardCardAnnotationsSchema.optional(),
    cachedColumns: z.array(z.string()).nullable().optional(),
    cachedRows: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    /** Group-scoped execution target (1.4.4). Resolved to a physical
     * connection at view time via the group's primary member. */
    connectionGroupId: z.string().nullable().optional(),
    // #4687 — validate against the SHORTER text-card height floor here (this
    // schema carries `kind`), then re-assert the taller chart floor for a chart
    // card in the superRefine below. A text card's one-line banner (h=2) passes;
    // a chart card still floors at `MIN_H` (4).
    layout: TextCardLayoutSchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const kind = v.kind ?? "chart";
    if (kind === "text") {
      // A text card renders its markdown; it never touches the SQL pipeline.
      if (v.content === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A text card requires `content`.", path: ["content"] });
      }
      if (v.sql !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A text card cannot carry `sql`.", path: ["sql"] });
      }
      if (v.chartConfig != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A text card cannot carry `chartConfig`.", path: ["chartConfig"] });
      }
    } else {
      if (v.sql === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A chart card requires `sql`.", path: ["sql"] });
      }
      if (v.content !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`content` is only valid on a text card.", path: ["content"] });
      }
      // #4687 — the layout field is validated against the shorter text floor;
      // a chart card keeps the taller MIN_H (4) floor.
      if (v.layout != null && v.layout.h < DASHBOARD_GRID.MIN_H) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `A chart card's height must be at least ${DASHBOARD_GRID.MIN_H} rows.`,
          path: ["layout", "h"],
        });
      }
    }
  });

const UpdateCardSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  // #4318 — card-SQL edits are reachable through the REST route, matching the
  // draft / bound-editor `editSql` capability (which the input surface omitted).
  // Omitted → the card's query is unchanged; a chart card's SQL is replaced in
  // place. The new query runs through the full validation/execution pipeline at
  // render/refresh time (as the draft path does), not at store time. Text-card
  // content edits are intentionally NOT here: the draft/bound surface has no
  // "edit markdown in place" op either (remove + re-add), so mirroring it keeps
  // parity and avoids the `content`-presence kind-flip hazard on a chart card.
  // The update path carries no `kind`, so a `sql` edit on a TEXT card is NOT
  // rejected here — it persists a dead, non-empty `sql` the card ignores (kind
  // stays "text" because `rowToCard` derives kind from content-presence, which
  // wins). Inert, not a discriminant corruption; the bound editor rejects it for
  // cleanliness, but the REST seam has no kind context without an extra read.
  sql: z.string().min(1).optional(),
  chartConfig: ChartConfigSchema.nullable().optional(),
  /** Replace the card's event annotations (#3209). Omitted → unchanged; an
   *  explicit array (including `[]` to clear) replaces them. */
  annotations: dashboardCardAnnotationsSchema.optional(),
  position: z.number().int().min(0).optional(),
  // #4687 — the drag-to-save path carries no card `kind` (same reason `sql` on a
  // text card isn't rejected here — no kind context without an extra read), so
  // the layout floors at the absolute minimum (`TEXT_MIN_H`, 2) to accept a text
  // card's shorter banner. This does NOT re-assert the chart floor server-side:
  // the UI's per-kind resize `minH` keeps a *dragged* chart at >= `MIN_H` (4),
  // but a direct PATCH could persist a short chart — which then renders short
  // (valid geometry, matched by `rowToCard`'s kind-blind read), never lost.
  layout: TextCardLayoutSchema.nullable().optional(),
});

const ShareSchema = z.object({
  expiresIn: z.enum(["1h", "24h", "7d", "30d", "never"]).nullable().optional(),
  shareMode: z.enum(SHARE_MODES).optional(),
  /** Explicit token rotation (#4317). Default false: editing a live share's
   *  expiry/visibility PRESERVES the token so prior links keep working. Set
   *  true to mint a new token (prior links die) — the caller must warn first. */
  rotate: z.boolean().optional(),
});

/**
 * Whole-dashboard export request (#3211). `format` selects the artifact
 * (defaults to PDF in the handler when omitted); `parameters` carries the
 * caller's current override map, forwarded to the headless render via the
 * `dparams` URL key so the export reproduces the viewer's parameter values.
 */
const ExportDashboardSchema = z.object({
  format: z.enum(["png", "pdf"]).optional(),
  parameters: z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .optional(),
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
      return { body: { error: "internal_error", message: `Unexpected failure: ${String(_exhaustive)}`, ...(requestId && { requestId }) }, status: 500 as const };
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
    case "enterprise_unavailable":
      // #2593 — distinct from `connection_unavailable` so SaaS monitoring
      // can correlate with `enterprise.load_failed` structured logs.
      return { body: { error: "enterprise_load_failed", message: outcome.message, requestId }, status: 503 };
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
      return { body: { error: "internal_error", message: `Unexpected failure: ${String(_exhaustive)}` }, status: 500 as const };
    }
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (public endpoint)
// ---------------------------------------------------------------------------

/** Per-viewer ceiling (requests/min) for the public shared-dashboard surface.
 *  Exported so tests assert per-viewer bucketing without hardcoding the number. */
export const PUBLIC_RATE_MAX = 30;

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
  description:
    "Returns a dashboard with all its cards. Requires admin role. Pass `?view=draft` to overlay the caller's per-user draft (#2364) when one exists; the published view is returned otherwise.",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
    query: z.object({
      view: z.enum(["published", "draft"]).optional().openapi({
        param: { name: "view", in: "query" },
        description: "`draft` overlays the current user's draft when one exists; `published` (default) returns the live published dashboard.",
      }),
    }),
  },
  responses: {
    200: { description: "Dashboard with cards", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Draft routes (#2364) — per-user dashboard drafts
// ---------------------------------------------------------------------------

const getDraftRoute = createRoute({
  method: "get",
  path: "/{id}/draft",
  tags: ["Dashboards", "Drafts"],
  summary: "Get (or fork) the caller's draft for a dashboard",
  description:
    "Returns the current user's draft for this dashboard, forking from published on first call. Requires admin role.",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) },
  responses: {
    200: { description: "Draft snapshot + materialized DashboardWithCards", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// #2521 — lightweight non-forking presence check. The Publish UI needs
// to know "does this user have a draft?" without the side effect that
// `GET /:id/draft` has (it forks on first call). Returns the metadata
// fields only — no snapshot — so the client can derive the draft badge,
// the publish-button enabled state, and the stale-baseline check
// without paying for the full materialized view. 404 when no draft
// exists; the publish/discard/rebase buttons stay hidden.
const getDraftStatusRoute = createRoute({
  method: "get",
  path: "/{id}/draft/status",
  tags: ["Dashboards", "Drafts"],
  summary: "Check whether the caller has an active draft for this dashboard",
  description:
    "Non-forking presence check. Returns 200 with `{ hasDraft: true, publishedBaselineAt, dashboardUpdatedAt }` when the caller's draft exists, or 200 with `{ hasDraft: false }` when not. The client uses `publishedBaselineAt !== dashboardUpdatedAt` to surface the stale-baseline banner.",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) },
  responses: {
    200: { description: "Draft presence + baseline timestamps", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const publishDraftRoute = createRoute({
  method: "post",
  path: "/{id}/draft/publish",
  tags: ["Dashboards", "Drafts"],
  summary: "Publish the caller's draft to the live dashboard",
  description:
    "Diff-merges the caller's draft into the live dashboard in a single transaction. Returns 409 when a teammate has published since the draft was forked (with `reason: \"stale_baseline\"`) or when both sides edited the same card (with `reason: \"conflict\"`).",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) },
  responses: {
    200: { description: "Published — number of merge ops applied", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard or draft not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Stale baseline or merge conflict", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const discardDraftRoute = createRoute({
  method: "post",
  path: "/{id}/draft/discard",
  tags: ["Dashboards", "Drafts"],
  summary: "Discard the caller's draft",
  description: "Idempotently drops the caller's draft for this dashboard. No-op if no draft exists.",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) },
  responses: {
    204: { description: "Draft discarded (or already absent)" },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const rebaseDraftRoute = createRoute({
  method: "post",
  path: "/{id}/draft/rebase",
  tags: ["Dashboards", "Drafts"],
  summary: "Rebase the caller's draft onto the latest published baseline",
  description:
    "Fast-forwards the draft onto the latest published row when there are no conflicts; returns 409 with the conflict set when both sides edited the same card.",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }) },
  responses: {
    200: { description: "Rebased draft", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard or draft not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Rebase conflict", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ---------------------------------------------------------------------------
// Draft undo route (#4555, ADR-0034 Decision 2) — the single edit mechanism.
// The bound editor's destructive ops (removeCard / updateCardSql) now apply
// straight to the caller's draft and return an inverse-edit payload; the UI
// POSTs it here to undo. `restore_card` re-adds the removed card verbatim
// (same id → its lingering draft-cache rows are revived); `revert_sql` puts
// the card's prior query back. Both are ordinary draft edits through
// `applyEditToDraft`; nothing reads or writes the retired stage store.
// ---------------------------------------------------------------------------

// The card to restore, mirroring `DashboardSnapshotCard` (the draft snapshot's
// card shape). Unlike the read-only shared projection, this carries `sql` +
// `connectionGroupId` because it re-materializes the card in the draft.
const DraftUndoCardSchema = z.object({
  id: z.string().min(1),
  position: z.number().int(),
  title: z.string(),
  sql: z.string(),
  chartConfig: dashboardChartConfigSchema.nullable(),
  content: z.string().nullable().optional(),
  annotations: dashboardCardAnnotationsSchema.optional(),
  connectionGroupId: z.string().nullable(),
  // #4687 — re-materializes a previously-valid card (chart or text); floors at
  // the shorter text height so a text card's h=2 undo restores correctly.
  layout: TextCardLayoutSchema.nullable(),
});

const DraftUndoBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("restore_card"), card: DraftUndoCardSchema }),
  z.object({ kind: z.literal("revert_sql"), cardId: z.string().min(1), sql: z.string() }),
]);

// Drift guard: `DraftUndoCardSchema` is a hand-mirror of the internal
// `DashboardSnapshotCard`, and the restore path re-materializes the card from
// it. A field added to the snapshot but NOT to the schema would be silently
// dropped on restore (data loss). The addCard mapping below catches a new
// *required* field at compile time; this covers a new *optional* one too — if
// it errors, add the field to `DraftUndoCardSchema` above.
type _Expect<T extends true> = T;
export type _DraftUndoCardCoversSnapshot = _Expect<
  keyof DashboardSnapshotCard extends keyof z.infer<typeof DraftUndoCardSchema> ? true : false
>;

const undoDraftRoute = createRoute({
  method: "post",
  path: "/{id}/draft/undo",
  tags: ["Dashboards", "Drafts"],
  summary: "Undo a bound-editor destructive edit in the caller's draft",
  description:
    "Applies the inverse of a bound-editor destructive edit to the caller's draft: `restore_card` re-adds a removed card (verbatim, same id), `revert_sql` restores a card's prior SQL. An ordinary draft edit — nothing touches the published board until publish. Idempotent: restoring a card that already exists in the draft is a no-op.",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
    body: { content: { "application/json": { schema: DraftUndoBodySchema } }, required: true },
  },
  responses: {
    204: { description: "Undo applied to the caller's draft (or a no-op)" },
    400: { description: "Invalid ID or payload", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard or card not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }) } } },
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
    503: { description: "Drafts unavailable — internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
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
    503: { description: "Drafts unavailable — internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
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
    503: { description: "Drafts unavailable — internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
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
    503: { description: "Drafts unavailable — internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
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
    query: refreshCardQuerySchema,
  },
  responses: {
    200: { description: "Card refreshed with new data", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    204: { description: "Refresh succeeded (re-fetch failed)" },
    400: { description: "Invalid ID, SQL validation failure, plugin rejection, or query failure", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden or blocked by RLS", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Card not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Approval required before execution, or the draft was published/discarded mid-refresh (`draft_gone`)", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate or concurrency limit", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Connection or approval system unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const renderCardRoute = createRoute({
  method: "post",
  path: "/{id}/cards/{cardId}/render",
  tags: ["Dashboards"],
  summary: "Render a card with parameters",
  description:
    "Executes the card's SQL through the full Atlas pipeline with the supplied dashboard parameter values bound server-side (#2267). Values reach SQL only via parameterized queries — never string-interpolated. Omitted parameters fall back to their server-resolved defaults. The result is NOT persisted to the card cache; it's an ephemeral, per-viewer render for the parameter bar. With `?format=csv` (#3210) the SAME parameter-bound result is streamed as a `text/csv` attachment (auto-LIMIT still applies; truncation is surfaced via the `X-Atlas-Truncated` header). Requires admin role.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
      cardId: z.string().openapi({ param: { name: "cardId", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
    query: renderCardQuerySchema,
    // #4318 — the body is OPTIONAL: a body-less `POST …/render` falls back to
    // every parameter's server-resolved default (same as the `export` route,
    // `required: false`). Marking it required would 500 an empty POST.
    body: { content: { "application/json": { schema: renderCardRequestSchema } }, required: false },
  },
  responses: {
    200: {
      description: "Rendered rows for the supplied parameters (JSON), or a CSV attachment when `format=csv`",
      content: {
        "application/json": { schema: z.record(z.string(), z.unknown()) },
        "text/csv": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    400: { description: "Invalid ID/parameters, SQL validation failure, plugin rejection, or query failure", content: { "application/json": { schema: ErrorSchema } } },
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
  description:
    "Re-executes SQL for all cards in a dashboard. Requires admin role. " +
    "Pass `?view=draft` (#4559) to run the caller's DRAFT cards' SQL and persist each result to the caller's private draft cache — the published cards' cached data is left untouched. Omitted/`published` runs the published definitions and writes the shared published cache as before; a caller with no draft always falls back to published.",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
    query: refreshCardQuerySchema,
  },
  responses: {
    200: { description: "All cards refreshed", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "The draft was published or discarded mid-refresh (`draft_gone`)", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Draft cache unavailable — internal database not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const shareDashboardRoute = createRoute({
  method: "post",
  path: "/{id}/share",
  tags: ["Dashboards"],
  summary: "Share a dashboard",
  description:
    "Generates (or updates) a share token for public or org-scoped access. Requires admin role. " +
    "Optional JSON body: `{ expiresIn?: '1h'|'24h'|'7d'|'30d'|'never'|null, shareMode?: 'public'|'org', rotate?: boolean }`. " +
    "An absent/empty body uses safe defaults (public, no rotation); a present-but-invalid body returns 400 and never downgrades the share to public (#4317). " +
    "`rotate` is opt-in: without it, editing expiry/visibility PRESERVES the existing token so prior links keep working; with it, a new token is minted and prior links die.",
  // The body is validated in-handler (fail closed → 400) rather than via the
  // framework's json validator, so a malformed/invalid body returns a 400
  // (#4317) instead of the generic 422 — and so an org-intended share can
  // never silently fall through to `shareMode: "public"`.
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
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

const listDashboardSessionsRoute = createRoute({
  method: "get",
  path: "/{id}/sessions",
  tags: ["Dashboards"],
  summary: "List archived bound chat sessions for a dashboard",
  description:
    "Returns past chat sessions bound to this dashboard (one row per drawer-open). Workspace-wide visibility: any user who can view the dashboard sees every session. Used by the bound chat drawer's History tab (#2368).",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }) }),
  },
  responses: {
    200: { description: "Archived sessions", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getDashboardSessionRoute = createRoute({
  method: "get",
  path: "/{id}/sessions/{sessionId}",
  tags: ["Dashboards"],
  summary: "Read a bound chat session transcript",
  description:
    "Returns the read-only transcript (messages) for one bound session. Workspace-wide visibility: gated by dashboard ACL + binding match, not per-user ownership. Used by the bound chat drawer's History tab transcript panel (#2368).",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
      sessionId: z.string().openapi({ param: { name: "sessionId", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: { description: "Session transcript", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid ID format", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard or session not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const screenshotDashboardRoute = createRoute({
  method: "get",
  path: "/{id}/screenshot",
  tags: ["Dashboards"],
  summary: "Render a PNG screenshot of the dashboard",
  description:
    "Renders the dashboard in a headless Chromium and returns the captured PNG. Scoped to the calling user — when #2364 (drafts foundation) lands, draft views are returned per-user, otherwise the published baseline is captured. Output is cached by (dashboardId, userId, snapshotHash) and invalidated on every mutation. Used internally by the bound agent's `screenshotDashboard` tool (#2367); also exposable to UI for in-conversation previews.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
  },
  responses: {
    200: { description: "PNG screenshot", content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Headless browser unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const exportDashboardRoute = createRoute({
  method: "post",
  path: "/{id}/export",
  tags: ["Dashboards"],
  summary: "Export the whole dashboard as PNG or PDF",
  description:
    "Renders the full dashboard at the caller's current parameter values in a headless Chromium and returns the artifact as a downloadable attachment (filename = dashboard title + UTC timestamp). Reuses the screenshot pipeline (#2367) rather than a second headless path. A single tile that fails to render does NOT abort the export — the response carries `X-Atlas-Export-Partial: 1` and the partial board is still returned. `format` defaults to `pdf`. Requires admin role.",
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, example: "00000000-0000-0000-0000-000000000000" }),
    }),
    body: { content: { "application/json": { schema: ExportDashboardSchema } }, required: false },
  },
  responses: {
    200: {
      description: "Rendered dashboard artifact (PNG or PDF) as a download attachment",
      content: {
        "image/png": { schema: z.string().openapi({ format: "binary" }) },
        "application/pdf": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    400: { description: "Invalid dashboard ID or request body", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    404: { description: "Dashboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal server error (render failed)", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "Internal database or headless browser unavailable", content: { "application/json": { schema: ErrorSchema } } },
    504: { description: "Export timed out", content: { "application/json": { schema: ErrorSchema } } },
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

// ---------------------------------------------------------------------------
// Draft-first routing (#4315, ADR-0029)
//
// Direct manipulation (rename, add/update/remove card, layout) must land in
// the caller's per-user DRAFT, never the published tables — publish is the
// only promotion path. These helpers centralize "does this caller draft?"
// and the failure→HTTP mapping so every direct-manipulation handler enforces
// the invariant identically.
// ---------------------------------------------------------------------------

/**
 * True when this caller's direct-manipulation edits must route to their
 * per-user draft instead of the published tables. Requires a real user id.
 *
 * The `!userId` fall-through to the direct-published write is DEFENSIVE, not a
 * deliberate open hole: every direct-manipulation route here is behind
 * `authed` + `requireOrgContext()`, so a caller normally always has a
 * `user.id`. The only way to reach it with no user is a single-operator
 * `auth: none` self-host — where there is exactly one operator and no teammate
 * to leak a live edit to, so writing published directly is safe. This is
 * intentionally ASYMMETRIC with the bound-tool path (`bound-dashboard.ts`
 * `maybeApplyToDraft`), which *rejects* the no-user case: the bound editor can
 * run in a hosted/multi-user context without a userId, so an unattributable
 * bound edit going live IS the ADR-0029 privacy hole.
 *
 * Drafts themselves are UNCONDITIONAL (#4324): the retired
 * `ATLAS_DASHBOARD_DRAFTS_ENABLED` gate no longer factors in — the only reason
 * a CRUD write skips the draft store is a genuinely absent `userId`. (When a
 * userId IS present but the internal DB is absent, the edit does NOT fall
 * through to a direct write — `applyEditToDraft` returns `no_db` → 503; there
 * are no dashboards to edit on a no-internal-DB deploy anyway.)
 */
function shouldRouteToDraft(userId: string | null | undefined): userId is string {
  return typeof userId === "string" && userId.length > 0;
}

/** Map an `applyEditToDraft` failure to an HTTP body + status. */
function draftEditFailResponse(
  result: Extract<ApplyEditToDraftResult, { ok: false }>,
  requestId: string,
): { body: { error: string; message: string; requestId: string }; status: 404 | 500 | 503 } {
  switch (result.reason) {
    case "no_db":
      return {
        body: {
          error: "drafts_unavailable",
          message:
            "Dashboard edits are saved to your private draft, which needs the internal database. It is not configured on this deployment.",
          requestId,
        },
        status: 503,
      };
    case "load_failed":
      return {
        body: {
          error: "internal_error",
          message: "Could not load your draft (a transient database error). Please retry.",
          requestId,
        },
        status: 500,
      };
    case "unknown_card":
      return {
        body: {
          error: "not_found",
          message: `Card ${result.cardId} was not found in your draft — it may have been removed. Reload and retry.`,
          requestId,
        },
        status: 404,
      };
    case "save_failed":
      return {
        body: {
          error: "internal_error",
          message: "Could not save your draft. Please retry.",
          requestId,
        },
        status: 500,
      };
  }
}

/**
 * The outcome of resolving which card a draft-aware execution (render /
 * single-card refresh / CSV export) should run (#4315, ADR-0029). A tagged
 * union rather than a `DashboardCard | null | sentinel`, so a caller can't
 * accidentally run the "card was removed in the draft" case as a card (a bare
 * `if (card)` would treat a string sentinel as truthy) and the render/refresh
 * `isDraftExec` branch doesn't depend on an implicit null-vs-string ordering.
 */
type DraftExecResolution =
  // The caller is viewing their draft and the card exists there — run this
  // (its SQL / chartConfig / connectionGroupId are the in-progress edits, not
  // the last-published definition the caller separately loaded). `userId` is
  // the draft holder's id, proven by the `shouldRouteToDraft` guard — carried
  // here so the refresh path can write the holder's draft cache without a
  // non-null assertion (#4554).
  | { kind: "override"; card: DashboardCard; userId: string }
  // No draft override applies — run the published card the caller already
  // loaded (view=published, anonymous, or no draft exists).
  | { kind: "published" }
  // The caller asked for the draft view and HAS a draft, but the card id isn't
  // in it (removed in the draft) → the route 404s rather than silently running
  // the published card under a draft view.
  | { kind: "not_in_draft" };

/**
 * Resolve the card a draft-aware execution should run. Reuses
 * `shouldRouteToDraft` so "is this a drafting caller" has one definition
 * across the edit and exec paths.
 */
async function resolveDraftExecCard(
  userId: string | null | undefined,
  view: "published" | "draft" | undefined,
  published: DashboardWithCards,
  cardId: string,
): Promise<DraftExecResolution> {
  if (view !== "draft" || !shouldRouteToDraft(userId)) return { kind: "published" };
  // Note: `loadDraft` returns null for BOTH "no draft" and "load threw" (it
  // logs + swallows). Both resolve to `{ kind: "published" }` here, so the
  // caller runs the PUBLISHED card exactly as a plain published-view request
  // would (the render path stays read-only; the refresh path still persists the
  // published cache — the same write any published refresh does, never a draft
  // write). The draft-first invariant is safe either way, but a transient
  // draft-load error will quietly fall back to published under the draft view
  // rather than surfacing to the user.
  const draft = await loadDraft(userId, published.id);
  if (!draft) return { kind: "published" };
  // Resolution only needs the card's DEFINITION (sql/config/target) — cached
  // data is irrelevant to execution, so skip the draft-cache read (#4554).
  const card = materializeDraftView(published, draft.snapshot, EMPTY_DRAFT_CARD_CACHE).cards.find(
    (cd) => cd.id === cardId,
  );
  return card ? { kind: "override", card, userId } : { kind: "not_in_draft" };
}

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
    const { orgId, user } = yield* AuthContext;
    const { limit, offset } = parsePagination(c, { limit: 20, maxLimit: 100 });
    const result = yield* Effect.promise(() =>
      listDashboards({ orgId, viewerId: user?.id ?? "anonymous", limit, offset }),
    );
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
        parameters: parsed.parameters ?? null,
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
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const result = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
    if (!result.ok) {
      const fail = crudFailResponse(result.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    // #2364 — `?view=draft` overlays the caller's draft when one exists.
    // Viewers (no user, anonymous shares) always see the published row even
    // when ?view=draft is passed — PRD user story 11 ("viewers see published").
    const view = c.req.valid("query").view;
    if (view === "draft" && user?.id) {
      const draft = yield* Effect.promise(() => loadDraft(user.id, id));
      if (draft) {
        // #4554 — the draft view's card data comes from the caller's draft
        // cache (seeded at fork, written by draft refreshes), never from the
        // published cards' cached rows.
        const draftCache = yield* Effect.promise(() => loadDraftCardCache(user.id, id));
        return c.json(materializeDraftView(result.data, draft.snapshot, draftCache), 200);
      }
    }
    return c.json(result.data, 200);
  }), { label: "get dashboard" });
});

// ---------------------------------------------------------------------------
// Draft routes (#2364) — per-user dashboard drafts
// ---------------------------------------------------------------------------

authed.openapi(getDraftRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }
    if (!user?.id) {
      return c.json({ error: "auth_required", message: "Drafts require an authenticated user." }, 401);
    }
    const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    const draftRow = yield* Effect.promise(() => forkOrLoadDraft(user.id, dash.data));
    if (!draftRow) {
      return c.json(
        { error: "internal_error", message: "Could not load or create a draft.", requestId },
        500,
      );
    }
    // #4554 — a fresh fork seeded the draft cache from published inside
    // `forkOrLoadDraft`; from here the draft's data home is its own.
    const draftCache = yield* Effect.promise(() => loadDraftCardCache(user.id, id));
    return c.json(
      {
        draft: {
          userId: draftRow.userId,
          dashboardId: draftRow.dashboardId,
          snapshot: draftRow.snapshot,
          publishedBaselineAt: draftRow.publishedBaselineAt,
          updatedAt: draftRow.updatedAt,
        },
        view: materializeDraftView(dash.data, draftRow.snapshot, draftCache),
      },
      200,
    );
  }), { label: "get draft" });
});

// #2521 — non-forking presence check (powers the draft badge + baseline
// drift detection). Never forks. Returns `{ hasDraft: false }` when the
// caller has no draft, or `{ hasDraft: true, publishedBaselineAt,
// dashboardUpdatedAt }` when one exists. The client compares the two
// timestamps to surface the "your baseline has changed" banner.
authed.openapi(getDraftStatusRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }
    if (!user?.id) {
      return c.json({ error: "auth_required", message: "Drafts require an authenticated user." }, 401);
    }
    // Load dashboard first so we 404 on cross-org reads BEFORE leaking
    // whether a draft row exists (the FK + the route gate already make
    // cross-org reads impossible at the DB layer, but the read-path
    // shape stays consistent with `GET /:id`).
    const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }
    const draft = yield* Effect.promise(() => loadDraft(user.id, id));
    if (!draft) {
      return c.json({ hasDraft: false }, 200);
    }
    return c.json(
      {
        hasDraft: true,
        publishedBaselineAt: draft.publishedBaselineAt,
        dashboardUpdatedAt: dash.data.updatedAt,
        // staleBaseline derived server-side so the client doesn't
        // re-implement the comparison.
        staleBaseline: draft.publishedBaselineAt !== dash.data.updatedAt,
        updatedAt: draft.updatedAt,
      },
      200,
    );
  }), { label: "get draft status" });
});

authed.openapi(publishDraftRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }
    if (!user?.id) {
      return c.json({ error: "auth_required", message: "Drafts require an authenticated user." }, 401);
    }
    const result = yield* Effect.promise(() =>
      publishDraft({
        userId: user.id,
        dashboardId: id,
        orgId,
        loadDashboardForOrg: async (dId, oId) => {
          const r = await getDashboard(dId, { orgId: oId ?? undefined, viewerId: user?.id ?? "anonymous" });
          return r.ok ? r.data : null;
        },
      }),
    );
    if (result.ok) {
      // #4325 — async refresh-on-publish. Definitions are already promoted; now
      // enqueue a background refresh of ONLY the cards whose SQL/config changed
      // and return immediately. Publish NEVER blocks on query execution — those
      // tiles render `stale` (old cache, labeled with its age) until the refresh
      // lands. Fire-and-forget on the long-lived API process; the client's
      // poll-until-fresh re-fetch covers the common case, and the scheduler's
      // auto-refresh tick (where a schedule is configured) is a further backstop
      // if this process is torn down before the refresh completes.
      // Errors are logged (never swallowed) — a failed refresh just leaves the
      // tile stale + retryable, it does not fail the publish.
      const refreshCardIds = result.refreshCardIds;
      if (refreshCardIds.length > 0) {
        void refreshDashboardCards(id, { onlyCardIds: new Set(refreshCardIds) }).catch(
          (err: unknown) => {
            log.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                dashboardId: id,
                cardCount: refreshCardIds.length,
                requestId,
              },
              "post-publish async refresh failed — tiles stay stale until the next refresh",
            );
          },
        );
      }
      return c.json(
        { ok: true, opsApplied: result.opsApplied, refreshingCardIds: refreshCardIds },
        200,
      );
    }
    if (result.reason === "no_db") {
      return c.json(
        { error: "not_available", message: "Dashboards require an internal database." },
        404,
      );
    }
    if (result.reason === "no_draft") {
      return c.json({ error: "not_found", message: "No draft to publish." }, 404);
    }
    if (result.reason === "dashboard_not_found") {
      return c.json({ error: "not_found", message: "Dashboard not found." }, 404);
    }
    if (result.reason === "stale_baseline") {
      return c.json(
        {
          error: "stale_baseline",
          message: "Published has changed since your draft was forked. Rebase before publishing.",
          requestId,
        },
        409,
      );
    }
    if (result.reason === "conflict") {
      return c.json(
        {
          error: "conflict",
          message: "Publish conflicts with concurrent edits.",
          conflicts: result.conflicts,
          requestId,
        },
        409,
      );
    }
    return c.json(
      { error: "internal_error", message: "Publish failed.", requestId },
      500,
    );
  }), { label: "publish draft" });
});

authed.openapi(discardDraftRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format.", requestId }, 400);
    }
    if (!user?.id) {
      return c.json({ error: "auth_required", message: "Drafts require an authenticated user.", requestId }, 401);
    }
    // `discardDraft` returns `false` on an internal-DB throw — surface
    // as 500-with-requestId so the user sees something went wrong
    // rather than a 204 that lies about the deletion. The 204 path
    // covers the (intentional) idempotent zero-row-deleted case.
    const ok = yield* Effect.promise(() => discardDraft(user.id, id));
    if (!ok) {
      return c.json(
        {
          error: "internal_error",
          message: "Could not discard the draft. The database may be temporarily unavailable — try again.",
          requestId,
        },
        500,
      );
    }
    return c.body(null, 204);
  }), { label: "discard draft" });
});

authed.openapi(rebaseDraftRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }
    if (!user?.id) {
      return c.json({ error: "auth_required", message: "Drafts require an authenticated user." }, 401);
    }
    const result = yield* Effect.promise(() =>
      rebaseDraft({
        userId: user.id,
        dashboardId: id,
        orgId,
        loadDashboardForOrg: async (dId, oId) => {
          const r = await getDashboard(dId, { orgId: oId ?? undefined, viewerId: user?.id ?? "anonymous" });
          return r.ok ? r.data : null;
        },
      }),
    );
    if (result.ok) {
      return c.json(
        { ok: true, snapshot: result.snapshot, publishedBaselineAt: result.newBaselineAt },
        200,
      );
    }
    if (result.reason === "no_db") {
      return c.json(
        { error: "not_available", message: "Dashboards require an internal database." },
        404,
      );
    }
    if (result.reason === "no_draft") {
      return c.json({ error: "not_found", message: "No draft to rebase." }, 404);
    }
    if (result.reason === "dashboard_not_found") {
      return c.json({ error: "not_found", message: "Dashboard not found." }, 404);
    }
    if (result.reason === "conflict") {
      return c.json(
        {
          error: "conflict",
          message: "Rebase conflict — your draft and the latest published diverge.",
          conflicts: result.conflicts,
          requestId,
        },
        409,
      );
    }
    return c.json(
      { error: "internal_error", message: "Rebase failed.", requestId },
      500,
    );
  }), { label: "rebase draft" });
});

// ---------------------------------------------------------------------------
// Draft undo route (#4555, ADR-0034 Decision 2)
// ---------------------------------------------------------------------------

authed.openapi(undoDraftRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }
    const uid = user?.id;
    // Undo is a draft edit, so it needs the same attributable-user gate as
    // every other draft write — an unattributable caller has no draft to undo.
    if (!shouldRouteToDraft(uid)) {
      return c.json({ error: "auth_required", message: "Undo requires an authenticated user." }, 401);
    }

    const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: uid }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    // `restore_card` is idempotent: if the card already lives in the draft (a
    // double-undo, or the removal never landed), re-adding it would duplicate
    // the id. Short-circuit to a no-op success instead.
    if (body.kind === "restore_card") {
      const existing = yield* Effect.promise(() => loadDraft(uid, id));
      if (existing?.snapshot.cards.some((cd) => cd.id === body.card.id)) {
        return c.body(null, 204);
      }
    }

    const change: DraftChange =
      body.kind === "restore_card"
        ? {
            kind: "addCard",
            card: {
              ...body.card,
              content: body.card.content ?? null,
              annotations: body.card.annotations ?? [],
            },
          }
        : { kind: "updateCard", cardId: body.cardId, updates: { sql: body.sql } };

    const edit = yield* Effect.promise(() => applyEditToDraft(uid, dash.data, change));
    if (!edit.ok) {
      const fail = draftEditFailResponse(edit, requestId);
      return c.json(fail.body, fail.status);
    }
    return c.body(null, 204);
  }), { label: "undo draft edit" });
});

// ---------------------------------------------------------------------------
// PATCH /:id — update dashboard
// ---------------------------------------------------------------------------

authed.openapi(
  updateDashboardRoute,
  async (c) => {
    return runEffect(c, Effect.gen(function* () {
      const { requestId } = yield* RequestContext;
      const { orgId, user } = yield* AuthContext;
      const { id } = c.req.valid("param");
      if (!UUID_RE.test(id)) {
        return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
      }

      const parsed = c.req.valid("json");

      // Reject a parameter replacement that orphans a placeholder still
      // referenced by an existing card (#2267, CodeRabbit). Otherwise the
      // PATCH saves cleanly but the next render/refresh fails with an
      // undeclared-parameter error. Validate against the published cards —
      // the set that render/refresh actually execute.
      if (parsed.parameters !== undefined) {
        const existing = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
        if (!existing.ok) {
          // A failed pre-read means this guard CANNOT run — fail the PATCH
          // rather than writing parameters blind, which could drop a
          // :placeholder a card still references (#4539). This single
          // pre-read is what authorizes the parameter write further down.
          const fail = crudFailResponse(existing.reason, requestId);
          return c.json(fail.body, fail.status);
        }
        const declared = new Set(parsed.parameters.map((p) => p.key));
        const orphaned = new Set<string>();
        for (const card of existing.data.cards) {
          for (const name of extractPlaceholderNames(card.sql)) {
            if (!declared.has(name)) orphaned.add(name);
          }
        }
        if (orphaned.size > 0) {
          return c.json(
            {
              error: "invalid_parameters",
              message: `Cannot remove parameter(s) still referenced by cards: ${[...orphaned]
                .map((n) => `:${n}`)
                .join(", ")}. Update or remove those cards first.`,
              requestId,
            },
            400,
          );
        }
      }

      // Handle refreshSchedule separately (needs cron validation + next_refresh_at)
      if (parsed.refreshSchedule !== undefined) {
        if (parsed.refreshSchedule) {
          const schedule = parsed.refreshSchedule;
          const { validateCronExpression, computeNextRun } = yield* Effect.promise(() => import("@atlas/api/lib/scheduled-tasks"));
          const cronCheck = validateCronExpression(schedule);
          if (!cronCheck.valid) {
            return c.json({ error: "invalid_request", message: `Invalid cron expression: ${cronCheck.error}` }, 400);
          }
          const schedResult = yield* Effect.promise(() => setRefreshSchedule(id, { orgId, viewerId: user?.id ?? "anonymous" }, schedule, computeNextRun));
          if (!schedResult.ok) {
            const fail = crudFailResponse(schedResult.reason, requestId);
            return c.json(fail.body, fail.status);
          }
        } else {
          // Disabling auto-refresh (null)
          const { computeNextRun } = yield* Effect.promise(() => import("@atlas/api/lib/scheduled-tasks"));
          const schedResult = yield* Effect.promise(() => setRefreshSchedule(id, { orgId, viewerId: user?.id ?? "anonymous" }, null, computeNextRun));
          if (!schedResult.ok) {
            const fail = crudFailResponse(schedResult.reason, requestId);
            return c.json(fail.body, fail.status);
          }
        }
      }

      // Parameters are dashboard-level operational metadata — NOT part of the
      // per-user draft snapshot (which owns title/description/cards). ADR-0029
      // keeps share/refresh/parameter metadata on the live row, so apply a
      // parameter replacement directly (it is workspace-shared config, not a
      // private content edit). Reaching here with parameters set means the
      // orphan-guard pre-read above succeeded — a failed pre-read already
      // failed the whole PATCH (#4539).
      if (parsed.parameters !== undefined) {
        const result = yield* Effect.promise(() =>
          updateDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }, { parameters: parsed.parameters }),
        );
        if (!result.ok) {
          const fail = crudFailResponse(result.reason, requestId);
          return c.json(fail.body, fail.status);
        }
      }

      // Title / description ARE draft content (#4315). Route them to the
      // caller's private draft — nothing but publish may write the published
      // title/description. An anonymous (no-userId) caller falls through to the
      // defensive direct-published write (drafts are unconditional, #4324).
      const metaUpdates: { title?: string; description?: string | null } = {};
      if (parsed.title !== undefined) metaUpdates.title = parsed.title;
      if (parsed.description !== undefined) metaUpdates.description = parsed.description;

      if (Object.keys(metaUpdates).length > 0) {
        const uid = user?.id;
        if (shouldRouteToDraft(uid)) {
          const published = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
          if (!published.ok) {
            const fail = crudFailResponse(published.reason, requestId);
            return c.json(fail.body, fail.status);
          }
          const edit = yield* Effect.promise(() =>
            applyEditToDraft(uid, published.data, { kind: "updateMeta", ...metaUpdates }),
          );
          if (!edit.ok) {
            const fail = draftEditFailResponse(edit, requestId);
            return c.json(fail.body, fail.status);
          }
          return c.json(edit.view, 200);
        }
        const result = yield* Effect.promise(() => updateDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }, metaUpdates));
        if (!result.ok) {
          const fail = crudFailResponse(result.reason, requestId);
          return c.json(fail.body, fail.status);
        }
      }

      // Return updated dashboard (published view — reflects the
      // parameters/schedule writes above; a draft meta edit returned earlier).
      const updated = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
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
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    // #4537 — the viewer gates the delete: a never-published board 404s for
    // anyone but its creator, exactly like the read paths.
    const result = yield* Effect.promise(() => deleteDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
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
      const { orgId, user } = yield* AuthContext;
      const { id } = c.req.valid("param");
      if (!UUID_RE.test(id)) {
        return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
      }

      // Verify dashboard exists and belongs to org
      const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
      if (!dash.ok) {
        const fail = crudFailResponse(dash.reason, requestId);
        return c.json(fail.body, fail.status);
      }

      const parsed = c.req.valid("json");
      // #3207 — a KPI card requesting an automatic prior-period comparison must
      // filter by both window params, declared as `date`. Reject up front so a
      // misconfigured card can't persist a delta the render path can't produce.
      const addAutoErr = validateAutoComparison(parsed.sql ?? "", parsed.chartConfig?.kpi, dash.data.parameters);
      if (addAutoErr) {
        return c.json({ error: "invalid_request", message: addAutoErr, requestId }, 400);
      }
      // #2424 — same gate as chat.ts: verify the supplied connectionGroupId
      // is owned by the caller's org before persisting it onto the card.
      // Migration 0066's comment explicitly defers org enforcement here.
      if (parsed.connectionGroupId) {
        const verdict = yield* Effect.promise(() =>
          verifyGroupBelongsToOrg(parsed.connectionGroupId!, orgId),
        );
        if (verdict === "not_found") {
          return c.json(
            { error: "invalid_connection_group", message: "The requested environment is not available in this workspace.", requestId },
            400,
          );
        }
        if (verdict === "error") {
          return c.json(
            { error: "internal_error", message: "Could not verify environment ownership. Please retry.", requestId },
            500,
          );
        }
      }
      // #4315 — a new card lands in the caller's private draft, not the
      // published tables. Mint the card id here (as the bound editor does) so
      // subsequent draft edits/layout in the same session resolve, and stage
      // it into the draft snapshot. `cachedColumns`/`cachedRows` are a
      // published-cache concept and are intentionally dropped on the draft
      // path — a draft card's data comes from a draft-aware render.
      // #4318 — a text / section card carries markdown `content`, no SQL. A
      // chart card carries `sql`, no content. The schema's `.superRefine`
      // guarantees the kind-specific fields are present, so `sql ?? ""` and the
      // kind-gated content are always well-formed here.
      const kind = parsed.kind ?? "chart";
      const uid = user?.id;
      if (shouldRouteToDraft(uid)) {
        const draftCard: DashboardSnapshotCard = {
          id: randomUUID(),
          position: 0,
          title: parsed.title,
          // A text card stores sql = '' and content = markdown (#3138).
          sql: parsed.sql ?? "",
          chartConfig: parsed.chartConfig ?? null,
          content: kind === "text" ? parsed.content ?? null : null,
          annotations: parsed.annotations ?? [],
          connectionGroupId: parsed.connectionGroupId ?? null,
          layout: parsed.layout ?? null,
        };
        const edit = yield* Effect.promise(() =>
          applyEditToDraft(uid, dash.data, { kind: "addCard", card: draftCard }),
        );
        if (!edit.ok) {
          const fail = draftEditFailResponse(edit, requestId);
          return c.json(fail.body, fail.status);
        }
        const created = edit.view.cards.find((cd) => cd.id === draftCard.id);
        return c.json(created ?? edit.view, 201);
      }

      const result = yield* Effect.promise(() => addCard({
        dashboardId: id,
        title: parsed.title,
        sql: parsed.sql ?? "",
        chartConfig: parsed.chartConfig ?? null,
        content: kind === "text" ? parsed.content ?? null : null,
        annotations: parsed.annotations ?? [],
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
      const { orgId, user } = yield* AuthContext;
      const { id, cardId } = c.req.valid("param");
      if (!UUID_RE.test(id) || !UUID_RE.test(cardId)) {
        return c.json({ error: "invalid_request", message: "Invalid ID format." }, 400);
      }

      // Verify dashboard ownership
      const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
      if (!dash.ok) {
        const fail = crudFailResponse(dash.reason, requestId);
        return c.json(fail.body, fail.status);
      }

      const parsed = c.req.valid("json");
      const uid = user?.id;
      const routeDraft = shouldRouteToDraft(uid);

      // #3207 / #4318 — if this update turns on autoComparison, validate it
      // against the sql the card WILL have after the edit + the dashboard's
      // params. That's `parsed.sql` when this same PATCH rewrites the query
      // (#4318 made SQL edits reachable here), otherwise the card's existing
      // sql. Source the existing sql from the DRAFT when routing to a draft
      // (the card may only exist in the draft), else the published row.
      if (parsed.chartConfig?.kpi?.autoComparison) {
        let existingSql: string | undefined;
        if (routeDraft) {
          const draft = yield* Effect.promise(() => loadDraft(uid, id));
          existingSql =
            draft?.snapshot.cards.find((cd) => cd.id === cardId)?.sql ??
            dash.data.cards.find((cd) => cd.id === cardId)?.sql;
        } else {
          const existing = yield* Effect.promise(() => getCard(cardId, id));
          if (existing.ok) existingSql = existing.data.sql;
        }
        const effectiveSql = parsed.sql ?? existingSql;
        if (effectiveSql !== undefined) {
          const updateAutoErr = validateAutoComparison(
            effectiveSql,
            parsed.chartConfig.kpi,
            dash.data.parameters,
          );
          if (updateAutoErr) {
            return c.json({ error: "invalid_request", message: updateAutoErr, requestId }, 400);
          }
        }
      }

      // #4315 — the edit lands in the caller's private draft; nothing but
      // publish writes the published card.
      if (routeDraft) {
        const edit = yield* Effect.promise(() =>
          applyEditToDraft(uid, dash.data, { kind: "updateCard", cardId, updates: parsed }),
        );
        if (!edit.ok) {
          const fail = draftEditFailResponse(edit, requestId);
          return c.json(fail.body, fail.status);
        }
        const updated = edit.view.cards.find((cd) => cd.id === cardId);
        return c.json(updated ?? edit.view, 200);
      }

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
    const { orgId, user } = yield* AuthContext;
    const { id, cardId } = c.req.valid("param");
    if (!UUID_RE.test(id) || !UUID_RE.test(cardId)) {
      return c.json({ error: "invalid_request", message: "Invalid ID format." }, 400);
    }

    const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    // #4315 — removing a card removes it from the caller's private draft; the
    // published card is untouched until publish promotes the deletion.
    const uid = user?.id;
    if (shouldRouteToDraft(uid)) {
      const edit = yield* Effect.promise(() =>
        applyEditToDraft(uid, dash.data, { kind: "removeCard", cardId }),
      );
      if (!edit.ok) {
        const fail = draftEditFailResponse(edit, requestId);
        return c.json(fail.body, fail.status);
      }
      return c.body(null, 204);
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
    const { requestId, atlasMode } = yield* RequestContext;
    const { orgId } = yield* AuthContext;
    const { sql, connectionId } = c.req.valid("json");

    // #4318 — verify a client-supplied `connectionId` belongs to the caller's
    // org BEFORE executing. This is the one card-execution surface that took
    // `connectionId` on trust; `addCard` already gates `connectionGroupId` via
    // `verifyGroupBelongsToOrg`. Fail CLOSED: an out-of-org (or unverifiable)
    // connection 403s rather than running against another tenant's datasource.
    // `isConnectionVisibleInMode` fails closed on a DB error and returns true
    // for a self-hosted deploy with no internal DB, so single-tenant self-host
    // is unaffected. Only checked when an org context is present — a self-hosted
    // caller with no org can't cross a tenant boundary that doesn't exist.
    if (connectionId && orgId) {
      const visible = yield* Effect.promise(() =>
        isConnectionVisibleInMode(orgId, connectionId, atlasMode),
      );
      if (!visible) {
        return c.json(
          {
            error: "connection_forbidden",
            message: "The requested connection is not available in this workspace.",
            requestId,
          },
          403,
        );
      }
    }

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
    const { orgId, user } = yield* AuthContext;
    const { id, cardId } = c.req.valid("param");
    if (!UUID_RE.test(id) || !UUID_RE.test(cardId)) {
      return c.json({ error: "invalid_request", message: "Invalid ID format." }, 400);
    }
    const { view } = c.req.valid("query");

    const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    // #4315 / #4554 — draft-aware execution, resolved BEFORE the published-card
    // existence check so a draft-only (never-published) card is refreshable:
    // when the caller is refreshing while viewing their draft, run the DRAFT
    // card's SQL/config (its private working copy). Falls back to published
    // when no draft exists — never another user's draft. Only the published
    // path needs the published row; "Card not found" therefore means
    // not-in-draft-AND-not-published, never merely not-yet-published.
    const resolved = yield* Effect.promise(() =>
      resolveDraftExecCard(user?.id, view, dash.data, cardId),
    );
    if (resolved.kind === "not_in_draft") {
      return c.json({ error: "not_found", message: "Card not found in your draft." }, 404);
    }
    const isDraftExec = resolved.kind === "override";
    let execCard: DashboardCard;
    if (isDraftExec) {
      execCard = resolved.card;
    } else {
      const cardResult = yield* Effect.promise(() => getCard(cardId, id));
      if (!cardResult.ok) {
        return c.json({ error: "not_found", message: "Card not found." }, 404);
      }
      execCard = cardResult.data;
    }

    // #3138: a text / section-block card has no SQL — there's nothing to
    // refresh. Return it unchanged rather than running it through the query
    // pipeline (which would reject an empty query).
    if (execCard.kind === "text") {
      return c.json(execCard, 200);
    }

    // Resolve group-scoped execution. A card pointing at a group with
    // zero members must NOT silently fall back to the workspace
    // default — return a typed 500 with requestId so the admin can
    // see exactly which group needs members.
    let resolvedConnectionId: string | null;
    try {
      resolvedConnectionId = yield* Effect.promise(() =>
        resolveCardConnectionId(
          { connectionGroupId: execCard.connectionGroupId },
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
    // The cached snapshot is rendered with the parameters' DEFAULT values
    // (#2267) — interactive overrides go through the /render endpoint and are
    // never persisted to the shared cache.
    let defaultParamValues: Record<string, string | number | null>;
    try {
      defaultParamValues = resolveDashboardParameterValues(dash.data.parameters, undefined);
    } catch (err) {
      return c.json(
        {
          error: "invalid_parameters",
          message: err instanceof Error ? err.message : "Invalid dashboard parameters.",
          requestId,
        },
        400,
      );
    }

    const { runUserQueryPipeline } = yield* Effect.promise(() => import("@atlas/api/lib/tools/sql"));
    const outcome = yield* Effect.promise(() =>
      runUserQueryPipeline({
        sql: execCard.sql,
        ...(resolvedConnectionId && { connectionId: resolvedConnectionId }),
        explanation: `Dashboard card refresh: ${execCard.title}`,
        parameters: defaultParamValues,
      }),
    );

    if (outcome.kind !== "ok") {
      const { body, status } = userQueryOutcomeToResponse(outcome, requestId);
      return c.json(body as never, status);
    }

    // #4315 / #4554 — a draft refresh runs the draft's SQL but MUST NOT
    // persist to the published card cache: the draft's query is un-published,
    // so writing its results into the shared cache would leak draft data to
    // teammates and violate the "only publish writes published" invariant.
    // The result persists to the caller's DRAFT CACHE (ADR-0034 Decision 1) —
    // the draft card's own data home — so it survives a page reload.
    if (resolved.kind === "override") {
      const saveResult = yield* Effect.promise(() =>
        saveDraftCardCache(resolved.userId, id, cardId, {
          columns: outcome.columns,
          rows: outcome.rows,
        }),
      );
      if (!saveResult.ok) {
        if (saveResult.reason === "no_db") {
          return c.json(
            {
              error: "drafts_unavailable",
              message:
                "Draft refreshes persist to your private draft, which needs the internal database. It is not configured on this deployment.",
              requestId,
            },
            503,
          );
        }
        // `no_draft` = the draft was published/discarded while this refresh
        // ran — a client-state race, not a server fault, so it gets its own
        // 409 + machine-readable code (a 500 here would page on an expected
        // race and force clients to string-match the message). `error` = a
        // genuine transient DB failure → 500. Either way, never silently
        // return unpersisted rows as if they were saved.
        if (saveResult.reason === "no_draft") {
          return c.json(
            {
              error: "draft_gone",
              message:
                "Your draft was published or discarded while this refresh ran. Reload the dashboard and retry.",
              requestId,
            },
            409,
          );
        }
        return c.json(
          {
            error: "internal_error",
            message: "Could not save the refreshed data to your draft. Please retry.",
            requestId,
          },
          500,
        );
      }
      return c.json(
        {
          ...execCard,
          cachedColumns: outcome.columns,
          cachedRows: outcome.rows,
          cachedAt: saveResult.cachedAt,
        },
        200,
      );
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
// POST /:id/cards/:cardId/render — render a card with parameter values (#2267)
//
// View-time, parameter-aware execution. Resolves the supplied values (falling
// back to per-parameter defaults) against the dashboard's declared parameters,
// binds them server-side through the SQL pipeline, and returns the rows
// WITHOUT touching the persisted card cache.
// ---------------------------------------------------------------------------

authed.openapi(renderCardRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id, cardId } = c.req.valid("param");
    if (!UUID_RE.test(id) || !UUID_RE.test(cardId)) {
      return c.json({ error: "invalid_request", message: "Invalid ID format." }, 400);
    }
    const { format, view } = c.req.valid("query");
    const asCsv = format === "csv";
    // #4318 — a body-less render is valid: fall back to `{}` (→ every parameter
    // resolves to its default) rather than throwing on `undefined`. Mirrors the
    // `export` route's `?? {}`.
    const { parameters: suppliedParameters } = c.req.valid("json") ?? {};

    const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    // #4315 / #4554 — draft-aware execution, resolved BEFORE the published-card
    // existence check so a draft-only (never-published) card renders, binds
    // parameters, retries, and exports. When rendering while viewing the draft,
    // run the DRAFT card's SQL/config (never persisted — render is ephemeral),
    // else the published definition. Falls back to published when no draft.
    // "Card not found" means not-in-draft-AND-not-published.
    const resolved = yield* Effect.promise(() =>
      resolveDraftExecCard(user?.id, view, dash.data, cardId),
    );
    if (resolved.kind === "not_in_draft") {
      return c.json({ error: "not_found", message: "Card not found in your draft." }, 404);
    }
    let execCard: DashboardCard;
    if (resolved.kind === "override") {
      execCard = resolved.card;
    } else {
      const cardResult = yield* Effect.promise(() => getCard(cardId, id));
      if (!cardResult.ok) {
        return c.json({ error: "not_found", message: "Card not found." }, 404);
      }
      execCard = cardResult.data;
    }

    // #3138: a text card has no query — render returns an empty result set
    // (no parameters bind, no SQL runs). The tile renders its markdown, not
    // this payload.
    if (execCard.kind === "text") {
      // #3210 — a text card has no tabular data to export. The UI never offers
      // the affordance on text tiles; reject here too (defence in depth) rather
      // than streaming an empty CSV.
      if (asCsv) {
        return c.json(
          { error: "not_exportable", message: "Text cards have no tabular data to export.", requestId },
          400,
        );
      }
      return c.json({ columns: [], rows: [], truncated: false, rowCount: 0, executionMs: 0 }, 200);
    }

    // Resolve + coerce the viewer's values against the declared parameters.
    // Bad values (wrong type, unparseable default) fail closed with a 400 —
    // they never reach SQL.
    let paramValues: Record<string, string | number | null>;
    try {
      paramValues = resolveDashboardParameterValues(dash.data.parameters, suppliedParameters);
    } catch (err) {
      return c.json(
        {
          error: "invalid_parameters",
          message: err instanceof Error ? err.message : "Invalid dashboard parameters.",
          requestId,
        },
        400,
      );
    }

    let resolvedConnectionId: string | null;
    try {
      resolvedConnectionId = yield* Effect.promise(() =>
        resolveCardConnectionId(
          { connectionGroupId: execCard.connectionGroupId },
          dash.data.orgId,
        ),
      );
    } catch (err) {
      if (err instanceof NoGroupMembersError) {
        log.warn({ cardId, groupId: err.groupId, orgId: err.orgId, requestId }, "Card render: group has no members");
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

    // #3137 / #3207 — a KPI card's optional comparison runs as a SECOND query
    // through the SAME pipeline (validation + auto-LIMIT + statement timeout +
    // RLS + audit). Both queries run in parallel — no waterfall. The comparison
    // is NEVER string-interpolated; the UI computes the delta from the two
    // numbers. There are two ways to source the comparison, never both:
    //   - `comparisonSql` (#3137): a hand-written second query, bound to the
    //     SAME parameter values as the primary.
    //   - `autoComparison` (#3207): re-run the card's OWN sql with the bound
    //     date window shifted back one period (derived server-side; the prior
    //     window binds through the same parameter protocol).
    const chartConfig = execCard.chartConfig;
    const kpi = chartConfig?.type === "kpi" ? chartConfig.kpi : undefined;
    const comparisonSql = kpi?.comparisonSql;

    // Resolve the effective comparison query + its bind values. Default: the
    // hand-written `comparisonSql` against the primary param values.
    let comparisonRunSql = comparisonSql;
    let comparisonParamValues = paramValues;
    if (!comparisonSql && kpi?.autoComparison) {
      const priorValues = derivePriorPeriodValues(paramValues, kpi.comparisonDateParams);
      if (priorValues) {
        comparisonRunSql = execCard.sql;
        comparisonParamValues = priorValues;
      } else {
        // No derivable prior window (a bound is missing/unparseable, or the
        // range is inverted/empty). Render the headline number with no delta
        // chip rather than failing — but say why (never silently swallowed).
        log.warn(
          { cardId, requestId },
          "KPI autoComparison requested but no prior-period window could be derived — delta chip omitted",
        );
      }
    }

    const { runUserQueryPipeline } = yield* Effect.promise(() => import("@atlas/api/lib/tools/sql"));
    const [outcome, comparisonOutcome] = yield* Effect.promise(() =>
      Promise.all([
        runUserQueryPipeline({
          sql: execCard.sql,
          ...(resolvedConnectionId && { connectionId: resolvedConnectionId }),
          explanation: `Dashboard card render: ${execCard.title}`,
          parameters: paramValues,
        }),
        // The comparison is isolated with its own `.catch`: `runUserQueryPipeline`
        // maps every TYPED pipeline error to a `UserQueryOutcome` variant, but an
        // unexpected DEFECT (a throw outside that channel) would otherwise reject
        // the whole `Promise.all` and 500 the primary render. Degrade an
        // unexpected throw to `null` so a broken comparison never breaks the
        // headline number — but log it (never silently swallowed).
        comparisonRunSql
          ? runUserQueryPipeline({
              sql: comparisonRunSql,
              ...(resolvedConnectionId && { connectionId: resolvedConnectionId }),
              explanation: `Dashboard KPI comparison: ${execCard.title}`,
              parameters: comparisonParamValues,
            }).catch((err) => {
              log.warn(
                { cardId, requestId, err: err instanceof Error ? err.message : String(err) },
                "KPI comparison query threw — delta chip omitted",
              );
              return null;
            })
          : Promise.resolve(null),
      ]),
    );

    // #3210 — CSV export. Reuses the IDENTICAL parameter-bound pipeline result
    // above (validation + auto-LIMIT + statement timeout + RLS + audit); it
    // never opens a second SQL path. On success, stream the rows as a `text/csv`
    // attachment with a title-derived filename. Any non-`ok` outcome falls
    // through to the shared JSON error response below so the client can read the
    // `{ error, message, requestId }` envelope regardless of `format`.
    if (asCsv && outcome.kind === "ok") {
      const csv = toCsv(outcome.columns, outcome.rows);
      const filename = csvFilename(execCard.title, new Date());
      return new Response(csv, {
        status: 200,
        headers: {
          // A raw `Response` returned from the handler does NOT inherit the
          // `c.header()`-set CORS headers from the `/api/*` middleware (Hono
          // doesn't merge prepared headers onto a handler-returned Response),
          // so spread them on explicitly — otherwise a cross-origin deploy
          // (app.* → api.*) can't read the file or the `X-Atlas-Truncated`
          // header. Same pattern as the chat/demo streaming responses.
          ...corsResponseHeaders(c.req.header("Origin") ?? ""),
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          // Parameter-varying, one-shot artifact — never cache.
          "Cache-Control": "no-store",
          // Surface auto-LIMIT truncation so the client can warn the export is
          // capped (the same row cap as the on-screen render — no unbounded dump).
          "X-Atlas-Truncated": outcome.truncated ? "1" : "0",
          "X-Atlas-Row-Count": String(outcome.rowCount),
        },
      });
    }

    const { body, status } = userQueryOutcomeToResponse(outcome, requestId);
    // Attach the comparison only when the primary succeeded AND a comparison
    // query was configured/derived. A failed comparison degrades to `null` (the
    // delta chip is dropped) rather than failing the whole KPI render — but it's
    // logged, never silently swallowed.
    if (outcome.kind === "ok" && comparisonRunSql) {
      if (comparisonOutcome && comparisonOutcome.kind === "ok") {
        (body as Record<string, unknown>).comparison = {
          columns: comparisonOutcome.columns,
          rows: comparisonOutcome.rows,
        };
      } else {
        (body as Record<string, unknown>).comparison = null;
        log.warn(
          { cardId, requestId, comparisonKind: comparisonOutcome?.kind },
          "KPI comparison query did not succeed — delta chip omitted",
        );
      }
    }
    return c.json(body as never, status);
  }), { label: "render card" });
});

// ---------------------------------------------------------------------------
// POST /:id/refresh — refresh all cards
// ---------------------------------------------------------------------------

authed.openapi(refreshAllCardsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }
    const { view } = c.req.valid("query");

    const dashResult = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
    if (!dashResult.ok) {
      const fail = crudFailResponse(dashResult.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    // #4559 — draft-aware bulk refresh. When the caller runs Refresh-all while
    // viewing their draft, execute the DRAFT cards' SQL/config (their private
    // working copies) and persist each result to the caller's DRAFT CACHE —
    // never the published cards' shared cache. Mirrors the single-card refresh's
    // draft branch (#4554). `loadDraft` returning null (no draft, or a
    // swallowed load error) falls back to the published cards exactly as a
    // published-view refresh does — never another user's draft. The draft view
    // is materialized WITHOUT the draft cache (`EMPTY_DRAFT_CARD_CACHE`) because
    // execution needs only each card's definition, not its cached rows.
    const uid = user?.id;
    let draftHolderId: string | null = null;
    let cards = dashResult.data.cards;
    if (view === "draft" && shouldRouteToDraft(uid)) {
      const draft = yield* Effect.promise(() => loadDraft(uid, id));
      if (draft) {
        draftHolderId = uid;
        cards = materializeDraftView(dashResult.data, draft.snapshot, EMPTY_DRAFT_CARD_CACHE).cards;
      }
    }

    // Bulk refresh persists each card's snapshot with the parameters' DEFAULT
    // values (#2267). A malformed default fails the whole refresh up front
    // rather than per-card.
    let defaultParamValues: Record<string, string | number | null>;
    try {
      defaultParamValues = resolveDashboardParameterValues(dashResult.data.parameters, undefined);
    } catch (err) {
      return c.json(
        {
          error: "invalid_parameters",
          message: err instanceof Error ? err.message : "Invalid dashboard parameters.",
          requestId,
        },
        400,
      );
    }

    const { runUserQueryPipeline } = yield* Effect.promise(() => import("@atlas/api/lib/tools/sql"));
    let refreshed = 0;
    let failed = 0;
    const errors: Array<{ cardId: string; cardTitle: string; reason: string; message: string }> = [];

    // Sequential to avoid overloading the source. Each card flows through
    // the full pipeline (validation + approval + RLS + audit) — the bulk
    // entry point is not a license to skip per-query governance.
    for (const card of cards) {
      // #3138: text / section-block cards have no SQL — skip them (counted in
      // `total` but never refreshed/failed).
      if (card.kind === "text") continue;
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
          parameters: defaultParamValues,
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

      // #4559 — a draft bulk-refresh writes the caller's DRAFT CACHE, never the
      // published card cache (which would leak un-published rows to teammates
      // and violate "only publish writes published"). A `no_db`/`no_draft`
      // failure means the draft is structurally gone for EVERY remaining card,
      // so bail the whole operation with the same typed codes the single-card
      // refresh returns rather than churning per-card failures — never silently
      // return unpersisted rows as saved.
      if (draftHolderId) {
        const saveResult = yield* Effect.promise(() =>
          saveDraftCardCache(draftHolderId, id, card.id, {
            columns: outcome.columns,
            rows: outcome.rows,
          }),
        );
        if (saveResult.ok) {
          refreshed++;
          continue;
        }
        if (saveResult.reason === "no_db") {
          return c.json(
            {
              error: "drafts_unavailable",
              message:
                "Draft refreshes persist to your private draft, which needs the internal database. It is not configured on this deployment.",
              requestId,
            },
            503,
          );
        }
        if (saveResult.reason === "no_draft") {
          return c.json(
            {
              error: "draft_gone",
              message:
                "Your draft was published or discarded while this refresh ran. Reload the dashboard and retry.",
              requestId,
            },
            409,
          );
        }
        // A genuine transient DB write error for THIS card — count it as a
        // per-card failure and keep draining the rest (the published branch
        // treats a persist failure the same way).
        failed++;
        errors.push({
          cardId: card.id,
          cardTitle: card.title,
          reason: "persist_failed",
          message: saveResult.reason,
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
      const { orgId, user } = yield* AuthContext;
      const { id } = c.req.valid("param");
      if (!UUID_RE.test(id)) {
        return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
      }

      // Fail CLOSED on the share config (#4317). The body is optional — an
      // ABSENT/empty body uses the safe defaults — but a PRESENT-yet-invalid
      // body must return 400, never fall through to defaults. The old
      // parse-then-swallow path silently downgraded an org-intended share to
      // `shareMode: "public"` on any validation error.
      let parsed: z.infer<typeof ShareSchema> = {};
      // Read the raw body via tryPromise so a STREAM/READ failure (aborted or
      // truncated request, encoding error) surfaces on the error channel rather
      // than becoming a defect. It must NOT be folded into "empty body" — doing
      // so would let a failed read of `{ shareMode: "org" }` fall through to the
      // public default. `null` is the read-failure sentinel (`c.req.text()`
      // always yields a string, so it is unambiguous). Fail closed with 400.
      const rawBody = yield* Effect.tryPromise({
        try: () => c.req.text(),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.catchAll((err) => {
          log.debug({ requestId, err: err.message }, "Share body read failed — rejecting (fail closed, never downgrade to public)");
          return Effect.succeed(null);
        }),
      );
      if (rawBody === null) {
        return c.json({ error: "invalid_request", message: "Could not read the share configuration body. Please retry." }, 400);
      }
      if (rawBody.trim().length > 0) {
        let json: unknown;
        try {
          json = JSON.parse(rawBody);
        } catch (err) {
          log.debug({ requestId, err: err instanceof Error ? err.message : String(err) }, "Share body is not valid JSON");
          return c.json({ error: "invalid_request", message: "Share configuration must be valid JSON." }, 400);
        }
        const validated = ShareSchema.safeParse(json);
        if (!validated.success) {
          log.debug(
            { requestId, issues: validated.error.issues.map((i) => i.path.join(".")) },
            "Share body failed validation — rejecting (fail closed, never downgrade to public)",
          );
          return c.json(
            { error: "invalid_request", message: "Invalid share configuration. Check the expiresIn, shareMode, and rotate values." },
            400,
          );
        }
        parsed = validated.data;
      }

      const result = yield* Effect.promise(() => shareDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }, {
        expiresIn: parsed.expiresIn ?? null,
        shareMode: parsed.shareMode ?? "public",
        rotate: parsed.rotate ?? false,
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
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const result = yield* Effect.promise(() => unshareDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
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
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const result = yield* Effect.promise(() => getShareStatus(id, { orgId, viewerId: user?.id ?? "anonymous" }));
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
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
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

    // Optionally load learned patterns for extra context. Scope to the
    // dashboard's connection group (#3611) — dashboards are group-scoped
    // (migration 0066) and cards share a group, so use the first card's group.
    // Without this the suggestion path would only ever see default-scope
    // (connection_group_id IS NULL) patterns once getApprovedPatterns filters
    // by group.
    const dashboardGroupId = dash.data.cards[0]?.connectionGroupId ?? null;
    const { buildLearnedPatternsSection } = yield* Effect.promise(() => import("@atlas/api/lib/learn/pattern-cache"));
    const patternsSection = yield* Effect.tryPromise({
      try: () => buildLearnedPatternsSection(orgId ?? null, "dashboard suggestions", dashboardGroupId),
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

// ---------------------------------------------------------------------------
// GET /:id/sessions — list archived bound chat sessions for the dashboard
// (#2368 — History tab in the bound chat drawer)
// ---------------------------------------------------------------------------

authed.openapi(listDashboardSessionsRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }

    // Org-scoped dashboard existence check — anyone in the workspace who
    // can read the dashboard sees the same sessions list (matches current
    // dashboard ACL per PRD #2362, user stories 21/22). Failing the
    // dashboard lookup here doubles as the cross-org safety net.
    const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    const sessions = yield* Effect.promise(() =>
      listSessionsForDashboard(id, orgId),
    );
    return c.json({ sessions }, 200);
  }), { label: "list dashboard sessions" });
});

// ---------------------------------------------------------------------------
// GET /:id/sessions/:sessionId — read one bound chat session transcript
// (#2368 — read-only transcript panel)
// ---------------------------------------------------------------------------

authed.openapi(getDashboardSessionRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id, sessionId } = c.req.valid("param");
    if (!UUID_RE.test(id) || !UUID_RE.test(sessionId)) {
      return c.json({ error: "invalid_request", message: "Invalid ID format." }, 400);
    }

    // First gate: the dashboard must belong to caller's org. Without this,
    // a 404 from getSessionTranscript would still leak the org-id mapping
    // of a guessed dashboardId (a cross-org session lookup returns
    // "not_found" too).
    const dash = yield* Effect.promise(() => getDashboard(id, { orgId, viewerId: user?.id ?? "anonymous" }));
    if (!dash.ok) {
      const fail = crudFailResponse(dash.reason, requestId);
      return c.json(fail.body, fail.status);
    }

    // Second gate: the conversation must be bound to this dashboard AND
    // in the same org. `getSessionTranscript` enforces both — workspace-
    // wide read (no per-user ownership check) is intentional and matches
    // the dashboard ACL.
    const result = yield* Effect.promise(() =>
      getSessionTranscript(id, sessionId, orgId),
    );
    if (!result.ok) {
      switch (result.reason) {
        case "no_db":
          return c.json({ error: "not_available", message: "Conversation history is not available." }, 404);
        case "not_found":
          return c.json({ error: "not_found", message: "Session not found." }, 404);
        case "error":
          return c.json({ error: "internal_error", message: "Could not load session transcript. Please retry.", requestId }, 500);
        default: {
          const _exhaustive: never = result.reason;
          return c.json({ error: "internal_error", message: `Unhandled: ${String(_exhaustive)}`, requestId }, 500);
        }
      }
    }
    return c.json(result.data, 200);
  }), { label: "get dashboard session transcript" });
});

// ---------------------------------------------------------------------------
// GET /:id/screenshot — render PNG (#2367)
// ---------------------------------------------------------------------------

authed.openapi(screenshotDashboardRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }
    if (!user?.id) {
      // Defence-in-depth — authed should already block this path, but
      // the screenshot cache key requires a stable userId so refuse
      // explicitly rather than caching under "anonymous".
      return c.json({ error: "auth_required", message: "Authentication required for screenshots.", requestId }, 401);
    }

    const result = yield* Effect.promise(() =>
      screenshotDashboard({
        dashboardId: id,
        userId: user.id,
        orgId,
        cookieHeader: c.req.raw.headers.get("cookie"),
      }),
    );
    if (!result.ok) {
      switch (result.reason) {
        case "no_db":
          // Internal DB unavailable — infra failure, not a missing
          // resource. 503 + Retry-After so callers retry instead of
          // treating it as a 404.
          return c.json(
            { error: "not_available", message: result.message, requestId },
            503,
            { "Retry-After": "5" },
          );
        case "dashboard_not_found":
          return c.json({ error: "not_found", message: result.message, requestId }, 404);
        case "dashboard_unavailable":
          // Snapshot lookup failed with a non-not-found reason (DB error,
          // unknown failure mode). 503 so paging surfaces it correctly;
          // distinct from `render_failed` which is a Playwright problem.
          return c.json(
            { error: "dashboard_unavailable", message: result.message, requestId },
            503,
            { "Retry-After": "5" },
          );
        case "browser_unavailable":
          return c.json({ error: "browser_unavailable", message: result.message, requestId }, 503);
        case "render_failed":
          return c.json({ error: "render_failed", message: result.message, requestId }, 500);
        default: {
          const _exhaustive: never = result.reason;
          return c.json({ error: "internal_error", message: `Unhandled: ${String(_exhaustive)}`, requestId }, 500);
        }
      }
    }

    return new Response(new Uint8Array(result.png), {
      status: 200,
      headers: {
        // A raw `Response` returned from the handler does NOT inherit the
        // `c.header()`-set CORS headers from the `/api/*` middleware (Hono
        // doesn't merge prepared headers onto a handler-returned Response),
        // so spread them on explicitly — otherwise a cross-origin deploy
        // (app.* → api.*) can't read the image. Same pattern as the CSV
        // export branch and the chat/demo streaming responses (#3222).
        ...corsResponseHeaders(c.req.header("Origin") ?? ""),
        "Content-Type": "image/png",
        "Content-Length": String(result.png.length),
        // Short caller-side cache; the server-side LRU is the primary
        // win. `private` because the PNG is scoped to the user (#2364
        // forward-compat).
        "Cache-Control": "private, max-age=10",
        "X-Atlas-Screenshot-Cached": result.cached ? "1" : "0",
        "X-Atlas-Screenshot-Duration-Ms": String(result.durationMs),
      },
    });
  }), { label: "screenshot dashboard" });
});

// ---------------------------------------------------------------------------
// POST /:id/export — whole-dashboard PNG / PDF export (#3211)
// ---------------------------------------------------------------------------

authed.openapi(exportDashboardRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    const { orgId, user } = yield* AuthContext;
    const { id } = c.req.valid("param");
    if (!UUID_RE.test(id)) {
      return c.json({ error: "invalid_request", message: "Invalid dashboard ID format." }, 400);
    }
    if (!user?.id) {
      // Defence-in-depth — `authed` already blocks anonymous access, but the
      // headless render forwards the caller's identity/cookie, so refuse
      // explicitly rather than rendering under an undefined user.
      return c.json({ error: "auth_required", message: "Authentication required for dashboard export.", requestId }, 401);
    }

    // Body is optional (export with parameter defaults when omitted); coalesce
    // so a bodyless request resolves to a PDF of the default-parameter board.
    const body = (c.req.valid("json") ?? {}) as {
      format?: "png" | "pdf";
      parameters?: Record<string, string | number | null>;
    };
    const format = body.format ?? "pdf";

    // The request's own origin is the public API host the rendered page's
    // credentialed fetches target — forward it so cross-origin deploys seed the
    // session cookie for the API host too (not just the web host).
    let apiBaseUrl: string | undefined;
    try {
      apiBaseUrl = new URL(c.req.url).origin;
    } catch {
      // Unparseable request URL — fall back to web-host-only cookie seeding.
      apiBaseUrl = undefined;
    }

    const result = yield* Effect.promise(() =>
      exportDashboard({
        dashboardId: id,
        userId: user.id,
        orgId,
        format,
        parameters: body.parameters ?? null,
        cookieHeader: c.req.raw.headers.get("cookie"),
        apiBaseUrl,
      }),
    );

    if (!result.ok) {
      switch (result.reason) {
        case "no_db":
          return c.json(
            { error: "not_available", message: result.message, requestId },
            503,
            { "Retry-After": "5" },
          );
        case "dashboard_not_found":
          return c.json({ error: "not_found", message: result.message, requestId }, 404);
        case "dashboard_unavailable":
          return c.json(
            { error: "dashboard_unavailable", message: result.message, requestId },
            503,
            { "Retry-After": "5" },
          );
        case "invalid_parameters":
          // Supplied an override that fails its declared parameter's type
          // (e.g. a non-date for a date param). Fail closed with a 400 rather
          // than silently exporting the default-parameter board.
          return c.json({ error: "invalid_parameters", message: result.message, requestId }, 400);
        case "browser_unavailable":
          return c.json({ error: "browser_unavailable", message: result.message, requestId }, 503);
        case "export_timeout":
          // Distinct from render_failed — the render was simply too slow, so
          // 504 + Retry-After invites a retry rather than signalling a bug.
          return c.json(
            { error: "export_timeout", message: result.message, requestId },
            504,
            { "Retry-After": "5" },
          );
        case "render_failed":
          return c.json({ error: "render_failed", message: result.message, requestId }, 500);
        default: {
          const _exhaustive: never = result.reason;
          return c.json({ error: "internal_error", message: `Unhandled: ${String(_exhaustive)}`, requestId }, 500);
        }
      }
    }

    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        // A raw `Response` returned from the handler does NOT inherit the
        // `c.header()`-set CORS headers from the `/api/*` middleware (Hono
        // doesn't merge prepared headers onto a handler-returned Response),
        // so spread them on explicitly — otherwise a cross-origin deploy
        // (app.* → api.*) can't read the file, and `X-Atlas-Export-Partial`
        // / `Content-Disposition` aren't exposed to JS. Same pattern as the
        // CSV export branch and the chat/demo streaming responses (#3222).
        ...corsResponseHeaders(c.req.header("Origin") ?? ""),
        "Content-Type": result.contentType,
        "Content-Length": String(result.bytes.length),
        // Filename is an ASCII slug + UTC stamp (see buildExportFilename), so a
        // plain `filename=` is safe — no RFC 5987 encoding needed.
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        // Exports are one-shot, parameter-varying artifacts — never cache.
        "Cache-Control": "no-store",
        // Surface partial renders so the client can warn the file may be
        // incomplete (a stuck tile doesn't fail the whole export).
        "X-Atlas-Export-Partial": result.partial ? "1" : "0",
        "X-Atlas-Export-Duration-Ms": String(result.durationMs),
      },
    });
  }), { label: "export dashboard" });
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

  // Key the limiter on the REAL viewer's IP, not the web-server IP (#4317).
  // The shared page is server-rendered, so its RSC fetch reaches us from the
  // web tier — it forwards the viewer's `x-forwarded-for`. When ATLAS_TRUST_PROXY
  // is set, `getClientIP` resolves that to the viewer, giving each viewer its
  // own bucket; when it is unset, `getClientIP` returns null and all viewers
  // fall back to the single anonymous ceiling (see F-73 below).
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
      // Every 500 carries requestId for log correlation (CLAUDE.md). The other
      // fail reasons map to 4xx (404/410) and don't need it.
      return c.json({ ...fail.body, requestId }, fail.status);
    }
    return c.json(fail.body, fail.status);
  }

  // Org-scoped shares require authentication. Gating reads `result.access`
  // (which carries the internal `orgId`); the response only ever serializes
  // `result.view` — the data-only DTO — so the org id can't leak (#4316).
  if (result.access.shareMode === "org") {
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
    if (!result.access.orgId || authResult.user?.activeOrganizationId !== result.access.orgId) {
      log.warn(
        {
          requestId,
          tokenHash,
          hasOrgId: Boolean(result.access.orgId),
          actorUserId: authResult.user?.id,
          actorOrgId: authResult.user?.activeOrganizationId,
        },
        "Org-scoped dashboard share access denied — requester is not a member of the dashboard's org",
      );
      return c.json({ error: "forbidden", message: "You do not have access to this dashboard.", requestId }, 403);
    }
  }

  // Both public and org modes serialize the SAME projection — the minimal,
  // data-only snapshot with no sql / internal ids / parameter definitions.
  return c.json(result.view, 200);
});

export { dashboards, publicDashboards };

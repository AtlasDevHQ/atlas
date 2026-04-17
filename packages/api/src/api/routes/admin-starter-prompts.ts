/**
 * Admin starter-prompt moderation routes.
 *
 * Mounted under /api/v1/admin/starter-prompts. All routes require admin role.
 * Queue reads and the approve / hide / unhide / author mutations live here.
 * The canonical state-matrix explainer lives with the policy in
 * `@atlas/api/lib/suggestions/approval-service`.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect, runHandler } from "@atlas/api/lib/effect/hono";
import { AuthContext } from "@atlas/api/lib/effect/services";
import { queryEffect } from "@atlas/api/lib/db/internal";
import type { QuerySuggestionRow } from "@atlas/api/lib/db/internal";
import { toQuerySuggestion } from "@atlas/api/lib/learn/suggestion-helpers";
import { getConfig } from "@atlas/api/lib/config";
import {
  DEFAULT_AUTO_PROMOTE_CLICKS,
  DEFAULT_COLD_WINDOW_DAYS,
  SUGGESTION_APPROVAL_STATUSES,
  SUGGESTION_STATUSES,
} from "@atlas/api/lib/suggestions/approval-service";
import {
  approveSuggestion,
  hideSuggestion,
  unhideSuggestion,
  createApprovedSuggestion,
  DuplicateSuggestionError,
  InvalidSuggestionTextError,
  SUGGESTION_TEXT_MAX_LENGTH,
} from "@atlas/api/lib/suggestions/approval-store";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-starter-prompts");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const QueueItemSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  description: z.string(),
  patternSql: z.string(),
  normalizedHash: z.string(),
  tablesInvolved: z.array(z.string()),
  primaryTable: z.string().nullable(),
  frequency: z.number(),
  clickedCount: z.number(),
  distinctUserClicks: z.number(),
  score: z.number(),
  approvalStatus: z.enum(SUGGESTION_APPROVAL_STATUSES),
  status: z.enum(SUGGESTION_STATUSES),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const QueueResponseSchema = z.object({
  pending: z.array(QueueItemSchema),
  approved: z.array(QueueItemSchema),
  hidden: z.array(QueueItemSchema),
  counts: z.object({
    pending: z.number().int(),
    approved: z.number().int(),
    hidden: z.number().int(),
  }),
  threshold: z.number().int(),
  coldWindowDays: z.number().int(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listQueueRoute = createRoute({
  method: "get",
  path: "/queue",
  tags: ["Admin — Starter Prompts"],
  summary: "Get starter-prompt moderation queue",
  description:
    "Returns pending, approved, and hidden starter-prompt suggestions for the admin's organization. The `pending` bucket filters to suggestions that crossed the auto-promote click threshold within the cold window.",
  responses: {
    200: {
      description: "Moderation queue buckets",
      content: { "application/json": { schema: QueueResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
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

export const adminStarterPrompts = createAdminRouter();

adminStarterPrompts.use(requireOrgContext());

adminStarterPrompts.openapi(listQueueRoute, async (c) => {
  return runEffect(c, Effect.gen(function* () {
    const { orgId } = yield* AuthContext;

    const orgIdVal = orgId ?? null;
    const config = getConfig();
    const threshold = config?.starterPrompts?.autoPromoteClicks ?? DEFAULT_AUTO_PROMOTE_CLICKS;
    const coldWindowDays = config?.starterPrompts?.coldWindowDays ?? DEFAULT_COLD_WINDOW_DAYS;

    const orgClause = orgIdVal != null ? "org_id = $1" : "org_id IS NULL";
    const baseParams: unknown[] = orgIdVal != null ? [orgIdVal] : [];
    const thresholdIdx = baseParams.length + 1;
    const windowIdx = baseParams.length + 2;
    const pendingParams = [...baseParams, threshold, coldWindowDays];

    // Pending bucket filters to rows that crossed the threshold within
    // the cold window. `last_seen_at` is the most recent pattern-match
    // timestamp — rows with older activity have aged out.
    const pendingQuery = queryEffect<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions
       WHERE ${orgClause}
         AND approval_status = 'pending'
         AND distinct_user_clicks >= $${thresholdIdx}
         AND last_seen_at >= NOW() - ($${windowIdx} || ' days')::interval
       ORDER BY distinct_user_clicks DESC, last_seen_at DESC
       LIMIT 200`,
      pendingParams,
    );

    const approvedQuery = queryEffect<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions
       WHERE ${orgClause} AND approval_status = 'approved'
       ORDER BY approved_at DESC NULLS LAST, last_seen_at DESC
       LIMIT 200`,
      baseParams,
    );

    const hiddenQuery = queryEffect<QuerySuggestionRow>(
      `SELECT * FROM query_suggestions
       WHERE ${orgClause} AND approval_status = 'hidden'
       ORDER BY updated_at DESC
       LIMIT 200`,
      baseParams,
    );

    const [pendingRows, approvedRows, hiddenRows] = yield* Effect.all(
      [pendingQuery, approvedQuery, hiddenQuery],
      { concurrency: "unbounded" },
    );

    const pending = pendingRows.map(toQuerySuggestion);
    const approved = approvedRows.map(toQuerySuggestion);
    const hidden = hiddenRows.map(toQuerySuggestion);

    return c.json(
      {
        pending,
        approved,
        hidden,
        counts: {
          pending: pending.length,
          approved: approved.length,
          hidden: hidden.length,
        },
        threshold,
        coldWindowDays,
      },
      200,
    );
  }), { label: "list starter-prompt moderation queue" });
});

// ---------------------------------------------------------------------------
// Mutation schemas (shared across approve/hide/unhide/author)
// ---------------------------------------------------------------------------

const SuggestionIdParamSchema = z.object({
  id: z.string().min(1).max(128).openapi({
    param: { name: "id", in: "path" },
    example: "sug-123",
  }),
});

const SuggestionResponseSchema = z.object({
  suggestion: QueueItemSchema,
});

const AuthorBodySchema = z.object({
  text: z
    .string()
    .min(1, "Starter prompt text must not be empty")
    .max(SUGGESTION_TEXT_MAX_LENGTH),
});

// ---------------------------------------------------------------------------
// Shared mutation response definitions — approve/hide/unhide share the same
// 200/401/403/404/429/500 shape. `author` overrides responses (adds 400/409,
// drops the :id path).
// ---------------------------------------------------------------------------

function mutationResponses(
  summaryNotFound: string,
): Record<number, {
  description: string;
  content: { "application/json": { schema: unknown } };
}> {
  return {
    200: {
      description: "Suggestion after the mutation",
      content: { "application/json": { schema: SuggestionResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required, or suggestion in another org",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: summaryNotFound,
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
  };
}

// ---------------------------------------------------------------------------
// Route definitions — mutations
// ---------------------------------------------------------------------------

const approveRoute = createRoute({
  method: "post",
  path: "/{id}/approve",
  tags: ["Admin — Starter Prompts"],
  summary: "Approve a pending starter-prompt suggestion",
  description:
    "Moves a suggestion from pending → approved. Stamps `approved_by` with the " +
    "admin's user id and `approved_at` with the current timestamp. Idempotent — " +
    "re-approving an already-approved row bumps `approved_at` only.",
  request: { params: SuggestionIdParamSchema },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutationResponses() returns a generic record; cast to satisfy createRoute's strict schema typing without losing the sharing benefit
  responses: mutationResponses("Suggestion not found") as any,
});

const hideRoute = createRoute({
  method: "post",
  path: "/{id}/hide",
  tags: ["Admin — Starter Prompts"],
  summary: "Hide an approved or pending starter-prompt suggestion",
  description:
    "Flips `approval_status` to `hidden`. Reversible via the unhide endpoint. " +
    "Preserves `approved_by` / `approved_at` so hide → unhide does not lose history.",
  request: { params: SuggestionIdParamSchema },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutationResponses() returns a generic record; cast to satisfy createRoute's strict schema typing
  responses: mutationResponses("Suggestion not found") as any,
});

const unhideRoute = createRoute({
  method: "post",
  path: "/{id}/unhide",
  tags: ["Admin — Starter Prompts"],
  summary: "Return a hidden suggestion to the pending queue",
  description:
    "Flips `approval_status` to `pending` so the suggestion can be re-reviewed. " +
    "The auto-promote policy will not re-promote it back to pending on its own " +
    "once hidden — this endpoint is the only path back into review.",
  request: { params: SuggestionIdParamSchema },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutationResponses() returns a generic record; cast to satisfy createRoute's strict schema typing
  responses: mutationResponses("Suggestion not found") as any,
});

const authorRoute = createRoute({
  method: "post",
  path: "/author",
  tags: ["Admin — Starter Prompts"],
  summary: "Author a new starter prompt directly (skips pending queue)",
  description:
    "Creates a new `query_suggestions` row with `approval_status = 'approved'` " +
    "and `status = 'published'` so the admin can seed the empty state without " +
    "waiting for organic engagement. Duplicate text (same `normalized_hash` in " +
    "this org) returns 409 — approve or unhide the existing row instead.",
  request: {
    body: { content: { "application/json": { schema: AuthorBodySchema } } },
  },
  responses: {
    200: {
      description: "Newly authored approved suggestion",
      content: { "application/json": { schema: SuggestionResponseSchema } },
    },
    400: {
      description: "Invalid input (empty or too-long text)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    409: {
      description: "Duplicate text — an existing suggestion already uses it",
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
// Handlers
// ---------------------------------------------------------------------------

/**
 * Map the store's 3-way outcome onto an HTTP response. Keeps the three
 * mutation handlers terse and identical in shape — only the verb in the
 * 404 message differs between them.
 */
function respondApprovalResult(
  c: Parameters<Parameters<typeof adminStarterPrompts.openapi>[1]>[0],
  outcome: Awaited<ReturnType<typeof approveSuggestion>>,
  requestId: string,
  verb: "approve" | "hide" | "unhide",
) {
  if (outcome.status === "ok") {
    return c.json({ suggestion: outcome.suggestion }, 200);
  }
  if (outcome.status === "forbidden") {
    return c.json(
      {
        error: "forbidden",
        message: "This suggestion belongs to a different workspace.",
        requestId,
      },
      403,
    );
  }
  return c.json(
    {
      error: "not_found",
      message: `Cannot ${verb}: suggestion not found.`,
      requestId,
    },
    404,
  );
}

adminStarterPrompts.openapi(approveRoute, async (c) =>
  runHandler(c, "approve starter prompt", async () => {
    const authResult = c.get("authResult");
    const userId = authResult.user?.id ?? "unknown";
    const { orgId, requestId } = c.get("orgContext");
    const atlasMode = c.get("atlasMode");
    const { id } = c.req.valid("param");

    try {
      const outcome = await approveSuggestion({ id, orgId, userId, mode: atlasMode });
      return respondApprovalResult(c, outcome, requestId, "approve");
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          suggestionId: id,
          orgId,
          requestId,
        },
        "approveSuggestion failed",
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }),
);

adminStarterPrompts.openapi(hideRoute, async (c) =>
  runHandler(c, "hide starter prompt", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const atlasMode = c.get("atlasMode");
    const { id } = c.req.valid("param");

    try {
      const outcome = await hideSuggestion({ id, orgId, mode: atlasMode });
      return respondApprovalResult(c, outcome, requestId, "hide");
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          suggestionId: id,
          orgId,
          requestId,
        },
        "hideSuggestion failed",
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }),
);

adminStarterPrompts.openapi(unhideRoute, async (c) =>
  runHandler(c, "unhide starter prompt", async () => {
    const { orgId, requestId } = c.get("orgContext");
    const atlasMode = c.get("atlasMode");
    const { id } = c.req.valid("param");

    try {
      const outcome = await unhideSuggestion({ id, orgId, mode: atlasMode });
      return respondApprovalResult(c, outcome, requestId, "unhide");
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          suggestionId: id,
          orgId,
          requestId,
        },
        "unhideSuggestion failed",
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }),
);

adminStarterPrompts.openapi(authorRoute, async (c) =>
  runHandler(c, "author starter prompt", async () => {
    const authResult = c.get("authResult");
    const userId = authResult.user?.id ?? "unknown";
    const { orgId, requestId } = c.get("orgContext");
    const atlasMode = c.get("atlasMode");
    const { text } = c.req.valid("json");

    try {
      const suggestion = await createApprovedSuggestion({ orgId, userId, text, mode: atlasMode });
      return c.json({ suggestion }, 200);
    } catch (err) {
      if (err instanceof InvalidSuggestionTextError) {
        return c.json(
          { error: "invalid_text", message: err.message, requestId },
          400,
        );
      }
      if (err instanceof DuplicateSuggestionError) {
        return c.json(
          { error: "duplicate_suggestion", message: err.message, requestId },
          409,
        );
      }
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          orgId,
          requestId,
        },
        "createApprovedSuggestion failed",
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }),
);

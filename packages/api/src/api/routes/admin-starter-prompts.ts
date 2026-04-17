/**
 * Admin starter-prompt moderation routes.
 *
 * Mounted under /api/v1/admin/starter-prompts. All routes require admin role.
 * Read-only queue over pending / approved / hidden buckets. The canonical
 * explainer for the state matrix lives with the policy in
 * `@atlas/api/lib/suggestions/approval-service`.
 */

import { Effect } from "effect";
import { createRoute, z } from "@hono/zod-openapi";
import { runEffect } from "@atlas/api/lib/effect/hono";
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
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

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

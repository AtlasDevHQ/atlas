/**
 * Admin semantic expert improvement routes.
 *
 * Mounted under /api/v1/admin/semantic-improve via admin.route().
 * Provides the streaming chat endpoint for the semantic expert agent, the
 * DB-backed pending-amendment review queue (list, count, review), and the
 * semantic-layer health score.
 *
 * There is deliberately no server-side session resource here: an improvement
 * conversation is a conversation, not a stored resource — the persisted
 * `learned_patterns` row (`type = 'semantic_amendment'`) is the only proposal
 * identity, and all reviews go through POST /amendments/{id}/review (#4503).
 */

import { createRoute, z } from "@hono/zod-openapi";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runHandler } from "@atlas/api/lib/effect/hono";
import type { Context as HonoContext } from "hono";
import { runAgent } from "@atlas/api/lib/agent";
import { checkAgentBillingGate } from "@atlas/api/lib/billing/agent-gate";
import { buildExpertRegistry } from "@atlas/api/lib/tools/expert-registry";
import { EXPERT_PERSONA_PROMPT } from "@atlas/api/lib/semantic/expert/persona";
import { SEMANTIC_HEALTH_STATUSES } from "@atlas/api/lib/semantic/expert/briefing";
import { ErrorSchema, AuthErrorSchema, createParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-semantic-improve");

function clientIpFor(c: HonoContext): string | null {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

/**
 * Classify a `computeAmendmentLiveDiff` failure for GET /pending (#4511). The
 * EXPECTED unresolvable cases — a legacy cross-group-ambiguous row, an absent
 * entity, a non-mapping baseline, or a corrupt stored payload — are routine and
 * log at debug (the card degrades to the amendment preview, and approval
 * surfaces the group picker). Anything else (a DB outage in getEntity, a
 * dynamic-import failure, a post-refactor TypeError, or a non-Error throw) is a
 * real read-path fault the null-diff fallback would otherwise hide until approve
 * time — those log at warn, so infra problems aren't indistinguishable from a
 * legacy-row miss. Errs toward visibility: never a swallow.
 */
export function isExpectedLiveDiffError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AmbiguousEntityError" ||
    /not found|expected a mapping|amendment_payload|missing a valid `amendment` object/i.test(
      err.message,
    )
  );
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ChatRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      parts: z.array(z.object({ type: z.string() }).passthrough()),
      id: z.string(),
    }),
  ).min(1),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const chatStreamRoute = createRoute({
  method: "post",
  path: "/chat",
  tags: ["Admin — Semantic Improve"],
  summary: "Chat with the semantic expert agent (streaming)",
  description:
    "Sends a conversation to the semantic expert agent and streams the response. " +
    "Uses the 4 expert tools (profileTable, checkDataDistribution, searchAuditLog, proposeAmendment) " +
    "plus standard explore and executeSQL.",
  request: {
    body: {
      content: { "application/json": { schema: ChatRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "SSE stream using the Vercel AI SDK UI message stream protocol.",
      content: { "text/event-stream": { schema: z.string() } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description:
        "Blocked by billing enforcement (#3437) — workspace suspended/deleted, trial expired, or subscription ended",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description:
        "Blocked by billing enforcement (#3437) — plan token budget exceeded, or abuse throttle (carries Retry-After)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description:
        "Billing enforcement could not verify workspace status (fail-closed, retryable)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminSemanticImprove = createAdminRouter();
adminSemanticImprove.use(requireOrgContext());
// F-53 — gate the expert-agent semantic improve surface on admin:semantic.
adminSemanticImprove.use(requirePermission("admin:semantic"));

// POST /chat — streaming expert agent conversation
adminSemanticImprove.openapi(chatStreamRoute, async (c) =>
  runHandler(c, "semantic-improve-chat", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const body = c.req.valid("json");
    const messages = body.messages as UIMessage[];

    // #3437 — billing enforcement before any LLM spend. The expert agent
    // runs on platform tokens and its usage IS metered against the
    // workspace budget (`runAgent` → `recordUsage`), so the run must
    // pass the same shared billing gate (workspace status → abuse →
    // checkPlanLimits, #3419/#3420) as every other agent surface. Admin
    // maintenance is intentionally NOT exempt: an admin of a suspended /
    // trial-expired / over-budget workspace resolves billing first.
    const gateCheck = await checkAgentBillingGate(orgId);
    if (!gateCheck.allowed) {
      log.warn(
        { requestId, orgId, errorCode: gateCheck.errorCode },
        "Semantic-improve chat blocked by billing enforcement",
      );
      const blockBody = {
        error: gateCheck.errorCode,
        message: gateCheck.errorMessage,
        retryable: gateCheck.retryable,
        requestId,
        ...(gateCheck.retryAfterSeconds !== undefined && { retryAfterSeconds: gateCheck.retryAfterSeconds }),
        ...(gateCheck.usage && { usage: gateCheck.usage }),
      };
      if (gateCheck.retryAfterSeconds !== undefined) {
        return c.json(blockBody, {
          status: gateCheck.httpStatus,
          headers: { "Retry-After": String(gateCheck.retryAfterSeconds) },
        });
      }
      return c.json(blockBody, gateCheck.httpStatus);
    }

    // Build the expert tool registry
    const expertRegistry = buildExpertRegistry();

    // #4514 — assemble the Briefing: the deterministic turn-one context block
    // (health, tracked-profile freshness, top findings, the pending queue,
    // recent panel decisions) front-loaded into the expert agent's prompt so it
    // doesn't spend tool calls learning state it can be told. Built from tracked
    // profiles + internal DB only — NO customer-database query at chat start
    // (#4514 AC3). Re-assembled each turn, so a panel decision made between turns
    // shows up in the next turn's context without a synthetic message. Fail-soft:
    // a load hiccup starts the chat without the block rather than 500-ing it.
    const { buildBriefingBlock } = await import("@atlas/api/lib/semantic/expert/briefing-inputs");
    const briefing = await buildBriefingBlock(orgId);

    // #4508 — stamp the agent origin so origin-scoped approval rules (#2072)
    // fire for the expert agent's `executeSQL`. The interactive improve chat is
    // a web surface, so it stamps `'chat'` like /chat · /query · /demo; without
    // this frame `agentOrigin` is undefined and origin-scoped rules silently
    // no-op for the expert agent. `runAgent` reads the user (approval requester)
    // + origin from this context — the F-54/F-55 + #2072 agent-surface-registry
    // guards pin the binding. We bind the user from `authResult` (the source of
    // truth the adminAuth middleware set), matching /chat, rather than depending
    // on the upstream ALS frame surviving the Effect bridge; the trust-device id
    // (which `logAdminAction` reads) is preserved from the same context.
    const authResult = c.get("authResult");
    return withRequestContext(
      {
        requestId,
        user: authResult.user,
        atlasMode: c.get("atlasMode"),
        trustDeviceIdentifier: c.get("trustDeviceIdentifier"),
        agentOrigin: "chat",
      },
      async () => {
        try {
          // #4508 — no `maxSteps` override. The old hardcoded `maxSteps: 15`
          // is retired: `runAgent`'s default is `stepCountIs(getAgentMaxSteps())`,
          // which resolves the workspace agent-max-steps knob (workspace DB >
          // platform DB > env > default, clamped to its bounds) from the active
          // organization on the request-context frame stamped just above — so
          // the improve chat honors the same operator knob as every other agent
          // surface, hot-reloaded per turn, with no separate resolution path.
          const agentResult = await runAgent({
            messages,
            tools: expertRegistry,
            // #4508 — "expert is a mode": the expert persona REPLACES the analyst
            // role section (not appended under `## Warnings`), so the model gets
            // one identity. See lib/semantic/expert/persona.ts.
            persona: EXPERT_PERSONA_PROMPT,
            // #4514 — front-load the Briefing (null when it couldn't be built ⇒
            // buildSystemParam appends nothing, chat still starts).
            briefing: briefing ?? undefined,
          });

          // Audit the draft surface: an expert-agent chat turn that can propose
          // amendments via `proposeAmendment`. The tool may persist a pending
          // `learned_patterns` amendment row mid-stream, so the audit row is the
          // single anchor for "admin ran the improve chat at time T" even if the
          // stream errors later. The requestId is the correlation handle — there
          // is no server-side session resource (#4503).
          logAdminAction({
            actionType: ADMIN_ACTIONS.semantic.improveDraft,
            targetType: "semantic",
            targetId: requestId,
            ipAddress: clientIpFor(c),
            metadata: { requestId, messageCount: messages.length },
          });

          const stream = createUIMessageStream({
            execute: ({ writer }) => {
              writer.merge(agentResult.toUIMessageStream());
            },
            onError: (error) => {
              log.error(
                { err: error instanceof Error ? error : new Error(String(error)), requestId },
                "Semantic improve stream error",
              );
              return `An error occurred while analyzing the semantic layer (ref: ${requestId.slice(0, 8)}). Try again.`;
            },
          });

          return createUIMessageStreamResponse({
            stream,
            headers: {
              "X-Accel-Buffering": "no",
              "Cache-Control": "no-cache, no-transform",
            },
          });
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err.message : String(err), requestId },
            "Failed to start semantic improve agent",
          );
          return c.json(
            {
              error: "agent_error",
              message: `Failed to start the semantic expert agent: ${err instanceof Error ? err.message : String(err)}`,
              requestId,
            },
            500,
          );
        }
      },
    );
  }),
);

// ---------------------------------------------------------------------------
// Pending count + health score routes
// ---------------------------------------------------------------------------

const pendingCountRoute = createRoute({
  method: "get",
  path: "/pending-count",
  tags: ["Admin — Semantic Improve"],
  summary: "Count pending semantic amendment proposals",
  description: "Returns the number of pending proposals awaiting review for the current org.",
  responses: {
    200: {
      description: "Pending count",
      content: { "application/json": { schema: z.object({ count: z.number() }) } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const TestResultSchema = z.object({
  success: z.boolean(),
  rowCount: z.number(),
  sampleRows: z.array(z.record(z.string(), z.unknown())),
  error: z.string().optional(),
});

const PendingAmendmentSchema = z.object({
  id: z.string(),
  entityName: z.string(),
  description: z.string().nullable(),
  confidence: z.number(),
  amendmentType: z.string().nullable(),
  amendment: z.record(z.string(), z.unknown()).nullable(),
  rationale: z.string().nullable(),
  /**
   * The LIVE diff (#4511) — recomputed against the entity's CURRENT baseline at
   * read time, never the propose-time stored diff (a record of intent, never
   * the thing approved; CONTEXT.md § "Live diff"). `null` when the baseline
   * can't be resolved for a single diff (entity absent, corrupt YAML, or a
   * legacy cross-group-ambiguous row) — the card falls back to the amendment
   * preview and approval surfaces the group picker.
   */
  diff: z.string().nullable(),
  /**
   * Hash of the current baseline the live `diff` was computed against (#4511).
   * The admin carries it into an approve as a hash-carried claim; the decide
   * seam rejects a mismatch with the fresh diff for inline update-and-confirm.
   * `null` whenever `diff` is (no single baseline to hash).
   */
  baselineHash: z.string().nullable(),
  testQuery: z.string().nullable(),
  testResult: TestResultSchema.nullable(),
  /**
   * Reason the last approve-apply failed (#4506) — set when the decide seam
   * compensated the row back to pending. Lets the queue show WHY an approval
   * bounced instead of silently re-listing the row.
   */
  applyError: z.string().nullable(),
  createdAt: z.string(),
});

const RejectedAmendmentSchema = z.object({
  id: z.string(),
  entityName: z.string(),
  description: z.string().nullable(),
  confidence: z.number(),
  amendmentType: z.string().nullable(),
  amendment: z.record(z.string(), z.unknown()).nullable(),
  rationale: z.string().nullable(),
  diff: z.string().nullable(),
  testQuery: z.string().nullable(),
  testResult: TestResultSchema.nullable(),
  /** When the reject was recorded — surfaced so the view can order/explain it. */
  rejectedAt: z.string().nullable(),
  /** Who rejected it — the "admin" sentinel today (web review is the only reject path). */
  rejectedBy: z.string().nullable(),
  createdAt: z.string(),
});

const pendingListRoute = createRoute({
  method: "get",
  path: "/pending",
  tags: ["Admin — Semantic Improve"],
  summary: "List pending semantic amendment proposals",
  description: "Returns pending amendment proposals awaiting review, newest first.",
  responses: {
    200: {
      description: "Pending amendments",
      content: { "application/json": { schema: z.object({ amendments: z.array(PendingAmendmentSchema) }) } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const StaleBaselineResponseSchema = z.object({
  error: z.literal("stale_baseline"),
  message: z.string(),
  /** The freshly-computed live diff against the entity's current baseline. */
  diff: z.string(),
  /** The current baseline hash — carry it back on the confirming approve. */
  baselineHash: z.string(),
  requestId: z.string().optional(),
});

// The route's OTHER 409 shape: a legacy cross-group-ambiguous row. It is emitted
// by the shared bridge (`AmbiguousEntityError` → `mapTaggedError`), not a typed
// `c.json` here, but the published contract must still document it so codegen
// consumers see both 409 variants — hence the union on the 409 response below.
const AmbiguousEntityResponseSchema = z.object({
  error: z.literal("entity_ambiguous"),
  message: z.string(),
  /** Candidate groups to disambiguate to; `null` = the legacy/default (flat) scope. */
  groups: z.array(z.string().nullable()),
  entityName: z.string(),
  entityType: z.string(),
  requestId: z.string().optional(),
});

const reviewAmendmentRoute = createRoute({
  method: "post",
  path: "/amendments/{id}/review",
  tags: ["Admin — Semantic Improve"],
  summary: "Approve or reject a pending amendment",
  description:
    "Updates the status of a pending semantic amendment. An approve carries an " +
    "optional `baselineHash` (the hash the admin rendered) — a mismatch against " +
    "the current baseline returns 409 `stale_baseline` with the fresh diff for " +
    "inline update-and-confirm (#4511). A legacy cross-group-ambiguous row " +
    "returns 409 `entity_ambiguous` with candidate `groups`; retry with the " +
    "optional `group` field to disambiguate.",
  request: {
    params: createParamSchema("id", "550e8400-e29b-41d4-a716-446655440000"),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            decision: z.enum(["approved", "rejected"]),
            /**
             * #4511 — the baseline hash the admin rendered (hash-carried claim).
             * A mismatch → 409 `stale_baseline` with the fresh diff. Omit to
             * skip the check (e.g. confirming after a group pick).
             */
            baselineHash: z.string().optional(),
            /**
             * #4511 — an admin-picked group for a legacy cross-group-ambiguous
             * row, honored only when the server demanded disambiguation. `null`
             * targets the legacy/default (flat) scope; omit when not
             * disambiguating.
             */
            group: z.string().nullable().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Amendment reviewed",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), id: z.string(), decision: z.string() }) } },
    },
    400: {
      description: "Invalid decision",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Amendment not found or already reviewed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "Baseline changed since render (`stale_baseline`, carries the fresh diff), " +
        "or a legacy cross-group-ambiguous row (`entity_ambiguous`, carries candidate `groups`) (#4511)",
      content: {
        "application/json": {
          schema: z.union([StaleBaselineResponseSchema, AmbiguousEntityResponseSchema]),
        },
      },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const rejectedListRoute = createRoute({
  method: "get",
  path: "/rejected",
  tags: ["Admin — Semantic Improve"],
  summary: "List rejected semantic amendment proposals",
  description:
    "Returns the org's rejected amendments, most-recently-rejected first. The " +
    "Rejected view lists these so an admin can Reconsider one — the only action " +
    "that lifts a rejection and returns the change to the Pending queue (#4512).",
  responses: {
    200: {
      description: "Rejected amendments",
      content: { "application/json": { schema: z.object({ amendments: z.array(RejectedAmendmentSchema) }) } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const reconsiderAmendmentRoute = createRoute({
  method: "post",
  path: "/amendments/{id}/reconsider",
  tags: ["Admin — Semantic Improve"],
  summary: "Reconsider a rejected amendment",
  description:
    "Lifts a rejection (#4512): returns the rejected amendment to the Pending " +
    "queue and removes its identity from rejection memory, so it becomes " +
    "proposable again. The only way a rejected change comes back.",
  request: {
    params: createParamSchema("id", "550e8400-e29b-41d4-a716-446655440000"),
  },
  responses: {
    200: {
      description: "Amendment returned to pending",
      content: { "application/json": { schema: z.object({ ok: z.boolean(), id: z.string() }) } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Amendment not found or not currently rejected",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const healthScoreRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Admin — Semantic Improve"],
  summary: "Semantic layer health score",
  description: "Computes and returns a health score for the current semantic layer based on coverage, descriptions, measures, and joins.",
  responses: {
    200: {
      description: "Health score",
      content: {
        "application/json": {
          schema: z.object({
            overall: z.number(),
            coverage: z.number(),
            descriptionQuality: z.number(),
            measureCoverage: z.number(),
            joinCoverage: z.number(),
            entityCount: z.number(),
            dimensionCount: z.number(),
            measureCount: z.number(),
            glossaryTermCount: z.number(),
            // #4514 — the status discriminator: the widget renders a
            // parse-failure zero ("N of M entities failed to parse") differently
            // from a no-data zero ("no entities yet"). `parseFailures`/`totalRows`
            // carry the counts the corruption caption needs. Enum reuses the
            // single-source tuple so it can't drift from the type.
            status: z.enum(SEMANTIC_HEALTH_STATUSES),
            parseFailures: z.number(),
            totalRows: z.number(),
          }),
        },
      },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// GET /pending-count
adminSemanticImprove.openapi(pendingCountRoute, async (c) =>
  runHandler(c, "pending-amendment-count", async () => {
    const { orgId } = c.get("orgContext");

    const { getPendingAmendmentCount } = await import("@atlas/api/lib/db/internal");
    const count = await getPendingAmendmentCount(orgId);

    return c.json({ count }, 200);
  }),
);

/**
 * Extract the payload-derived display fields shared by the Pending and Rejected
 * views from a stored amendment's `amendment_payload`. Kept in one place so the
 * two views can never drift on how an Amendment's type/rationale/diff/test are
 * surfaced — the only per-view difference is the status-specific columns
 * (`applyError` for pending, `rejectedAt`/`rejectedBy` for rejected) each
 * handler adds.
 */
function amendmentPayloadView(payload: Record<string, unknown> | null) {
  /** Safely extract a string field from the untyped payload. */
  function str(key: string): string | null {
    const v = payload?.[key];
    return typeof v === "string" ? v : null;
  }

  // payload is the full AmendmentPayload (entity, type, rationale, diff, etc.).
  // Extract just the type-specific amendment data (e.g. dimension/measure object).
  const innerAmendment = payload?.amendment;
  const parsedTestResult = TestResultSchema.safeParse(payload?.testResult);

  return {
    amendmentType: str("amendmentType"),
    amendment: (innerAmendment && typeof innerAmendment === "object" && !Array.isArray(innerAmendment))
      ? (innerAmendment as Record<string, unknown>)
      : null,
    rationale: str("rationale"),
    diff: str("diff"),
    testQuery: str("testQuery"),
    testResult: parsedTestResult.success ? parsedTestResult.data : null,
  };
}

// GET /pending — list pending amendments with LIVE diffs (#4511)
adminSemanticImprove.openapi(pendingListRoute, async (c) =>
  runHandler(c, "list-pending-amendments", async () => {
    const { orgId } = c.get("orgContext");

    const { getPendingAmendments } = await import("@atlas/api/lib/db/internal");
    const { computeAmendmentLiveDiff } = await import("@atlas/api/lib/semantic/expert/diff");
    const rows = await getPendingAmendments(orgId);

    const amendments = await Promise.all(
      rows.map(async (row) => {
        const payload = row.amendment_payload;
        if (!payload || typeof payload !== "object") {
          log.debug({ id: row.id }, "Pending amendment has null or non-object payload");
        }

        // #4511 — the LIVE diff: recompute against the entity's CURRENT baseline
        // at read time. The stored payload.diff is a record of intent, never
        // rendered for a decision — so it is dropped here and replaced. A
        // baseline that can't be resolved to a single diff (entity absent,
        // corrupt YAML, or a legacy cross-group-ambiguous row) yields a null
        // diff/hash: the card falls back to the amendment preview and approval
        // surfaces the group picker. Never a 500 for one unresolvable row.
        let liveDiff: string | null = null;
        let baselineHash: string | null = null;
        try {
          const live = await computeAmendmentLiveDiff({
            orgId,
            sourceEntity: row.source_entity,
            connectionGroupId: row.connection_group_id ?? null,
            rawPayload: payload,
            label: row.id,
          });
          liveDiff = live.diff;
          baselineHash = live.baselineHash;
        } catch (err) {
          // Routine unresolvable rows log at debug; real read-path faults at
          // warn (see isExpectedLiveDiffError). Never a swallow — the null-diff
          // fallback is explicit and the card degrades to the amendment preview.
          const logContext = { id: row.id, err: err instanceof Error ? err.message : String(err) };
          const logMessage =
            "Live diff unavailable for pending amendment — falling back to the amendment preview";
          if (isExpectedLiveDiffError(err)) {
            log.debug(logContext, logMessage);
          } else {
            log.warn(logContext, logMessage);
          }
        }

        // Drop the stored diff from the shared view: for the pending decision
        // surface only the live diff is rendered.
        const { diff: _storedDiff, ...view } = amendmentPayloadView(payload);
        return {
          id: row.id,
          entityName: row.source_entity,
          description: row.description,
          confidence: row.confidence,
          ...view,
          diff: liveDiff,
          baselineHash,
          applyError: row.last_apply_error ?? null,
          createdAt: row.created_at,
        };
      }),
    );

    return c.json({ amendments }, 200);
  }),
);

// GET /rejected — list rejected amendments (the Rejected view, #4512)
adminSemanticImprove.openapi(rejectedListRoute, async (c) =>
  runHandler(c, "list-rejected-amendments", async () => {
    const { orgId } = c.get("orgContext");

    const { getRejectedAmendments } = await import("@atlas/api/lib/db/internal");
    const rows = await getRejectedAmendments(orgId);

    const amendments = rows.map((row) => {
      const payload = row.amendment_payload;
      if (!payload || typeof payload !== "object") {
        log.debug({ id: row.id }, "Rejected amendment has null or non-object payload");
      }

      return {
        id: row.id,
        entityName: row.source_entity,
        description: row.description,
        confidence: row.confidence,
        ...amendmentPayloadView(payload),
        rejectedAt: row.reviewed_at ?? null,
        rejectedBy: row.reviewed_by ?? null,
        createdAt: row.created_at,
      };
    });

    return c.json({ amendments }, 200);
  }),
);

// POST /amendments/:id/reconsider — lift a rejection (#4512)
adminSemanticImprove.openapi(reconsiderAmendmentRoute, async (c) =>
  runHandler(c, "reconsider-amendment", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const { id } = c.req.valid("param");

    // One atomic `rejected → pending` flip. Returning the row to pending IS the
    // removal from rejection memory (memory = the set of `status = 'rejected'`
    // rows), so the identity becomes proposable again in the same write. A row
    // that isn't currently rejected matches nothing — reported truthfully as
    // 404, never a silent no-op that pretends to have lifted a rejection.
    const { reconsiderRejectedAmendment } = await import("@atlas/api/lib/db/internal");
    const reconsidered = await reconsiderRejectedAmendment(id, orgId);

    if (!reconsidered) {
      return c.json(
        { error: "not_found", message: "Rejected amendment not found or not currently rejected.", requestId },
        404,
      );
    }

    // Reconsider is its own intent, not a review — it lifts a permanent
    // rejection. Give it a dedicated audit action so forensic queries can see
    // exactly when a rejected change was brought back.
    logAdminAction({
      actionType: ADMIN_ACTIONS.semantic.improveReconsider,
      targetType: "semantic",
      targetId: id,
      ipAddress: clientIpFor(c),
      metadata: { id },
    });

    log.info({ requestId, orgId, id }, "Amendment reconsidered — returned to pending, rejection memory cleared");
    return c.json({ ok: true, id }, 200);
  }),
);

// POST /amendments/:id/review — approve or reject a DB amendment
adminSemanticImprove.openapi(reviewAmendmentRoute, async (c) =>
  runHandler(c, "review-amendment", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const { id } = c.req.valid("param");
    const { decision, baselineHash, group } = c.req.valid("json");

    // The decide seam owns the whole `pending → approved | rejected`
    // transition (#4506): claim-then-apply, `approved` stamped only after a
    // successful apply + version snapshot, compensation back to `pending`
    // (with a visible reason) on failure. A null/corrupt payload is an error
    // inside the seam — never a silent stamp. Apply errors propagate:
    // runHandler maps an AmbiguousEntityError to 409 (with `groups`) and
    // everything else to 500 — by then the row is already back to pending.
    // #4511: the hash-carried claim (`baselineHash`) + disambiguation `group`
    // ride through — a hash mismatch returns a `stale` outcome (409 + fresh
    // diff), never an apply.
    const { decideAmendment } = await import("@atlas/api/lib/semantic/expert/decide");
    const outcome = await decideAmendment({
      id,
      orgId,
      decision,
      reviewedBy: "admin",
      requestId,
      expectedBaselineHash: baselineHash,
      group,
    });

    if (outcome.kind === "not_pending") {
      return c.json({ error: "not_found", message: "Amendment not found or already reviewed.", requestId }, 404);
    }

    // #4511 — the entity changed since the admin rendered the diff. Not an
    // error: return the fresh diff + baseline hash so the card presents inline
    // update-and-confirm. The confirm re-submits with this `baselineHash`,
    // which now matches, and applies. The row is already back to pending.
    if (outcome.kind === "stale") {
      return c.json(
        {
          error: "stale_baseline" as const,
          message:
            "This entity changed while you were reviewing. Review the updated change and confirm.",
          diff: outcome.diff,
          baselineHash: outcome.baselineHash,
          requestId,
        },
        409,
      );
    }

    // Action type reflects the intent, not the route path — an approved
    // review fires `improve_apply` (YAML was written); a rejected review
    // fires `improve_reject`.
    logAdminAction({
      actionType:
        decision === "approved"
          ? ADMIN_ACTIONS.semantic.improveApply
          : ADMIN_ACTIONS.semantic.improveReject,
      targetType: "semantic",
      targetId: id,
      ipAddress: clientIpFor(c),
      metadata: { id, decision },
    });

    log.info({ requestId, orgId, id, decision }, "Amendment reviewed");
    return c.json({ ok: true, id, decision }, 200);
  }),
);

// GET /health — let runHandler handle errors (no manual try/catch)
adminSemanticImprove.openapi(healthScoreRoute, async (c) =>
  runHandler(c, "semantic-health-score", async () => {
    const { orgId } = c.get("orgContext");
    const { loadAnalysisContext, deriveHealthStatus } =
      await import("@atlas/api/lib/semantic/expert/briefing-inputs");
    const { computeSemanticHealth } = await import("@atlas/api/lib/semantic/expert/health");

    // #4514 — the SAME assembly the briefing uses: `loadAnalysisContext` builds
    // the AnalysisContext from REAL tracked inputs (baseline profiles #4509 +
    // audit patterns), replacing the old empty-inputs call that fixed coverage
    // and join sub-scores at 100 regardless of the actual schema. Reads only
    // tracked/internal data — no live customer-database query.
    //
    // `loadEntitiesForOrg` (inside) merges DB rows with the per-org disk mirror
    // under the same `(name, connection_group_id)` dedup the Overview tile + chat
    // empty state + semantic file tree read through (#2503). The no-DB / no-orgId
    // branch falls back to bundled YAML (self-hosted stdio / bare CLI); on SaaS
    // that branch can't trigger — an authenticated admin request always carries
    // an orgId and SaaS always runs with an internal DB.
    const { ctx, totalRows, parseFailures } = await loadAnalysisContext(orgId, "published");
    const score = computeSemanticHealth(ctx);

    // Status discriminator: distinguish the empty case (`no_entities`) from the
    // corruption case (`corrupt` — every DB entity row failed parse) instead of
    // conflating both with a 0% score. `corrupt` gates on `totalRows`
    // (DB-rows-considered) so a healthy disk mirror can't mask corruption;
    // `no_entities` gates on the merged entity count (#2503). Shared with the
    // briefing via `deriveHealthStatus` so both read the same rule.
    const status = deriveHealthStatus(parseFailures, totalRows, ctx.entities.length);

    return c.json({ ...score, status, parseFailures, totalRows }, 200);
  }),
);

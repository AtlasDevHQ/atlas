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
import { ErrorSchema, AuthErrorSchema, createParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext, requirePermission } from "./admin-router";

const log = createLogger("admin-semantic-improve");

function clientIpFor(c: HonoContext): string | null {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
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
    "Uses the 5 expert tools (profileTable, checkDataDistribution, searchAuditLog, proposeAmendment, validateProposal) " +
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
  diff: z.string().nullable(),
  testQuery: z.string().nullable(),
  testResult: TestResultSchema.nullable(),
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

const reviewAmendmentRoute = createRoute({
  method: "post",
  path: "/amendments/{id}/review",
  tags: ["Admin — Semantic Improve"],
  summary: "Approve or reject a pending amendment",
  description: "Updates the status of a pending semantic amendment in the database.",
  request: {
    params: createParamSchema("id", "550e8400-e29b-41d4-a716-446655440000"),
    body: {
      content: {
        "application/json": {
          schema: z.object({ decision: z.enum(["approved", "rejected"]) }),
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

// GET /pending — list pending amendments
adminSemanticImprove.openapi(pendingListRoute, async (c) =>
  runHandler(c, "list-pending-amendments", async () => {
    const { orgId } = c.get("orgContext");

    const { getPendingAmendments } = await import("@atlas/api/lib/db/internal");
    const rows = await getPendingAmendments(orgId);

    const amendments = rows.map((row) => {
      const payload = row.amendment_payload;
      if (!payload || typeof payload !== "object") {
        log.debug({ id: row.id }, "Pending amendment has null or non-object payload");
      }

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
        id: row.id,
        entityName: row.source_entity,
        description: row.description,
        confidence: row.confidence,
        amendmentType: str("amendmentType"),
        amendment: (innerAmendment && typeof innerAmendment === "object" && !Array.isArray(innerAmendment))
          ? innerAmendment as Record<string, unknown>
          : null,
        rationale: str("rationale"),
        diff: str("diff"),
        testQuery: str("testQuery"),
        testResult: parsedTestResult.success ? parsedTestResult.data : null,
        createdAt: row.created_at,
      };
    });

    return c.json({ amendments }, 200);
  }),
);

// POST /amendments/:id/review — approve or reject a DB amendment
adminSemanticImprove.openapi(reviewAmendmentRoute, async (c) =>
  runHandler(c, "review-amendment", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const { id } = c.req.valid("param");
    const { decision } = c.req.valid("json");

    const { reviewSemanticAmendment } = await import("@atlas/api/lib/db/internal");

    // For approvals, apply YAML first — only update DB status on success
    if (decision === "approved") {
      // Peek at the row to get payload before changing status
      const { getPendingAmendments } = await import("@atlas/api/lib/db/internal");
      const pending = await getPendingAmendments(orgId);
      const target = pending.find((r) => r.id === id);
      if (!target) {
        return c.json({ error: "not_found", message: "Amendment not found or already reviewed.", requestId }, 404);
      }

      const payload = target.amendment_payload;
      if (payload) {
        const { applyAmendmentFromPayload } = await import("@atlas/api/lib/semantic/expert/apply");
        // This throws on failure — runHandler maps it to 500 (or 409 for an
        // AmbiguousEntityError). The shared helper owns the envelope→
        // AnalysisResult mapping, including extracting the INNER `amendment`
        // object (the YAML mutation reads `payload.amendment`, not the whole
        // envelope) and recovering the Connection group (#3284).
        await applyAmendmentFromPayload({
          orgId,
          sourceEntity: target.source_entity,
          connectionGroupId: target.connection_group_id ?? null,
          rawPayload: payload,
          requestId,
          label: target.id,
        });
      }
    }

    // YAML applied (or rejection) — now update DB status
    const reviewed = await reviewSemanticAmendment(id, orgId, decision, "admin");

    if (!reviewed) {
      return c.json({ error: "not_found", message: "Amendment not found or already reviewed.", requestId }, 404);
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
    const { loadEntitiesForOrg, loadEntitiesFromDisk, loadGlossaryFromDisk } =
      await import("@atlas/api/lib/semantic/expert/context-loader");
    const { hasInternalDB } = await import("@atlas/api/lib/db/internal");
    const { computeSemanticHealth } = await import("@atlas/api/lib/semantic/expert/health");

    // `loadEntitiesForOrg` merges DB rows with the per-org disk mirror under
    // the same `(name, connection_group_id)` dedup the Overview tile + chat
    // empty state + semantic file tree all read through (#2503). Reading only
    // DB rows here used to drop the disk-mirror half of the merge, leaving the
    // Health caption "23 entities" next to a file tree showing 46.
    //
    // The no-DB / no-orgId branch still falls back to bundled YAML — the
    // self-hosted stdio loop and bare CLI scenario. On SaaS this path can't
    // trigger: an authenticated admin request always carries an orgId, and
    // SaaS always runs with an internal DB.
    let entities: Awaited<ReturnType<typeof loadEntitiesFromDisk>>;
    let parseFailures = 0;
    let totalRows: number;
    if (orgId && hasInternalDB()) {
      const dbResult = await loadEntitiesForOrg(orgId, "published");
      entities = dbResult.entities;
      parseFailures = dbResult.parseFailures;
      totalRows = dbResult.totalRows;
    } else {
      entities = await loadEntitiesFromDisk();
      totalRows = entities.length;
    }
    const glossary = await loadGlossaryFromDisk();

    const score = computeSemanticHealth({
      profiles: [],
      entities,
      glossary,
      auditPatterns: [],
      rejectedKeys: new Set(),
    });

    // Surface a status discriminator so the widget can distinguish the
    // empty case (`no_entities`) from the corruption case (`corrupt` —
    // every entity row failed parse) instead of conflating both with a
    // 0% score that gives no actionable signal.
    //
    // `corrupt` gates on `totalRows` (DB-rows-considered) so a workspace
    // whose every DB row fails YAML parse still trips the signal even when
    // the disk mirror has healthy entries that would otherwise pad
    // `entities.length` past `parseFailures`. `no_entities` gates on the
    // merged `entities.length` because a workspace with 0 DB rows but a
    // populated disk mirror genuinely has entities to query — flagging it
    // empty would be the same misleading signal in reverse (#2503 review).
    const status = parseFailures > 0 && parseFailures === totalRows && totalRows > 0
      ? ("corrupt" as const)
      : entities.length === 0
        ? ("no_entities" as const)
        : ("ok" as const);

    return c.json({ ...score, status, parseFailures, totalRows }, 200);
  }),
);

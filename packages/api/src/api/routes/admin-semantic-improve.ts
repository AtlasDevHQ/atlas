/**
 * Admin semantic expert improvement routes.
 *
 * Mounted under /api/v1/admin/semantic-improve via admin.route().
 * Provides streaming chat endpoint for the semantic expert agent,
 * session management, and proposal approval/rejection.
 */

import { createRoute, z } from "@hono/zod-openapi";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { runHandler } from "@atlas/api/lib/effect/hono";
import type { Context as HonoContext } from "hono";
import { runAgent } from "@atlas/api/lib/agent";
import { buildExpertRegistry } from "@atlas/api/lib/tools/expert-registry";
import {
  createSession,
  recordDecision,
  getSessionSummary,
  buildSessionContext,
  type SessionState,
  type AnalysisResult,
} from "@atlas/api/lib/semantic/expert";
import { ErrorSchema, AuthErrorSchema, createParamSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-semantic-improve");

// ---------------------------------------------------------------------------
// In-memory session store (per-process; sufficient for single-instance deploy)
// ---------------------------------------------------------------------------

interface StoredSession {
  id: string;
  orgId: string;
  state: SessionState;
  createdAt: Date;
  updatedAt: Date;
}

const sessions = new Map<string, StoredSession>();

function generateId(): string {
  return crypto.randomUUID();
}

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
  sessionId: z.string().uuid().optional(),
});

const SessionSummarySchema = z.object({
  id: z.string(),
  total: z.number(),
  accepted: z.number(),
  rejected: z.number(),
  skipped: z.number(),
  remaining: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ProposalSchema = z.object({
  index: z.number(),
  entityName: z.string(),
  category: z.string(),
  amendmentType: z.string(),
  amendment: z.record(z.string(), z.unknown()),
  rationale: z.string(),
  testQuery: z.string().optional(),
  confidence: z.number(),
  impact: z.number(),
  score: z.number(),
  decision: z.enum(["accepted", "rejected", "skipped"]).nullable(),
});

const SessionDetailSchema = z.object({
  session: SessionSummarySchema,
  proposals: z.array(ProposalSchema),
});

const ApproveRejectResponseSchema = z.object({
  ok: z.boolean(),
  proposalIndex: z.number(),
  decision: z.string(),
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
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Admin — Semantic Improve"],
  summary: "List improvement sessions",
  description: "Returns all improvement sessions for the current org.",
  responses: {
    200: {
      description: "Session list",
      content: { "application/json": { schema: z.object({ sessions: z.array(SessionSummarySchema) }) } },
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

const getSessionRoute = createRoute({
  method: "get",
  path: "/sessions/{id}",
  tags: ["Admin — Semantic Improve"],
  summary: "Get session with proposals",
  description: "Returns a session with its ranked proposals and review status.",
  request: {
    params: createParamSchema("id", "550e8400-e29b-41d4-a716-446655440000"),
  },
  responses: {
    200: {
      description: "Session detail",
      content: { "application/json": { schema: SessionDetailSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Session not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const approveProposalRoute = createRoute({
  method: "post",
  path: "/proposals/{id}/approve",
  tags: ["Admin — Semantic Improve"],
  summary: "Approve a proposal",
  description: "Applies the YAML amendment and records it in version history.",
  request: {
    params: createParamSchema("id", "0"),
  },
  responses: {
    200: {
      description: "Proposal approved",
      content: { "application/json": { schema: ApproveRejectResponseSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Proposal or session not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Proposal already reviewed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const rejectProposalRoute = createRoute({
  method: "post",
  path: "/proposals/{id}/reject",
  tags: ["Admin — Semantic Improve"],
  summary: "Reject a proposal",
  description: "Marks the proposal as rejected so the agent will not re-suggest it.",
  request: {
    params: createParamSchema("id", "0"),
  },
  responses: {
    200: {
      description: "Proposal rejected",
      content: { "application/json": { schema: ApproveRejectResponseSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Proposal or session not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Proposal already reviewed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionToSummary(stored: StoredSession): z.infer<typeof SessionSummarySchema> {
  const summary = getSessionSummary(stored.state);
  return {
    id: stored.id,
    ...summary,
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
  };
}

function proposalToJson(
  result: AnalysisResult,
  index: number,
  decision: "accepted" | "rejected" | "skipped" | null,
): z.infer<typeof ProposalSchema> {
  return {
    index,
    entityName: result.entityName,
    category: result.category,
    amendmentType: result.amendmentType,
    amendment: result.amendment,
    rationale: result.rationale,
    testQuery: result.testQuery,
    confidence: result.confidence,
    impact: result.impact,
    score: result.score,
    decision,
  };
}

/** Find the session that contains a proposal at the given index. */
function findSessionForProposal(
  orgId: string,
  proposalIndex: number,
  sessionId?: string,
): { stored: StoredSession; proposal: AnalysisResult } | null {
  // If sessionId is specified, look only in that session
  if (sessionId) {
    const stored = sessions.get(sessionId);
    if (!stored || stored.orgId !== orgId) return null;
    const proposal = stored.state.proposals[proposalIndex];
    if (!proposal) return null;
    return { stored, proposal };
  }

  // Otherwise find the most recent session for this org
  let latest: StoredSession | null = null;
  for (const s of sessions.values()) {
    if (s.orgId !== orgId) continue;
    if (!latest || s.updatedAt > latest.updatedAt) latest = s;
  }
  if (!latest) return null;
  const proposal = latest.state.proposals[proposalIndex];
  if (!proposal) return null;
  return { stored: latest, proposal };
}

/**
 * Advance the session to the target proposal and record the decision.
 * Returns false if the proposal was already reviewed (currentIndex past it).
 */
function advanceAndRecord(
  stored: StoredSession,
  proposalIndex: number,
  decision: "accepted" | "rejected" | "skipped",
): boolean {
  if (stored.state.currentIndex > proposalIndex) {
    return false;
  }
  while (stored.state.currentIndex < proposalIndex) {
    recordDecision(stored.state, "skipped");
  }
  if (stored.state.currentIndex === proposalIndex) {
    recordDecision(stored.state, decision);
  }
  stored.updatedAt = new Date();
  return true;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminSemanticImprove = createAdminRouter();
adminSemanticImprove.use(requireOrgContext());

// POST /chat — streaming expert agent conversation
adminSemanticImprove.openapi(chatStreamRoute, async (c) =>
  runHandler(c, "semantic-improve-chat", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const body = c.req.valid("json");
    const messages = body.messages as UIMessage[];

    // Get or create session
    let sessionId = body.sessionId;
    let stored = sessionId ? sessions.get(sessionId) : undefined;

    if (stored && stored.orgId !== orgId) {
      return c.json({ error: "not_found", message: "Session not found.", requestId }, 404);
    }

    // Build the expert tool registry
    const expertRegistry = buildExpertRegistry();

    // Add session context to the system prompt if resuming
    const sessionContext = stored ? buildSessionContext(stored.state) : "";
    const sessionSystemMessage = sessionContext
      ? `\n\n## Improvement Session Context\n${sessionContext}`
      : "";

    // Build a system prefix for the expert agent
    const expertSystemPrefix = `You are the Atlas Semantic Expert Agent. You analyze and improve the semantic layer by examining data distributions, identifying gaps, and proposing validated amendments.

## Your Goal
Analyze the semantic layer and propose improvements. For each finding:
1. Explain what you found and why it matters
2. Use your tools to gather evidence (profile tables, check distributions, search audit log)
3. Propose a specific amendment with a clear rationale and test query
4. Wait for the user to approve or reject before moving on

## Available Tools
- profileTable: Examine table structure, cardinality, null rates, sample values
- checkDataDistribution: Analyze a column's value distribution
- searchAuditLog: Find query patterns from actual usage
- proposeAmendment: Propose a structured YAML change with rationale and confidence
- validateProposal: Dry-run validate a proposed amendment
- explore: Read semantic YAML files
- executeSQL: Run test queries to validate proposals

## Guidelines
- Start with the highest-impact improvements first
- Always gather evidence before proposing changes
- Set confidence based on evidence strength
- Include test queries to validate amendments
- If the user asks about a specific table or area, focus there${sessionSystemMessage}`;

    try {
      const agentResult = await runAgent({
        messages,
        tools: expertRegistry,
        maxSteps: 15,
        warnings: [expertSystemPrefix],
      });

      // Create session if not existing
      const wasNewSession = !stored;
      if (!stored) {
        sessionId = generateId();
        stored = {
          id: sessionId,
          orgId,
          state: createSession([]),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        sessions.set(sessionId, stored);
      }
      stored.updatedAt = new Date();

      // Audit the draft surface: starting or continuing an expert-agent
      // session that can propose amendments via `proposeAmendment`. The
      // tool may persist a pending `semantic_amendments` row mid-stream,
      // so the audit row is the single anchor for "admin opened the
      // improve chat at time T" even if the stream errors later.
      logAdminAction({
        actionType: ADMIN_ACTIONS.semantic.improveDraft,
        targetType: "semantic",
        targetId: stored.id,
        ipAddress: clientIpFor(c),
        metadata: { sessionId: stored.id, resumed: !wasNewSession },
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
          ...(sessionId ? { "x-session-id": sessionId } : {}),
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
  }),
);

// GET /sessions — list improvement sessions
adminSemanticImprove.openapi(listSessionsRoute, async (c) =>
  runHandler(c, "list-improve-sessions", async () => {
    const { orgId } = c.get("orgContext");

    const orgSessions: z.infer<typeof SessionSummarySchema>[] = [];
    for (const stored of sessions.values()) {
      if (stored.orgId !== orgId) continue;
      orgSessions.push(sessionToSummary(stored));
    }

    // Sort newest first
    orgSessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return c.json({ sessions: orgSessions }, 200);
  }),
);

// GET /sessions/:id — get session with proposals
adminSemanticImprove.openapi(getSessionRoute, async (c) =>
  runHandler(c, "get-improve-session", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const { id } = c.req.valid("param");

    const stored = sessions.get(id);
    if (!stored || stored.orgId !== orgId) {
      return c.json({ error: "not_found", message: "Session not found.", requestId }, 404);
    }

    const proposals = stored.state.proposals.map((p, i) => {
      const reviewed = stored.state.reviewed.find((r) => r.result === p);
      return proposalToJson(p, i, reviewed?.decision ?? null);
    });

    return c.json({
      session: sessionToSummary(stored),
      proposals,
    }, 200);
  }),
);

// POST /proposals/:id/approve — approve a proposal
adminSemanticImprove.openapi(approveProposalRoute, async (c) =>
  runHandler(c, "approve-improve-proposal", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const { id: rawId } = c.req.valid("param");
    const proposalIndex = parseInt(rawId, 10);

    if (!Number.isFinite(proposalIndex) || proposalIndex < 0) {
      return c.json({ error: "invalid_id", message: "Proposal ID must be a non-negative integer (the proposal index).", requestId }, 400);
    }

    const match = findSessionForProposal(orgId, proposalIndex);
    if (!match) {
      return c.json({ error: "not_found", message: "Proposal not found. Start an improvement session first.", requestId }, 404);
    }

    const { stored, proposal } = match;

    // Check if already reviewed
    if (stored.state.currentIndex > proposalIndex) {
      return c.json({ error: "already_reviewed", message: `Proposal ${proposalIndex} has already been reviewed.`, requestId }, 409);
    }

    // Apply the amendment to YAML
    try {
      const { applyAmendmentToEntity } = await import("@atlas/api/lib/semantic/expert/apply");
      await applyAmendmentToEntity(orgId, proposal, requestId);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), requestId, orgId },
        "Failed to apply amendment",
      );
      return c.json({
        error: "apply_failed",
        message: `Failed to apply amendment: ${err instanceof Error ? err.message : String(err)}`,
        requestId,
      }, 500);
    }

    // Record decision in session state (separate from YAML apply)
    advanceAndRecord(stored, proposalIndex, "accepted");

    logAdminAction({
      actionType: ADMIN_ACTIONS.semantic.improveAccept,
      targetType: "semantic",
      targetId: stored.id,
      ipAddress: clientIpFor(c),
      metadata: {
        id: stored.id,
        sessionId: stored.id,
        proposalIndex,
        entityName: proposal.entityName,
        amendmentType: proposal.amendmentType,
      },
    });

    log.info({ requestId, orgId, proposalIndex, entity: proposal.entityName }, "Proposal approved");
    return c.json({ ok: true, proposalIndex, decision: "accepted" }, 200);
  }),
);

// POST /proposals/:id/reject — reject a proposal
adminSemanticImprove.openapi(rejectProposalRoute, async (c) =>
  runHandler(c, "reject-improve-proposal", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const { id: rawId } = c.req.valid("param");
    const proposalIndex = parseInt(rawId, 10);

    if (!Number.isFinite(proposalIndex) || proposalIndex < 0) {
      return c.json({ error: "invalid_id", message: "Proposal ID must be a non-negative integer (the proposal index).", requestId }, 400);
    }

    const match = findSessionForProposal(orgId, proposalIndex);
    if (!match) {
      return c.json({ error: "not_found", message: "Proposal not found. Start an improvement session first.", requestId }, 404);
    }

    if (match.stored.state.currentIndex > proposalIndex) {
      return c.json({ error: "already_reviewed", message: `Proposal ${proposalIndex} has already been reviewed.`, requestId }, 409);
    }

    advanceAndRecord(match.stored, proposalIndex, "rejected");

    logAdminAction({
      actionType: ADMIN_ACTIONS.semantic.improveReject,
      targetType: "semantic",
      targetId: match.stored.id,
      ipAddress: clientIpFor(c),
      metadata: {
        id: match.stored.id,
        sessionId: match.stored.id,
        proposalIndex,
        entityName: match.proposal.entityName,
      },
    });

    log.info({ requestId, orgId, proposalIndex }, "Proposal rejected");
    return c.json({ ok: true, proposalIndex, decision: "rejected" }, 200);
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
        const { applyAmendmentToEntity } = await import("@atlas/api/lib/semantic/expert/apply");
        const { ANALYSIS_CATEGORIES } = await import("@atlas/api/lib/semantic/expert/types");
        const { AMENDMENT_TYPES } = await import("@useatlas/types");

        const rawCategory = String(payload.category ?? "coverage_gaps");
        const rawAmendmentType = String(payload.amendmentType ?? "update_description");

        // This throws on failure — runHandler maps it to 500
        await applyAmendmentToEntity(orgId, {
          entityName: target.source_entity,
          category: (ANALYSIS_CATEGORIES as readonly string[]).includes(rawCategory)
            ? rawCategory as typeof ANALYSIS_CATEGORIES[number]
            : "coverage_gaps",
          amendmentType: (AMENDMENT_TYPES as readonly string[]).includes(rawAmendmentType)
            ? rawAmendmentType as typeof AMENDMENT_TYPES[number]
            : "update_description",
          amendment: payload,
          rationale: typeof payload.rationale === "string" ? payload.rationale : "",
          confidence: 0,
          impact: 0,
          score: 0,
          staleness: 0,
        }, requestId);
      }
    }

    // YAML applied (or rejection) — now update DB status
    const reviewed = await reviewSemanticAmendment(id, orgId, decision, "admin");

    if (!reviewed) {
      return c.json({ error: "not_found", message: "Amendment not found or already reviewed.", requestId }, 404);
    }

    // Action type reflects the intent, not the route path — an approved
    // review fires `improve_apply` (YAML was written); a rejected review
    // fires `improve_reject` so compliance queries filtering on a single
    // action_type catch both in-memory (proposals) and DB-backed
    // (amendments) rejections.
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
    const { loadEntitiesFromDisk, loadGlossaryFromDisk } =
      await import("@atlas/api/lib/semantic/expert/context-loader");
    const { computeSemanticHealth } = await import("@atlas/api/lib/semantic/expert/health");

    const entities = await loadEntitiesFromDisk();
    const glossary = await loadGlossaryFromDisk();

    const score = computeSemanticHealth({
      profiles: [],
      entities,
      glossary,
      auditPatterns: [],
      rejectedKeys: new Set(),
    });

    return c.json(score, 200);
  }),
);

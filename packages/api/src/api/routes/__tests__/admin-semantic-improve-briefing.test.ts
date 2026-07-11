/**
 * The Briefing at the route → agent seam (#4514 AC2).
 *
 * Drives POST /chat with the LLM mocked (runAgent captured) and the REAL briefing
 * loader running against mocked leaf seams (tracked profiles, the amendment
 * queue, entities). Pins the two load-bearing behaviors:
 *
 *   1. Turn one — the assembled briefing is front-loaded into runAgent (the
 *      `briefing` seam that `buildSystemParam` folds into the system prompt), so
 *      the expert agent learns the health/findings/queue WITHOUT a tool call.
 *   2. A panel rejection is reflected in the NEXT turn's context — because the
 *      briefing is re-assembled from live state each turn, a decided row leaving
 *      the pending queue (and surfacing in "recent decisions") shows up on the
 *      following turn with no synthetic transcript message.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

let mockPending: Array<Record<string, unknown>> = [];
let mockDecided: Array<Record<string, unknown>> = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async () => [],
  setWorkspaceRegion: async () => {},
  getPendingAmendments: async () => mockPending,
  getRecentlyDecidedAmendments: async () => mockDecided,
  getPendingAmendmentCount: async () => mockPending.length,
}));

void mock.module("@atlas/api/lib/semantic/expert/context-loader", () => ({
  loadEntitiesForOrg: async () => ({
    entities: [
      {
        name: "orders",
        table: "orders",
        description: "Order records",
        dimensions: [{ name: "id", sql: "id", type: "number", description: "Primary key" }],
        measures: [{ name: "count", sql: "COUNT(*)", type: "count", description: "Order count" }],
        joins: [],
        query_patterns: [],
      },
    ],
    totalRows: 1,
    parseFailures: 0,
  }),
  loadEntitiesFromDisk: async () => [],
  loadGlossaryFromDisk: async () => [],
  loadAuditPatterns: async () => [],
  loadRejectedKeys: async () => new Set(),
}));

void mock.module("@atlas/api/lib/semantic/connection-profile", () => ({
  listConnectionProfileStates: async () => [
    {
      installId: "us_prod",
      connectionGroupId: null,
      dbType: "postgres",
      baseline: { profiledAt: "2026-07-08T00:00:00Z", tableCount: 12 },
      baselineError: null,
      llm: null,
    },
  ],
  getBaselineProfiles: async () => [],
  describeProfileFreshness: (iso: string | null) =>
    iso ? { days: 3, label: "profiled 3 days ago" } : null,
}));

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "user-1",
        mode: "managed",
        label: "admin@test.dev",
        role: "admin",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: true },
      },
    }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    withRequestContext: (_ctx: Record<string, unknown>, fn: () => unknown) => fn(),
    getRequestContext: () => ({ requestId: "test-req-id" }),
  };
});

void mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (
    c: { json: (body: unknown, status?: number) => Response },
    _label: string,
    fn: () => unknown,
  ) => {
    try {
      return await fn();
    } catch (err) {
      return c.json(
        { error: "internal_error", message: err instanceof Error ? err.message : String(err), requestId: "test-req-id" },
        500,
      );
    }
  },
  runEffect: async (_c: unknown, effect: unknown) => effect,
}));

void mock.module("@atlas/api/lib/security/abuse", () => ({ checkAbuseStatus: () => ({ level: "ok" }) }));
void mock.module("@atlas/api/lib/workspace", () => ({ checkWorkspaceStatus: async () => ({ allowed: true }) }));
void mock.module("@atlas/api/lib/billing/enforcement", () => ({ checkPlanLimits: async () => ({ allowed: true }) }));
void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: async () => ({ allowed: true }),
}));

let runAgentArgs: Record<string, unknown> | undefined;
void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: async (args: Record<string, unknown>) => {
    runAgentArgs = args;
    return { toUIMessageStream: () => new ReadableStream() };
  },
}));

void mock.module("@atlas/api/lib/tools/expert-registry", () => ({
  buildExpertRegistry: () => ({ getAll: () => ({}), freeze: () => {} }),
}));

import { adminSemanticImprove } from "../admin-semantic-improve";

async function postChat(): Promise<Response> {
  return adminSemanticImprove.request("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Improve the orders entity." }] }],
    }),
  });
}

const pendingRow = {
  id: "p1",
  source_entity: "orders",
  connection_group_id: null,
  description: "add a revenue measure",
  confidence: 0.9,
  amendment_payload: { amendmentType: "add_measure", rationale: "orders.amount is aggregated often" },
  last_apply_error: null,
  created_at: "2026-07-10",
};

describe("semantic-improve briefing at the route → agent seam (#4514 AC2)", () => {
  beforeEach(() => {
    runAgentArgs = undefined;
    mockPending = [];
    mockDecided = [];
  });

  it("turn one front-loads the briefing into the agent (no tool call needed)", async () => {
    mockPending = [{ ...pendingRow }];

    const res = await postChat();
    expect(res.status).toBe(200);

    const briefing = runAgentArgs?.briefing as string | undefined;
    expect(typeof briefing).toBe("string");
    expect(briefing).toContain("## Semantic layer briefing");
    expect(briefing).toContain("### Health:");
    // The pending queue and the tracked-profile freshness are in the prompt.
    expect(briefing).toContain("### Pending review queue (1)");
    expect(briefing).toContain("orders · add_measure");
    expect(briefing).toContain("us_prod (postgres): profiled 3 days ago");
    // The persona still rides the first-class role seam alongside it.
    expect(typeof runAgentArgs?.persona).toBe("string");
  });

  it("a panel rejection is reflected in the next turn's briefing", async () => {
    // Turn one: the amendment is queued.
    mockPending = [{ ...pendingRow }];
    await postChat();
    expect(runAgentArgs?.briefing as string).toContain("### Pending review queue (1)");
    expect(runAgentArgs?.briefing as string).toContain("orders · add_measure");

    // The admin rejects it in the panel: it leaves the pending queue and lands in
    // recent decisions (what the review route does to the DB).
    mockPending = [];
    mockDecided = [
      { id: "p1", source_entity: "orders", connection_group_id: null, amendment_payload: { amendmentType: "add_measure" }, status: "rejected", reviewed_at: "2026-07-11" },
    ];

    // Turn two: the briefing is re-assembled from live state — the rejection
    // shows up with no synthetic message in the transcript.
    await postChat();
    const briefing2 = runAgentArgs?.briefing as string;
    expect(briefing2).toContain("### Pending review queue (0)");
    expect(briefing2).toContain("Empty — nothing is awaiting");
    expect(briefing2).toContain("rejected: orders · add_measure");
  });
});

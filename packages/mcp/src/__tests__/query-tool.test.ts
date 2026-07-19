import { describe, expect, it, mock, beforeEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { getRequestContext } from "@atlas/api/lib/logger";
import { parseAtlasMcpToolError } from "@useatlas/types/mcp";
import { queryOutputSchema } from "../structured-output.js";
import { MCP_APPROVAL_RESUME_HINT } from "../structured-output.js";

const TEST_ACTOR = createAtlasUser("u_test", "managed", "test@example.com", {
  role: "admin",
  activeOrganizationId: "org_test",
});

// --- executeAgentQuery mock (#4094) ---
// The query tool dispatches into `executeAgentQuery` in-process. Tests drive
// its return value (or make it throw a typed gate error) to exercise every
// branch. Default: a plain successful agent answer.
type AgentResult = {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
  pendingApproval?: {
    requestId: string | null;
    ruleName: string;
    matchedRules: string[];
    message: string;
  };
};

const DEFAULT_RESULT: AgentResult = {
  answer: "Revenue was $1.2M last quarter.",
  sql: ["SELECT sum(amount) FROM orders WHERE quarter = 'Q1'"],
  data: [{ columns: ["sum"], rows: [{ sum: 1_200_000 }] }],
  steps: 3,
  usage: { totalTokens: 4210 },
};

const mockExecuteAgentQuery = mock<(...args: unknown[]) => Promise<AgentResult>>(
  async () => DEFAULT_RESULT,
);

void mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mockExecuteAgentQuery,
}));

// --- Typed gate error classes ---
// Mirror the real shapes just enough for the query tool's `instanceof` mapping.
// Both the tool body (lazy import) and this test get the SAME class reference
// from the mocked module, so `instanceof` works.
class BillingBlockedError extends Error {
  override readonly name = "BillingBlockedError";
  readonly errorCode: string;
  readonly httpStatus: 403 | 404 | 429 | 503;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly usage: undefined;
  constructor(block: {
    errorCode: string;
    errorMessage: string;
    httpStatus: 403 | 404 | 429 | 503;
    retryable: boolean;
    retryAfterSeconds?: number;
  }) {
    super(block.errorMessage);
    this.errorCode = block.errorCode;
    this.httpStatus = block.httpStatus;
    this.retryable = block.retryable;
    this.retryAfterSeconds = block.retryAfterSeconds;
    this.usage = undefined;
  }
}

class ClaimRequiredError extends Error {
  override readonly name = "ClaimRequiredError";
  readonly claimUrl: string;
  readonly errorCode = "claim_required" as const;
  readonly httpStatus = 403 as const;
  constructor(claimUrl: string) {
    super(`Verify your email and finish setup on the web to continue: ${claimUrl}`);
    this.claimUrl = claimUrl;
  }
}

class ClaimCheckFailedError extends Error {
  override readonly name = "ClaimCheckFailedError";
  readonly errorCode = "claim_check_failed" as const;
  readonly httpStatus = 503 as const;
  readonly retryable = true as const;
  constructor() {
    super("Unable to verify your workspace's claim status. Please try again.");
  }
}

// --- Billing gate-0 mock (#3437) ---
// The `query` tool declares `checksBilling`, so the ADR-0016 gate-0 solvency
// check (`checkAgentBillingGate`, via `billing-gate.ts`) runs before the agent.
type GateVerdict =
  | { allowed: true }
  | {
      allowed: false;
      errorCode: string;
      errorMessage: string;
      httpStatus: 403 | 404 | 429 | 503;
      retryable: boolean;
      retryAfterSeconds?: number;
    };
let billingGateVerdict: GateVerdict = { allowed: true };
const mockCheckAgentBillingGate = mock(async (_orgId: string | undefined) => billingGateVerdict);

void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mockCheckAgentBillingGate,
  BillingBlockedError,
}));

void mock.module("@atlas/api/lib/billing/claim-gate", () => ({
  buildClaimUrl: (email?: string) => `https://app.useatlas.dev/claim?email=${email ?? ""}`,
  ClaimRequiredError,
  ClaimCheckFailedError,
  checkClaimGate: mock(async () => ({ allowed: true })),
}));

// Import after mocks are set up.
const { registerQueryTool, _setQueryHeartbeatIntervalMsForTest } = await import(
  "../query-tool.js"
);

function getContentText(content: unknown): string {
  const arr = content as Array<{ type: string; text: string }>;
  return arr[0]?.text ?? "";
}

async function createTestClient(
  actor = TEST_ACTOR,
  clientId?: string,
  scopes?: readonly string[],
) {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerQueryTool(server, {
    actor,
    transport: "stdio",
    workspaceId: actor.activeOrganizationId ?? actor.id,
    deployMode: "saas",
    ...(clientId ? { clientId } : {}),
    ...(scopes ? { scopes } : {}),
  });

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("MCP query tool (#4094)", () => {
  beforeEach(() => {
    mockExecuteAgentQuery.mockClear();
    mockExecuteAgentQuery.mockImplementation(async () => DEFAULT_RESULT);
    billingGateVerdict = { allowed: true };
    mockCheckAgentBillingGate.mockClear();
    // #4734 — keep the keepalive interval long by default so the fast-resolving
    // mocks in the rest of the suite never fire a stray heartbeat; the slow-run
    // test shortens it locally.
    _setQueryHeartbeatIntervalMsForTest(60_000);
  });

  it("is registered as a read-only, open-world tool advertising the error contract", async () => {
    const { client } = await createTestClient();
    const { tools } = await client.listTools();
    const query = tools.find((t) => t.name === "query");

    expect(query).toBeDefined();
    expect(query?.annotations?.readOnlyHint).toBe(true);
    expect(query?.annotations?.openWorldHint).toBe(true);
    expect(query?.outputSchema).toBeDefined();
    // The LLM-facing description must advertise the codes it can branch on.
    expect(query?.description).toContain("Error contract");
    expect(query?.description).toContain("`billing_blocked`");
    expect(query?.description).toContain("recommended path");
  });

  it("returns the agent's answer + SQL + data as schema-valid structured output", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "query",
      arguments: { question: "How much revenue last quarter?" },
    });

    expect(mockExecuteAgentQuery).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();

    // Structured output present + schema-valid.
    expect(result.structuredContent).toBeDefined();
    const validated = queryOutputSchema.parse(result.structuredContent);
    expect(validated.answer).toBe(DEFAULT_RESULT.answer);
    expect(validated.sql).toEqual(DEFAULT_RESULT.sql);
    expect(validated.data).toEqual(DEFAULT_RESULT.data);
    expect(validated.steps).toBe(3);
    // The double-billing cost is surfaced back to the caller.
    expect(validated.usage?.total_tokens).toBe(4210);

    // Retained text block mirrors the structured payload.
    expect(JSON.parse(getContentText(result.content))).toEqual(result.structuredContent);
  });

  it("drives a keepalive heartbeat during a >interval run so the transport stays warm (#4734)", async () => {
    // The POST SSE stream emits zero app bytes during the agent run, so without
    // a heartbeat an intermediary idle-timeout (~120s) drops the transport. A
    // run longer than the (shortened) heartbeat interval must produce interim
    // progress notifications between the start(0) and final(1) emits.
    _setQueryHeartbeatIntervalMsForTest(10);
    mockExecuteAgentQuery.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 55));
      return DEFAULT_RESULT;
    });

    const { client } = await createTestClient();
    const progresses: number[] = [];
    const result = await client.callTool(
      { name: "query", arguments: { question: "a slow question" } },
      undefined,
      { onprogress: (p) => progresses.push(p.progress) },
    );

    expect(result.isError).toBeFalsy();
    // At least one interim heartbeat fired strictly between start and end — the
    // bytes that keep the stream alive mid-run.
    const interim = progresses.filter((v) => v > 0 && v < 1);
    expect(interim.length).toBeGreaterThanOrEqual(1);
    // The whole sequence is monotonically non-decreasing (start 0 → … → final 1).
    expect(progresses[0]).toBe(0);
    expect(progresses.at(-1)).toBe(1);
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i]).toBeGreaterThanOrEqual(progresses[i - 1]);
    }
  });

  it("clears the heartbeat timer once the query settles (no leaked interval)", async () => {
    // After the query returns, no further progress notifications must fire — a
    // leaked setInterval would keep emitting past settlement.
    _setQueryHeartbeatIntervalMsForTest(10);
    mockExecuteAgentQuery.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return DEFAULT_RESULT;
    });

    const { client } = await createTestClient();
    const progresses: number[] = [];
    await client.callTool(
      { name: "query", arguments: { question: "another slow question" } },
      undefined,
      { onprogress: (p) => progresses.push(p.progress) },
    );
    const countAtSettle = progresses.length;
    // Wait several more intervals — a cleared timer emits nothing further.
    await new Promise((r) => setTimeout(r, 40));
    expect(progresses.length).toBe(countAtSettle);
  });

  it("threads the question + connectionId into executeAgentQuery", async () => {
    const { client } = await createTestClient();
    await client.callTool({
      name: "query",
      arguments: { question: "top products", connectionId: "warehouse" },
    });

    const calls = mockExecuteAgentQuery.mock.calls;
    const [question, _requestId, options] = calls[calls.length - 1] as [
      string,
      string,
      { connectionId?: string },
    ];
    expect(question).toBe("top products");
    expect(options.connectionId).toBe("warehouse");
  });

  it("omits connectionId when the caller doesn't supply one (default connection)", async () => {
    const { client } = await createTestClient();
    await client.callTool({ name: "query", arguments: { question: "anything" } });

    const calls = mockExecuteAgentQuery.mock.calls;
    const options = (calls[calls.length - 1] as unknown[])[2] as Record<string, unknown>;
    expect("connectionId" in options).toBe(false);
  });

  it("dispatches with a bound mcp actor + origin=mcp so audit + approval rules see the caller", async () => {
    let observed: ReturnType<typeof getRequestContext>;
    mockExecuteAgentQuery.mockImplementationOnce(async () => {
      observed = getRequestContext();
      return DEFAULT_RESULT;
    });

    const { client } = await createTestClient(TEST_ACTOR, "claude-desktop");
    await client.callTool({ name: "query", arguments: { question: "probe" } });

    expect(observed!.user?.id).toBe(TEST_ACTOR.id);
    expect(observed!.user?.activeOrganizationId).toBe("org_test");
    expect(observed!.actor).toEqual({
      kind: "mcp",
      clientId: "claude-desktop",
      toolName: "query",
    });
    expect(observed!.agentOrigin).toBe("mcp");
  });

  it("surfaces a parked approval as approval_required (not an error) with a resume hint", async () => {
    mockExecuteAgentQuery.mockImplementationOnce(async () => ({
      ...DEFAULT_RESULT,
      answer: "This query needs approval before it can run.",
      pendingApproval: {
        requestId: "appr_xyz789",
        ruleName: "pii-tables",
        matchedRules: ["pii-tables"],
        message: 'This query requires approval before execution. Rule: "pii-tables".',
      },
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "query",
      arguments: { question: "show me every customer's email" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = queryOutputSchema.parse(result.structuredContent);
    expect(parsed.approval_required).toBe(true);
    expect(parsed.approval_request_id).toBe("appr_xyz789");
    expect(parsed.matched_rules).toEqual(["pii-tables"]);
    // The resume protocol must be spelled out for the MCP client.
    expect(parsed.message).toContain(MCP_APPROVAL_RESUME_HINT);
  });

  it("omits approval_request_id when the parked approval has no queued row (null id)", async () => {
    // PendingApproval.requestId is `string | null` — null on the no-org /
    // identityMissing path (agent-query.ts), i.e. the stdio self-hosted shape.
    // The tool must NOT emit `approval_request_id: null` (which fails the
    // z.string() output-schema field); the field is simply absent.
    mockExecuteAgentQuery.mockImplementationOnce(async () => ({
      ...DEFAULT_RESULT,
      pendingApproval: {
        requestId: null,
        ruleName: "approval-required",
        matchedRules: [],
        message: "This query requires approval before execution.",
      },
    }));

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "query",
      arguments: { question: "show me customer PII" },
    });

    expect(result.isError).toBeFalsy();
    // Schema-valid despite the null id (would throw if `null` leaked through).
    const parsed = queryOutputSchema.parse(result.structuredContent);
    expect(parsed.approval_required).toBe(true);
    expect(parsed.approval_request_id).toBeUndefined();
    expect("approval_request_id" in (result.structuredContent as object)).toBe(false);
  });

  it("rejects an empty question before dispatching (input bound)", async () => {
    const { client } = await createTestClient();
    // The MCP SDK enforces the input schema (`.trim().min(1)`) before dispatch.
    // A whitespace-only question must not reach the agent — no wasted Atlas
    // tokens on a malformed call. The SDK surfaces the schema violation either
    // as a rejection or an `isError` result depending on version; the invariant
    // we pin is that the agent never ran.
    let rejected = false;
    let result: Awaited<ReturnType<typeof client.callTool>> | undefined;
    try {
      result = await client.callTool({ name: "query", arguments: { question: "   " } });
    } catch {
      rejected = true;
    }
    expect(rejected || result?.isError === true).toBe(true);
    expect(mockExecuteAgentQuery).not.toHaveBeenCalled();
  });

  it("maps an unclaimed-trial ClaimRequiredError to billing_blocked carrying the claim URL", async () => {
    mockExecuteAgentQuery.mockImplementationOnce(async () => {
      throw new ClaimRequiredError("https://app.useatlas.dev/claim?email=a@b.co");
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "query",
      arguments: { question: "revenue?" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("billing_blocked");
    expect(envelope!.hint).toContain("https://app.useatlas.dev/claim");
  });

  it("fails closed as retryable internal_error when claim status is unverifiable", async () => {
    mockExecuteAgentQuery.mockImplementationOnce(async () => {
      throw new ClaimCheckFailedError();
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "query",
      arguments: { question: "revenue?" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.request_id).toMatch(/^mcp-query-/);
    expect(envelope!.retry_after).toBe(2);
  });

  it("maps a mid-run BillingBlockedError throttle to rate_limited with retry_after", async () => {
    mockExecuteAgentQuery.mockImplementationOnce(async () => {
      throw new BillingBlockedError({
        errorCode: "workspace_throttled",
        errorMessage: "Workspace is temporarily throttled. Retry shortly.",
        httpStatus: 429,
        retryable: true,
        retryAfterSeconds: 7,
      });
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "query",
      arguments: { question: "revenue?" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("rate_limited");
    expect(envelope!.retry_after).toBe(7);
  });

  it("maps a mid-run BillingBlockedError suspension to billing_blocked", async () => {
    mockExecuteAgentQuery.mockImplementationOnce(async () => {
      throw new BillingBlockedError({
        errorCode: "workspace_suspended",
        errorMessage: "Workspace suspended. Contact your administrator.",
        httpStatus: 403,
        retryable: false,
      });
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "query",
      arguments: { question: "revenue?" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("billing_blocked");
    expect(envelope!.hint).toBeDefined();
  });

  it("maps a mid-run BillingBlockedError 503 (check failure) to a retryable internal_error", async () => {
    // The distinct third arm: a 503 infra fault must surface as internal_error
    // (retryable, quote the request id), NOT billing_blocked — mis-signalling
    // "upgrade your plan" for what is an operator-side blip.
    mockExecuteAgentQuery.mockImplementationOnce(async () => {
      throw new BillingBlockedError({
        errorCode: "workspace_check_failed",
        errorMessage: "Unable to verify workspace status. Please try again.",
        httpStatus: 503,
        retryable: true,
      });
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "query",
      arguments: { question: "revenue?" },
    });

    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.request_id).toMatch(/^mcp-query-/);
  });

  it("falls back to internal_error with request_id on an unexpected throw", async () => {
    mockExecuteAgentQuery.mockImplementationOnce(async () => {
      throw new Error("provider exploded");
    });

    const { client } = await createTestClient();
    const result = await client.callTool({
      name: "query",
      arguments: { question: "revenue?" },
    });

    expect(result.isError).toBe(true);
    const envelope = parseAtlasMcpToolError(getContentText(result.content));
    expect(envelope!.code).toBe("internal_error");
    expect(envelope!.message).toContain("provider exploded");
    expect(envelope!.request_id).toMatch(/^mcp-query-/);
  });

  describe("gate-0 billing (#3437)", () => {
    it("returns billing_blocked and never runs the agent when the workspace is suspended", async () => {
      billingGateVerdict = {
        allowed: false,
        errorCode: "workspace_suspended",
        errorMessage: "Workspace suspended due to unusual activity.",
        httpStatus: 403,
        retryable: false,
      };

      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "query",
        arguments: { question: "revenue?" },
      });

      expect(result.isError).toBe(true);
      const envelope = parseAtlasMcpToolError(getContentText(result.content));
      expect(envelope!.code).toBe("billing_blocked");
      // Agent never ran — zero Atlas-token spend on a blocked workspace.
      expect(mockExecuteAgentQuery).not.toHaveBeenCalled();
      // Gate-0 consulted the actor's workspace (the org-vs-actor.id distinction
      // is the dispatch-gate's concern and is pinned there; here both happen to
      // equal "org_test").
      expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org_test");
    });

    it("proceeds and runs the agent once when the gate allows", async () => {
      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "query",
        arguments: { question: "revenue?" },
      });

      expect(result.isError).toBeFalsy();
      expect(mockCheckAgentBillingGate).toHaveBeenCalledWith("org_test");
      expect(mockExecuteAgentQuery).toHaveBeenCalledTimes(1);
    });
  });
});

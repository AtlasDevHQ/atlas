/**
 * #3750 — MCP approval-park + resume-by-re-call.
 *
 * MCP has no agent loop or durable run row: each tool call is one synchronous
 * dispatch and the MCP client is the loop. So a "parked" MCP tool call is one
 * whose approval gate returned `approval_required` instead of executing, and
 * the resume is the client RE-CALLING the same tool once the request is
 * approved. The executeSQL approval gate (`lib/tools/sql.ts`) recognises the
 * prior approval via `hasApprovedRequest` and lets the re-call execute, with
 * auth/whitelist/RLS re-resolved live on that fresh dispatch.
 *
 * This pins the MCP-boundary contract:
 *   1. a parked call surfaces a NON-ERROR `approval_required` result carrying
 *      `approval_request_id`, `matched_rules`, and a resume hint;
 *   2. the resume hint tells the client to re-run the identical call;
 *   3. re-calling after approval (modelled by `executeSQL.execute` now
 *      returning a data result) yields a successful, structured result.
 *
 * The SQL-gate dedup itself (`hasApprovedRequest`) is exercised by
 * `lib/tools/__tests__/sql-approval*.test.ts`; here we mock `executeSQL.execute`
 * so the test owns the park→approve transition at the MCP relay seam — which is
 * exactly the behaviour #3750 adds to (and asserts for) the MCP surface.
 */

import { describe, expect, it, mock } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAtlasUser } from "@atlas/api/lib/auth/types";
import { MCP_APPROVAL_RESUME_HINT } from "../structured-output.js";

const TEST_ACTOR = createAtlasUser("u_resume", "managed", "resume@test", {
  role: "member",
  activeOrganizationId: "org_resume",
});

const __mockedConfig = {
  datasources: {},
  tools: ["explore", "executeSQL"],
  auth: "auto",
  semanticLayer: "./semantic",
  source: "env",
};
mock.module("@atlas/api/lib/config", () => ({
  initializeConfig: mock(async () => __mockedConfig),
  getConfig: mock(() => __mockedConfig),
  loadConfig: mock(async () => __mockedConfig),
  configFromEnv: mock(() => __mockedConfig),
  validateAndResolve: mock(() => __mockedConfig),
  defineConfig: (c: unknown) => c,
  applyDatasources: mock(async () => undefined),
  validateToolConfig: mock(async () => undefined),
  formatZodErrors: () => "",
  _resetConfig: mock(() => undefined),
  _setConfigForTest: mock(() => undefined),
  _warnPoolDefaultsInSaaS: mock(() => undefined),
}));

// Gate-1 action policy (#4095): executeSQL declares actionCategory "raw_sql",
// so the dispatch gate consults the per-workspace policy. Stub it all-allowed
// (no real `mcp_action_policy` table here) — mock ALL runtime exports so a
// sibling test loading the real module doesn't inherit a partial mock (CLAUDE.md).
mock.module("@atlas/api/lib/mcp/action-policy", () => ({
  loadMcpActionPolicy: async () => ({ isBlocked: () => false }),
  mcpActionDenialCopy: (category: string) => ({
    message: `MCP '${category}' actions are disabled for this workspace by an administrator.`,
    hint: "A workspace admin can re-enable this category under Admin → MCP action policy.",
  }),
  MCP_ACTION_CATEGORIES: ["datasource", "integration", "policy", "raw_sql"],
  MCP_ACTION_CATEGORY_META: [],
  isMcpActionCategory: (v: string) =>
    ["datasource", "integration", "policy", "raw_sql"].includes(v),
  getMcpActionPolicyEntries: async () => [],
  setMcpActionCategoryStatus: async () => {},
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  explore: {
    description: "Explore the semantic layer",
    execute: mock(async () => "catalog.yml"),
  },
}));

// Gate 0 (billing solvency) runs before the tool body. The dev/CI shell may
// have DATABASE_URL set; without a reachable DB `checkWorkspaceStatus` fails
// CLOSED (workspace_check_failed) and the dispatch never reaches the tool. We
// are pinning the MCP approval-relay seam, not billing — so allow the gate.
// `BillingBlockedError` is re-exported as the REAL class so the dispatch's
// `instanceof` mapping is preserved (mock-all-exports discipline).
const { BillingBlockedError: RealBillingBlockedError } = await import(
  "@atlas/api/lib/billing/agent-gate"
);
mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: mock(async () => ({ allowed: true })),
  BillingBlockedError: RealBillingBlockedError,
}));

// `executeSQL.execute` parks on the first call (approval_required) and
// executes on the second (the dedup let the re-call through). The call count
// drives the park→approve transition deterministically.
let executeCalls = 0;
const APPROVAL_REQUEST_ID = "appr_req_3750";
mock.module("@atlas/api/lib/tools/sql", () => ({
  executeSQL: {
    description: "Execute SQL",
    execute: mock(async () => {
      executeCalls += 1;
      if (executeCalls === 1) {
        // Parked: approval gate returned needs-approval (success:false is how
        // sql.ts marks the governance outcome; see agent-query.ts:312).
        return {
          success: false,
          approval_required: true,
          approval_request_id: APPROVAL_REQUEST_ID,
          matched_rules: ["Production write guard"],
          message: 'This query requires approval before execution. Rule: "Production write guard".',
        };
      }
      // Resumed by re-call after approval: the gate executed the query.
      return {
        success: true,
        explanation: "Row count of orders",
        row_count: 1,
        columns: ["count"],
        rows: [{ count: 42 }],
        truncated: false,
      };
    }),
  },
}));

const { createAtlasMcpServer } = await import("../server.js");

async function connectClient() {
  const server = await createAtlasMcpServer({ actor: TEST_ACTOR });
  const client = new Client({ name: "resume-test", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseText(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown }).content as
    | Array<{ type: string; text: string }>
    | undefined;
  return JSON.parse(content?.[0]?.text ?? "{}");
}

describe("MCP executeSQL approval-park + resume-by-re-call (#3750)", () => {
  it("a parked call surfaces a non-error approval_required result with id, rules, and the resume hint", async () => {
    executeCalls = 0;
    const client = await connectClient();

    const parked = await client.callTool({
      name: "executeSQL",
      arguments: { sql: "SELECT count(*) FROM orders", explanation: "count orders" },
    });

    // Governance outcome is NOT an MCP error — the client must see the payload.
    expect(parked.isError).toBeFalsy();
    const body = parseText(parked);
    expect(body.approval_required).toBe(true);
    expect(body.approval_request_id).toBe(APPROVAL_REQUEST_ID);
    expect(body.matched_rules).toEqual(["Production write guard"]);
    // AC1 / AC3 enablement — the client is told HOW to resume.
    expect(String(body.message)).toContain(MCP_APPROVAL_RESUME_HINT);

    // structuredContent mirrors the text body (outputSchema is declared).
    const structured = (parked as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    expect(structured?.approval_required).toBe(true);
    expect(structured?.approval_request_id).toBe(APPROVAL_REQUEST_ID);
  });

  it("re-calling the identical tool after approval resumes to a successful result", async () => {
    executeCalls = 0;
    const client = await connectClient();
    const args = { sql: "SELECT count(*) FROM orders", explanation: "count orders" };

    // 1st call parks.
    const parked = await client.callTool({ name: "executeSQL", arguments: args });
    expect(parseText(parked).approval_required).toBe(true);

    // 2nd call (same arguments) — approval granted between calls; executes.
    const resumed = await client.callTool({ name: "executeSQL", arguments: args });
    expect(resumed.isError).toBeFalsy();
    const body = parseText(resumed);
    expect(body.approval_required).toBeUndefined();
    expect(body.row_count).toBe(1);
    expect(body.columns).toEqual(["count"]);
    expect(body.rows).toEqual([{ count: 42 }]);

    // Exactly two executions: one park, one resume — no silent re-park or
    // duplicate approval request.
    expect(executeCalls).toBe(2);
  });
});

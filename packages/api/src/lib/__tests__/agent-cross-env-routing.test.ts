/**
 * Integration tests for the agent-decided cross-environment `executeSQL`
 * `scope` parameter (PRD #2515, slice 1 #2516).
 *
 * Exercises the full LLM → agent loop → executeSQL fanout → merger flow
 * with `MockLanguageModelV3` standing in for the model. The model emits
 * `scope: "all"` / a named member id / no scope, and the tests assert
 * that:
 *   - `scope: "all"` produces N parallel `db.query` calls and a merged
 *     result with an `__env__` column carrying every member's id;
 *   - `scope: "<member id>"` produces exactly one execution against that
 *     member;
 *   - a partial-failure fanout still returns success with rows from the
 *     surviving members and an envContributions entry naming the failed
 *     env (the agent's turn must not hard-fail).
 *
 * Pattern follows `agent-integration.test.ts`. The group-member lookup
 * is mocked at the module boundary so the test is isolated from the
 * internal Postgres pool.
 *
 * ---------------------------------------------------------------------------
 * Also hosts the routing-mode picker tests (formerly agent-routing-mode.test.ts;
 * identical harness):
 *
 * Integration tests for the three-state Auto/Pin/All routing-mode
 * picker (PRD #2515, slice 3 issue #2518).
 *
 * Exercises the full LLM → agent loop → executeSQL routing pipeline
 * with `routingMode` stamped on RequestContext (mirroring what the
 * chat route does from the persisted conversation row). The model
 * emits a `scope` argument and the tests assert that the picker
 * overrides it correctly:
 *
 *   - `routingMode='pin'` + agent emitting `scope: "all"` → single
 *     execution against the conversation's pinned member regardless
 *     of the agent's hint.
 *   - `routingMode='all'` + agent emitting `scope: "this"` → fanout
 *     across every member regardless of the agent's hint.
 *   - `routingMode='auto'` + agent emitting `scope: "this"` → single
 *     execution (same as legacy single-env behavior).
 *
 * Pattern follows `agent-cross-env-routing.test.ts`. The group-member
 * lookup is mocked at the module boundary so the test is isolated
 * from the internal Postgres pool.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";

// ---------------------------------------------------------------------------
// Environment — must be set before module imports
// ---------------------------------------------------------------------------

// Module-top env setup — must be set before the dynamic imports below
// (the imported modules read env at module-load time). `??=` keeps the
// assignment hoisted; cross-file leakage under `bun test --parallel`
// (1.5.4 #2797) is bounded — the first file to load wins, no sibling
// overwrites. Files that need to restore env do so in their own
// afterAll; the `??=` here is the module-load contract, not teardown.
process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

// ---------------------------------------------------------------------------
// Module-level mock model — each test assigns its own MockLanguageModelV3
// ---------------------------------------------------------------------------

let mockModel: InstanceType<typeof MockLanguageModelV3>;

void mock.module("@atlas/api/lib/providers", () => ({
  getModel: () => mockModel,
  getProviderType: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => mockModel,
  // #3761 — compaction summary-model resolver (added so the named import in agent.ts links).
  getSummaryModel: () => mockModel,
  getWorkspaceProviderType: () => "anthropic" as const,
  getDefaultProvider: () => "anthropic" as const,
  isGatewayAnthropicModel: (modelId: string) => modelId.includes("anthropic") || modelId.includes("claude"),
}));

void mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(["orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

// ---------------------------------------------------------------------------
// Per-connection mock DB — each member's queries return distinct rows so
// the merged result is verifiable end-to-end.
// ---------------------------------------------------------------------------

type QueryResult = { columns: string[]; rows: Record<string, unknown>[] };
type QueryStub = (sql: string, timeout?: number) => Promise<QueryResult>;

const memberQueryHandlers = new Map<string, QueryStub>();
const memberCallCounts = new Map<string, number>();

function setMemberHandler(connId: string, handler: QueryStub): void {
  memberQueryHandlers.set(connId, handler);
}

function makeMockDBConnectionFor(connId: string) {
  return {
    query: async (sql: string, timeout?: number) => {
      memberCallCounts.set(connId, (memberCallCounts.get(connId) ?? 0) + 1);
      const handler = memberQueryHandlers.get(connId);
      if (!handler) {
        return { columns: ["n"], rows: [{ n: 0 }] };
      }
      return handler(sql, timeout);
    },
    close: async () => {},
  };
}

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => makeMockDBConnectionFor("default"),
    connections: {
      get: (id: string) => makeMockDBConnectionFor(id ?? "default"),
      getDefault: () => makeMockDBConnectionFor("default"),
      getForOrg: (_orgId: string, id?: string) => makeMockDBConnectionFor(id ?? "default"),
      getTargetHost: () => "localhost:5432",
      describe: () => [
        { id: "us-int", dbType: "postgres" as const },
        { id: "eu", dbType: "postgres" as const },
        { id: "apac", dbType: "postgres" as const },
      ],
    },
  }),
);

// ---------------------------------------------------------------------------
// Mock the impure group-member lookup so tests don't need a real internal DB
// ---------------------------------------------------------------------------

let mockGroupMembers: readonly string[] = ["us-int", "eu", "apac"];
let mockPrimaryMember = "us-int";

void mock.module("@atlas/api/lib/env-routing/lookup", () => ({
  loadGroupRoutingContext: async (_orgId: string | undefined, currentMember: string) => ({
    groupId: "prod",
    members: mockGroupMembers,
    primaryMember: mockPrimaryMember,
    currentMember,
    degraded: false,
  }),
}));

void mock.module("@atlas/api/lib/cache/index", () => ({
  getCache: () => ({ get: () => null, set: () => {}, stats: () => ({ hits: 0, misses: 0, entryCount: 0, maxSize: 1000, ttl: 300000 }) }),
  buildCacheKey: () => "mock-key",
  cacheEnabled: () => false,
  getDefaultTtl: () => 300000,
  flushCache: () => {},
  setCacheBackend: () => {},
  _resetCache: () => {},
}));

// ---------------------------------------------------------------------------
// Imports — after mocks so modules resolve to mocked versions
// ---------------------------------------------------------------------------

const { runAgent } = await import("@atlas/api/lib/agent");
// #4943 — runAgent's `tools` is now required; this is its own fail-closed
// default, so these turns are unchanged. See agent.ts's `@param tools`.
const { nonDashboardRegistry } = await import("@atlas/api/lib/tools/registry");
const { withRequestContext } = await import("@atlas/api/lib/logger");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SQLOutput {
  success: boolean;
  error?: string;
  row_count?: number;
  columns?: string[];
  rows?: Record<string, unknown>[];
  envContributions?: { connectionId: string; rowCount: number; error: string | null; durationMs: number }[];
}

let callId = 0;
function nextId(): string {
  return `call-${++callId}`;
}

const MOCK_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function makeToolStepChunks(
  toolName: string,
  args: Record<string, unknown>,
): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId: nextId(), toolName, input: JSON.stringify(args) },
    { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } },
  ];
}

function userMessages(content: string): UIMessage[] {
  return [
    {
      id: "msg-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: content }],
    },
  ];
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK step types are generic
function findToolResults(steps: any[], toolName: string): any[] {
  const results: unknown[] = [];
  for (const step of steps) {
    if (!step.toolResults) continue;
    for (const tr of step.toolResults) {
      if (tr.toolName === toolName) {
        results.push(tr.output);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent cross-env routing — executeSQL `scope`", () => {
  const savedSandboxUrl = process.env.ATLAS_SANDBOX_URL;

  beforeEach(() => {
    callId = 0;
    memberQueryHandlers.clear();
    memberCallCounts.clear();
    mockGroupMembers = ["us-int", "eu", "apac"];
    mockPrimaryMember = "us-int";
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.ATLAS_TABLE_WHITELIST;
    delete process.env.ATLAS_SANDBOX_URL;
  });

  afterEach(() => {
    if (savedSandboxUrl !== undefined) {
      process.env.ATLAS_SANDBOX_URL = savedSandboxUrl;
    }
  });

  // -----------------------------------------------------------------------
  // 1. scope: "all" — fanout produces N parallel executions + merged table
  // -----------------------------------------------------------------------

  it("scope: 'all' fans out across every member and merges results with __env__", async () => {
    setMemberHandler("us-int", async () => ({
      columns: ["region", "revenue"],
      rows: [{ region: "us", revenue: 100 }],
    }));
    setMemberHandler("eu", async () => ({
      columns: ["region", "revenue"],
      rows: [{ region: "eu", revenue: 80 }],
    }));
    setMemberHandler("apac", async () => ({
      columns: ["region", "revenue"],
      rows: [{ region: "apac", revenue: 60 }],
    }));

    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", {
            sql: "SELECT region, revenue FROM orders",
            explanation: "Compare revenue across regions",
            scope: "all",
          }),
          [
            { type: "text-delta", id: "text-0", delta: "Compared across regions." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ tools: nonDashboardRegistry, messages: userMessages("Compare revenue across regions") });
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    const first = sqlResults[0]!;
    expect(first.success).toBe(true);
    expect(first.columns).toEqual(["__env__", "region", "revenue"]);

    // Every member ran exactly once
    expect(memberCallCounts.get("us-int")).toBe(1);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("apac")).toBe(1);

    // Three rows with three distinct __env__ values
    const envValues = (first.rows ?? []).map((r) => r["__env__"]);
    expect(new Set(envValues)).toEqual(new Set(["us-int", "eu", "apac"]));

    // envContributions reports one entry per member, all green
    expect(first.envContributions).toHaveLength(3);
    for (const contrib of first.envContributions ?? []) {
      expect(contrib.error).toBe(null);
      expect(contrib.rowCount).toBe(1);
    }
  });

  // -----------------------------------------------------------------------
  // 2. scope: named member — single execution against that member only
  // -----------------------------------------------------------------------

  it("scope: '<member id>' executes only against that member", async () => {
    setMemberHandler("us-int", async () => ({
      columns: ["region", "revenue"],
      rows: [{ region: "us", revenue: 100 }],
    }));
    setMemberHandler("eu", async () => ({
      columns: ["region", "revenue"],
      rows: [{ region: "eu", revenue: 80 }],
    }));
    setMemberHandler("apac", async () => ({
      columns: ["region", "revenue"],
      rows: [{ region: "apac", revenue: 60 }],
    }));

    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", {
            sql: "SELECT region, revenue FROM orders",
            explanation: "EU sales last week",
            scope: "eu",
          }),
          [
            { type: "text-delta", id: "text-0", delta: "EU revenue: 80." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ tools: nonDashboardRegistry, messages: userMessages("EU sales last week") });
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    const first = sqlResults[0]!;
    expect(first.success).toBe(true);
    // Single execution: only the eu member's handler ran
    expect(memberCallCounts.get("us-int") ?? 0).toBe(0);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("apac") ?? 0).toBe(0);
    // No fanout → no __env__ prepend in the merged shape (single-env path
    // returns the legacy `{columns, rows}` shape unchanged for back-compat)
    expect(first.columns).toEqual(["region", "revenue"]);
  });

  // -----------------------------------------------------------------------
  // 3. Partial failure — one member throws, merged still returns success
  //    with envContributions naming the failed env
  // -----------------------------------------------------------------------

  it("partial fanout failure surfaces in envContributions without hard-failing the turn", async () => {
    setMemberHandler("us-int", async () => ({
      columns: ["region", "revenue"],
      rows: [{ region: "us", revenue: 100 }],
    }));
    setMemberHandler("eu", async () => {
      throw new Error("ECONNREFUSED");
    });
    setMemberHandler("apac", async () => ({
      columns: ["region", "revenue"],
      rows: [{ region: "apac", revenue: 60 }],
    }));

    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", {
            sql: "SELECT region, revenue FROM orders",
            explanation: "Compare across regions",
            scope: "all",
          }),
          [
            { type: "text-delta", id: "text-0", delta: "Compared." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ tools: nonDashboardRegistry, messages: userMessages("Compare across regions") });
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    const first = sqlResults[0]!;
    expect(first.success).toBe(true);
    expect(first.columns).toEqual(["__env__", "region", "revenue"]);

    // 2 successful rows from us-int + apac
    const envValues = (first.rows ?? []).map((r) => r["__env__"]);
    expect(new Set(envValues)).toEqual(new Set(["us-int", "apac"]));

    // envContributions lists all 3, with eu carrying the error
    const byMember = new Map(
      (first.envContributions ?? []).map((c) => [c.connectionId, c]),
    );
    expect(byMember.get("us-int")?.error).toBe(null);
    expect(byMember.get("apac")?.error).toBe(null);
    expect(byMember.get("eu")?.error).toContain("ECONNREFUSED");
    expect(byMember.get("eu")?.rowCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 4. Back-compat — agent omits scope → original single-env behaviour
  // -----------------------------------------------------------------------

  it("agent omitting `scope` preserves the pre-#2516 single-env behaviour (no group lookup)", async () => {
    setMemberHandler("default", async () => ({
      columns: ["id"],
      rows: [{ id: 1 }],
    }));

    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", {
            sql: "SELECT id FROM orders",
            explanation: "List ids",
          }),
          [
            { type: "text-delta", id: "text-0", delta: "Done." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ tools: nonDashboardRegistry, messages: userMessages("List ids") });
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    const first = sqlResults[0]!;
    expect(first.success).toBe(true);
    // Single-env shape: no `__env__` prepend.
    expect(first.columns).toEqual(["id"]);
    // Per #2519: single-env executions emit a 1-element envContributions
    // array so SDK consumers see the same wire shape as fanouts. The
    // contribution names the executed connection and carries its row
    // count / duration.
    expect(first.envContributions).toHaveLength(1);
    expect(first.envContributions?.[0]?.connectionId).toBe("default");
    expect(first.envContributions?.[0]?.error).toBeNull();
    // Only the default connection's handler ran
    expect(memberCallCounts.get("default")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 5. All-failure fanout — every member errors, agent gets success: false
  //    with a summary message that names every failed env.
  // -----------------------------------------------------------------------

  it("scope: 'all' with every member failing → success=false summary + envContributions error per env", async () => {
    setMemberHandler("us-int", async () => {
      throw new Error("pg: relation does not exist");
    });
    setMemberHandler("eu", async () => {
      throw new Error("ECONNREFUSED");
    });
    setMemberHandler("apac", async () => {
      throw new Error("timeout");
    });

    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", {
            sql: "SELECT region FROM orders",
            explanation: "Compare across regions",
            scope: "all",
          }),
          [
            { type: "text-delta", id: "text-0", delta: "All envs failed." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await withRequestContext(
      { requestId: "test-all-fail", connectionId: "us-int", connectionGroupId: "prod" },
      () => runAgent({ tools: nonDashboardRegistry, messages: userMessages("Compare across regions") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    const first = sqlResults[0]!;
    // The agent's recovery loop hinges on success=false for all-failure.
    expect(first.success).toBe(false);
    expect(first.error).toContain("All 3 environments failed");
    expect(first.error).toContain("us-int");
    expect(first.error).toContain("eu");
    expect(first.error).toContain("apac");
    // envContributions still describes each env so SDK consumers /
    // downstream UI can render per-env error chips.
    expect(first.envContributions).toHaveLength(3);
    for (const contrib of first.envContributions ?? []) {
      expect(contrib.error).not.toBeNull();
      expect(contrib.rowCount).toBe(0);
    }
  });

  // Unknown-member fallback is covered exhaustively in the pure-module
  // unit tests (`env-routing/__tests__/index.test.ts` — "scope:
  // '<unknown id>' → fall back to primary with warning"). The
  // integration end-to-end here would duplicate that coverage.
});

// ---------------------------------------------------------------------------
// Routing-mode picker (PRD #2515, slice 3 issue #2518)
// ---------------------------------------------------------------------------

/**
 * Build an MLM that emits `executeSQL` with the supplied `scope` (or
 * none, for the omitted case) and a trailing `finish` step.
 */
function modelWithScope(scope: string | undefined): InstanceType<typeof MockLanguageModelV3> {
  let streamIdx = 0;
  const args: Record<string, unknown> = {
    sql: "SELECT region, revenue FROM orders",
    explanation: "Routing-mode test",
  };
  if (scope !== undefined) args.scope = scope;
  return new MockLanguageModelV3({
    doStream: async () => {
      const allSteps: LanguageModelV3StreamPart[][] = [
        makeToolStepChunks("executeSQL", args),
        [
          { type: "text-delta", id: "text-0", delta: "Done." },
          { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
        ],
      ];
      if (streamIdx >= allSteps.length) {
        return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
      }
      return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
    },
  });
}

function seedAllMembers(): void {
  setMemberHandler("us-int", async () => ({
    columns: ["region", "revenue"],
    rows: [{ region: "us", revenue: 100 }],
  }));
  setMemberHandler("eu", async () => ({
    columns: ["region", "revenue"],
    rows: [{ region: "eu", revenue: 80 }],
  }));
  setMemberHandler("apac", async () => ({
    columns: ["region", "revenue"],
    rows: [{ region: "apac", revenue: 60 }],
  }));
}

describe("agent routing-mode picker — executeSQL `routingMode`", () => {
  const savedSandboxUrl = process.env.ATLAS_SANDBOX_URL;

  beforeEach(() => {
    callId = 0;
    memberQueryHandlers.clear();
    memberCallCounts.clear();
    mockGroupMembers = ["us-int", "eu", "apac"];
    mockPrimaryMember = "us-int";
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.ATLAS_TABLE_WHITELIST;
    delete process.env.ATLAS_SANDBOX_URL;
  });

  afterEach(() => {
    if (savedSandboxUrl !== undefined) {
      process.env.ATLAS_SANDBOX_URL = savedSandboxUrl;
    }
  });

  // -----------------------------------------------------------------------
  // Pin overrides agent (acceptance criterion #1 on issue #2518)
  // -----------------------------------------------------------------------

  it("pin overrides agent: routingMode='pin' + connection_id='eu' + agent scope='all' → single execution against eu", async () => {
    seedAllMembers();
    mockModel = modelWithScope("all");

    const result = await withRequestContext(
      {
        requestId: "test-pin-override",
        connectionId: "eu",
        routingMode: "pin",
      },
      () => runAgent({ tools: nonDashboardRegistry, messages: userMessages("EU revenue this month") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    const first = sqlResults[0]!;
    expect(first.success).toBe(true);
    // Only "eu" ran — agent's "all" hint is overridden by the user's
    // pin selection.
    expect(memberCallCounts.get("us-int") ?? 0).toBe(0);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("apac") ?? 0).toBe(0);
    // Single-env shape: no __env__ prepend (per-row sentinel only on
    // fanout). The single-env path post-#2519 still wraps the result
    // with a 1-element `envContributions` array for wire symmetry.
    expect(first.columns).toEqual(["region", "revenue"]);
    expect(first.envContributions).toHaveLength(1);
    expect(first.envContributions?.[0]?.connectionId).toBe("eu");
  });

  // -----------------------------------------------------------------------
  // All overrides agent (acceptance criterion #2 on issue #2518)
  // -----------------------------------------------------------------------

  it("all overrides agent: routingMode='all' + agent scope='this' → fanout across every member", async () => {
    seedAllMembers();
    mockModel = modelWithScope("this");

    const result = await withRequestContext(
      {
        requestId: "test-all-override",
        connectionId: "us-int",
        routingMode: "all",
      },
      () => runAgent({ tools: nonDashboardRegistry, messages: userMessages("Compare across regions") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    const first = sqlResults[0]!;
    expect(first.success).toBe(true);
    // Every member ran exactly once despite the agent emitting
    // scope="this" — the picker overrides the agent.
    expect(memberCallCounts.get("us-int")).toBe(1);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("apac")).toBe(1);
    expect(first.columns).toEqual(["__env__", "region", "revenue"]);
    expect(first.envContributions).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // 'all' also overrides an omitted scope (the agent didn't pick fanout
  // but the user did)
  // -----------------------------------------------------------------------

  it("all overrides absent scope: routingMode='all' + no agent scope → fanout", async () => {
    seedAllMembers();
    mockModel = modelWithScope(undefined);

    const result = await withRequestContext(
      {
        requestId: "test-all-no-scope",
        connectionId: "us-int",
        routingMode: "all",
      },
      () => runAgent({ tools: nonDashboardRegistry, messages: userMessages("Compare across regions") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    expect(memberCallCounts.get("us-int")).toBe(1);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("apac")).toBe(1);
    expect(sqlResults[0]!.columns).toEqual(["__env__", "region", "revenue"]);
  });

  // -----------------------------------------------------------------------
  // Auto mode passes the agent's scope through unchanged
  // -----------------------------------------------------------------------

  it("auto passes agent through: routingMode='auto' + agent scope='all' → fanout", async () => {
    seedAllMembers();
    mockModel = modelWithScope("all");

    const result = await withRequestContext(
      {
        requestId: "test-auto-all",
        connectionId: "us-int",
        routingMode: "auto",
      },
      () => runAgent({ tools: nonDashboardRegistry, messages: userMessages("Compare across regions") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    expect(memberCallCounts.get("us-int")).toBe(1);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("apac")).toBe(1);
    expect(sqlResults[0]!.columns).toEqual(["__env__", "region", "revenue"]);
  });

  it("auto passes agent through: routingMode='auto' + agent scope='this' → single execution against current", async () => {
    seedAllMembers();
    mockModel = modelWithScope("this");

    const result = await withRequestContext(
      {
        requestId: "test-auto-this",
        connectionId: "eu",
        routingMode: "auto",
      },
      () => runAgent({ tools: nonDashboardRegistry, messages: userMessages("EU revenue") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    // Only "eu" — auto + this routes to the conversation's current
    // member, NOT a fanout.
    expect(memberCallCounts.get("us-int") ?? 0).toBe(0);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("apac") ?? 0).toBe(0);
    expect(sqlResults[0]!.columns).toEqual(["region", "revenue"]);
  });

  // -----------------------------------------------------------------------
  // Tool default — when no `routingMode` is stamped on the request
  // context (no chat route in the path), the tool defaults to 'auto'
  // and the agent's scope decides. The chat route is responsible for
  // applying the NULL→'pin' back-compat default before reaching here.
  // -----------------------------------------------------------------------

  it("tool default: routingMode unset + agent scope='all' → fanout (legacy 'agent decides' semantics)", async () => {
    seedAllMembers();
    mockModel = modelWithScope("all");

    const result = await withRequestContext(
      {
        requestId: "test-tool-default",
        connectionId: "us-int",
        // No routingMode — the chat route is what stamps the per-
        // conversation NULL→'pin' default. Tools / MCP / scheduler /
        // direct unit tests fall through to the agent-decides default.
      },
      () => runAgent({ tools: nonDashboardRegistry, messages: userMessages("Compare across regions") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];

    expect(sqlResults).toHaveLength(1);
    // Auto semantics — agent's scope='all' produces a fanout.
    expect(memberCallCounts.get("us-int")).toBe(1);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("apac")).toBe(1);
    expect(sqlResults[0]!.columns).toEqual(["__env__", "region", "revenue"]);
  });
});

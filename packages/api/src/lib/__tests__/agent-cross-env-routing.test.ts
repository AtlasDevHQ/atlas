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

process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";

// ---------------------------------------------------------------------------
// Module-level mock model — each test assigns its own MockLanguageModelV3
// ---------------------------------------------------------------------------

let mockModel: InstanceType<typeof MockLanguageModelV3>;

mock.module("@atlas/api/lib/providers", () => ({
  getModel: () => mockModel,
  getProviderType: () => "anthropic" as const,
  getModelFromWorkspaceConfig: () => mockModel,
  getWorkspaceProviderType: () => "anthropic" as const,
  getDefaultProvider: () => "anthropic" as const,
}));

mock.module("@atlas/api/lib/semantic", () => ({
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

mock.module("@atlas/api/lib/db/connection", () =>
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

mock.module("@atlas/api/lib/env-routing/lookup", () => ({
  loadGroupRoutingContext: async (_orgId: string | undefined, currentMember: string) => ({
    groupId: "prod",
    members: mockGroupMembers,
    primaryMember: mockPrimaryMember,
    currentMember,
  }),
}));

mock.module("@atlas/api/lib/cache/index", () => ({
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK step types are generic
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

    const result = await runAgent({ messages: userMessages("Compare revenue across regions") });
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

    const result = await runAgent({ messages: userMessages("EU sales last week") });
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

    const result = await runAgent({ messages: userMessages("Compare across regions") });
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

    const result = await runAgent({ messages: userMessages("List ids") });
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
});

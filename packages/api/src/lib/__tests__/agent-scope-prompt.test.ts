/**
 * Slice 2 tests for the system-prompt scope-decision guidance
 * (PRD #2515, slice 2 #2517).
 *
 * Two layers:
 *   1. Prompt-content tests via `buildSystemParam`: assert the cross-env
 *      routing section appears when `routingContext.members.length > 1` and
 *      is absent otherwise (single-member workspaces / no routing context).
 *      The "member ids surfaced" criterion is checked by asserting every
 *      member id appears in the rendered prompt.
 *   2. Mocked-LLM integration: assert the agent's executeSQL invocation
 *      fans out for a comparative-emit, routes to a specific member for a
 *      region-named-emit, and stays single for ambiguous-emit. The mock
 *      emits the expected `scope` value (it doesn't actually decide based
 *      on prompt content); the test verifies the END-TO-END behaviour that
 *      slice 2 unlocks — system prompt → tool call → fanout/single.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { createConnectionMock } from "@atlas/api/testing/connection";

process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let mockModel: InstanceType<typeof MockLanguageModelV3>;
let lastSystemPrompt: string | undefined;

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

// Per-connection DB mock — distinct rows per member for the integration tests.
const memberCallCounts = new Map<string, number>();
function makeMockDB(id: string) {
  return {
    query: async () => {
      memberCallCounts.set(id, (memberCallCounts.get(id) ?? 0) + 1);
      return { columns: ["region"], rows: [{ region: id }] };
    },
    close: async () => {},
  };
}

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    getDB: () => makeMockDB("default"),
    connections: {
      get: (id: string) => makeMockDB(id ?? "default"),
      getDefault: () => makeMockDB("default"),
      getForOrg: (_orgId: string, id?: string) => makeMockDB(id ?? "default"),
      getTargetHost: () => "localhost:5432",
      describe: () => [
        { id: "us-int", dbType: "postgres" as const },
        { id: "eu", dbType: "postgres" as const },
        { id: "apac", dbType: "postgres" as const },
      ],
    },
  }),
);

// Inject a fixed routing context — three members, primary us-int.
mock.module("@atlas/api/lib/env-routing/lookup", () => ({
  loadGroupRoutingContext: async (_orgId: string | undefined, currentMember: string) => ({
    groupId: "prod",
    members: ["us-int", "eu", "apac"],
    primaryMember: "us-int",
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

// Spy on the LLM `doStream` call so we can capture the rendered system prompt
function makeSpyingModel(toolCallArgs: Record<string, unknown>): InstanceType<typeof MockLanguageModelV3> {
  let streamIdx = 0;
  const allSteps: LanguageModelV3StreamPart[][] = [
    [
      { type: "tool-call", toolCallId: "call-1", toolName: "executeSQL", input: JSON.stringify(toolCallArgs) },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        finishReason: { unified: "tool-calls", raw: "tool_use" },
      },
    ],
    [
      { type: "text-delta", id: "text-0", delta: "Done." },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        finishReason: { unified: "stop", raw: "end_turn" },
      },
    ],
  ];
  return new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doStream: async (opts: any) => {
      // Capture the first system message rendered into the LLM call so the
      // prompt-content assertions can inspect it.
      const systemMsg = opts?.prompt?.find((p: { role: string }) => p.role === "system");
      if (systemMsg) {
        const content = typeof systemMsg.content === "string"
          ? systemMsg.content
          : Array.isArray(systemMsg.content)
            ? systemMsg.content.map((c: { text?: string }) => c.text ?? "").join("")
            : "";
        if (content) lastSystemPrompt = content;
      }
      if (streamIdx >= allSteps.length) {
        return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
      }
      return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
    },
  });
}

const { runAgent } = await import("@atlas/api/lib/agent");
const { buildSystemParam } = await import("@atlas/api/lib/agent");
const { withRequestContext } = await import("@atlas/api/lib/logger");

function userMessages(content: string): UIMessage[] {
  return [
    {
      id: "msg-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: content }],
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findToolResults(steps: any[], toolName: string): any[] {
  const results: unknown[] = [];
  for (const step of steps) {
    if (!step.toolResults) continue;
    for (const tr of step.toolResults) {
      if (tr.toolName === toolName) results.push(tr.output);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSystemParam — scope guidance section (slice 2)", () => {
  it("appends Cross-Environment Routing section when routingContext has >1 members", () => {
    const result = buildSystemParam(
      "openai",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        members: ["us-int", "eu", "apac"],
        currentMember: "us-int",
        groupId: "prod",
      },
    );
    expect(typeof result).toBe("string");
    const prompt = result as string;
    expect(prompt).toContain("Cross-Environment Routing");
    // Every member id is surfaced so the agent can resolve regional names
    expect(prompt).toContain("us-int");
    expect(prompt).toContain("eu");
    expect(prompt).toContain("apac");
    // Scope semantics + conservative-default cue both make it into the prompt
    expect(prompt).toContain("scope: \"all\"");
    expect(prompt).toContain("scope: \"this\"");
    expect(prompt).toContain("Conservative-by-default");
    // Three category headers must appear — guards against a future prompt
    // trim silently dropping the comparative-intent heuristics that
    // drive fanout decisions.
    expect(prompt).toContain("Comparative intent");
    expect(prompt).toContain("Single-environment cue");
    expect(prompt).toContain("ambiguous");
  });

  it("omits the scope guidance section when routingContext is absent", () => {
    const result = buildSystemParam("openai");
    expect(typeof result).toBe("string");
    const prompt = result as string;
    expect(prompt).not.toContain("Cross-Environment Routing");
  });

  it("omits the scope guidance section when routingContext has a single member", () => {
    const result = buildSystemParam(
      "openai",
      undefined,
      undefined,
      undefined,
      undefined,
      { members: ["only"], currentMember: "only" },
    );
    const prompt = result as string;
    expect(prompt).not.toContain("Cross-Environment Routing");
  });

  it("renders the current member as the anchor for `scope: \"this\"`", () => {
    const result = buildSystemParam(
      "openai",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        members: ["us-int", "eu", "apac"],
        currentMember: "eu",
      },
    );
    const prompt = result as string;
    expect(prompt).toMatch(/current member is `eu`/);
  });
});

// ---------------------------------------------------------------------------
// Mocked-LLM integration — assert the wiring (prompt → tool-call → routing)
// works end-to-end given each representative scope emission.
// ---------------------------------------------------------------------------

describe("agent integration — scope routing via mocked LLM (slice 2)", () => {
  const savedSandboxUrl = process.env.ATLAS_SANDBOX_URL;

  beforeEach(() => {
    memberCallCounts.clear();
    lastSystemPrompt = undefined;
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.ATLAS_TABLE_WHITELIST;
    delete process.env.ATLAS_SANDBOX_URL;
  });

  afterEach(() => {
    if (savedSandboxUrl !== undefined) {
      process.env.ATLAS_SANDBOX_URL = savedSandboxUrl;
    }
  });

  it("comparative question + LLM emits scope: 'all' → fanout across every member, prompt carries the guidance", async () => {
    mockModel = makeSpyingModel({
      sql: "SELECT region FROM orders",
      explanation: "Compare across regions",
      scope: "all",
    });

    const result = await withRequestContext(
      { requestId: "test-1", connectionId: "us-int", connectionGroupId: "prod" },
      () => runAgent({ messages: userMessages("compare revenue across regions") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL");

    expect(sqlResults).toHaveLength(1);
    expect(sqlResults[0].success).toBe(true);
    // Fanout exercised — every member ran exactly once
    expect(memberCallCounts.get("us-int")).toBe(1);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("apac")).toBe(1);
    // The system prompt rendered into the LLM call carries the scope guidance
    expect(lastSystemPrompt).toContain("Cross-Environment Routing");
    expect(lastSystemPrompt).toContain("us-int");
    expect(lastSystemPrompt).toContain("eu");
    expect(lastSystemPrompt).toContain("apac");
  });

  it("region-named question + LLM emits scope: 'eu' → single execution against eu", async () => {
    mockModel = makeSpyingModel({
      sql: "SELECT region FROM orders",
      explanation: "EU sales last week",
      scope: "eu",
    });

    const result = await withRequestContext(
      { requestId: "test-2", connectionId: "us-int", connectionGroupId: "prod" },
      () => runAgent({ messages: userMessages("EU sales last week") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL");

    expect(sqlResults).toHaveLength(1);
    expect(memberCallCounts.get("eu")).toBe(1);
    expect(memberCallCounts.get("us-int") ?? 0).toBe(0);
    expect(memberCallCounts.get("apac") ?? 0).toBe(0);
  });

  it("ambiguous question + LLM omits scope → single execution against the current member", async () => {
    mockModel = makeSpyingModel({
      sql: "SELECT region FROM orders",
      explanation: "Show me orders",
    });

    const result = await withRequestContext(
      { requestId: "test-3", connectionId: "us-int", connectionGroupId: "prod" },
      () => runAgent({ messages: userMessages("show me orders") }),
    );
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL");

    expect(sqlResults).toHaveLength(1);
    // Only the current member ran (single-env path, no routing lookup)
    expect(memberCallCounts.get("us-int")).toBe(1);
    expect(memberCallCounts.get("eu") ?? 0).toBe(0);
    expect(memberCallCounts.get("apac") ?? 0).toBe(0);
  });

  // Single-member coverage lives in the unit-test block above — asserting on
  // the rendered prompt for the integration path would require swapping the
  // module-level routing-context mock mid-suite, which doesn't compose with
  // `runAgent` once it's been imported. The unit tests verify both
  // `routingContext: undefined` and `routingContext.members: [x]` (current
  // member only) omit the Cross-Environment Routing section, which is the
  // same logical assertion at a stricter boundary.
});

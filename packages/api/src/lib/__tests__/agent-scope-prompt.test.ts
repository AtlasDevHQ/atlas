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

// Module-top env setup — must be set before the dynamic imports below
// (the imported modules read env at module-load time). `??=` keeps the
// assignment hoisted; cross-file leakage under `bun test --parallel`
// (1.5.4 #2797) is bounded — the first file to load wins, no sibling
// overwrites. Files that need to restore env do so in their own
// afterAll; the `??=` here is the module-load contract, not teardown.
process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let mockModel: InstanceType<typeof MockLanguageModelV3>;
let lastSystemPrompt: string | undefined;
// #3044 — capture how the agent loop calls the REST resolver so we can pin that
// the conversation's `connectionGroupId` is threaded as `activeGroupId`.
let capturedRestResolveArgs: { orgId: string; deps: unknown } | undefined;

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

// #3044 — capture the agent loop's REST resolver call. Returns [] so the REST
// block is a no-op (no representation built); the existing scope-routing tests
// don't set an org id, so `agent.ts` short-circuits to [] before this is reached.
mock.module("@atlas/api/lib/openapi/workspace-datasource", () => ({
  resolveWorkspaceRestDatasources: async (orgId: string, deps: unknown) => {
    capturedRestResolveArgs = { orgId, deps };
    return [];
  },
  resolveWorkspaceRestDatasourcesOrThrow: async () => [],
  resolveWorkspacePrimaryRestDatasource: async () => null,
  defaultQuery: async () => [],
  RestDatasourceReconnectError: class extends Error {},
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
const { buildSystemParam, buildRestDatasourceScopeNote } = await import("@atlas/api/lib/agent");
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

describe("buildRestDatasourceScopeNote — REST env-scope framing (#3044)", () => {
  it("frames a workspace-global datasource as not constrained by the pin (multi-env)", () => {
    const note = buildRestDatasourceScopeNote({}, { inMultiEnvGroup: true });
    expect(note).toContain("workspace-global");
    expect(note).toContain("NOT");
    expect(note.toLowerCase()).toContain("environment selection/pin");
    // The crux of the bug: the model must not present the chat as env-limited.
    expect(note).toContain("Do not describe the conversation as limited to one environment");
  });

  it("softens the framing in a single-env workspace (no pin to contrast)", () => {
    const note = buildRestDatasourceScopeNote({}, { inMultiEnvGroup: false });
    expect(note).toContain("workspace-global");
    expect(note).toContain("available in every environment");
    // No pin exists, so the contrast clause is omitted.
    expect(note).not.toContain("NOT constrained");
  });

  it("frames a scoped datasource as bound to its environment group", () => {
    const note = buildRestDatasourceScopeNote({ groupId: "prod" }, { inMultiEnvGroup: true });
    expect(note).toContain("`prod`");
    expect(note).toContain("only reachable");
    expect(note).not.toContain("workspace-global");
  });

  it("a provided restRepresentation is appended to the system prompt verbatim", () => {
    // The run loop prepends buildRestDatasourceScopeNote() to each datasource's
    // section; buildSystemParam appends the whole restRepresentation string.
    const scopeNote = buildRestDatasourceScopeNote({}, { inMultiEnvGroup: true });
    const rep = `${scopeNote}\n\n### REST Datasource\nuse executeRestOperation…`;
    const result = buildSystemParam(
      "openai",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "developer",
      rep,
    );
    const prompt = result as string;
    expect(prompt).toContain("workspace-global");
    expect(prompt).toContain("### REST Datasource");
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

describe("agent loop — REST datasource scope threading (#3044)", () => {
  // A text-only model so the resolver is exercised during prompt-build without
  // running the executeSQL path (which would need an org-aware connection mock).
  function makeTextOnlyModel(): InstanceType<typeof MockLanguageModelV3> {
    return new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doStream: async (opts: any) => {
        const systemMsg = opts?.prompt?.find((p: { role: string }) => p.role === "system");
        if (systemMsg) {
          lastSystemPrompt =
            typeof systemMsg.content === "string"
              ? systemMsg.content
              : Array.isArray(systemMsg.content)
                ? systemMsg.content.map((c: { text?: string }) => c.text ?? "").join("")
                : "";
        }
        return {
          stream: convertArrayToReadableStream([
            { type: "text-delta", id: "t0", delta: "Hi." },
            {
              type: "finish",
              usage: {
                inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
              finishReason: { unified: "stop", raw: "end_turn" },
            },
          ]),
        };
      },
    });
  }

  beforeEach(() => {
    capturedRestResolveArgs = undefined;
    mockModel = makeTextOnlyModel();
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
  });

  it("threads the conversation's connectionGroupId into the REST resolver as activeGroupId", async () => {
    await withRequestContext(
      {
        requestId: "rest-1",
        connectionId: "us-int",
        connectionGroupId: "prod",
        user: { id: "u1", mode: "managed", label: "u@test", role: "member", activeOrganizationId: "org-1" },
      },
      () => runAgent({ messages: userMessages("hello") }),
    );
    expect(capturedRestResolveArgs).toBeDefined();
    expect(capturedRestResolveArgs!.orgId).toBe("org-1");
    expect(capturedRestResolveArgs!.deps).toEqual({ activeGroupId: "prod" });
  });

  it("passes activeGroupId: null (NOT undefined) when the conversation has no active group", async () => {
    await withRequestContext(
      {
        requestId: "rest-2",
        connectionId: "us-int",
        user: { id: "u1", mode: "managed", label: "u@test", role: "member", activeOrganizationId: "org-1" },
      },
      () => runAgent({ messages: userMessages("hello") }),
    );
    expect(capturedRestResolveArgs!.deps).toEqual({ activeGroupId: null });
    // `undefined` would disable scoping in the resolver (the confirm-replay path)
    // and re-leak a scoped datasource into the chat — the regression #3044 closes.
    expect((capturedRestResolveArgs!.deps as { activeGroupId: unknown }).activeGroupId).not.toBeUndefined();
  });
});

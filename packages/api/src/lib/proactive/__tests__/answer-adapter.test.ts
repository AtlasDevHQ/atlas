/**
 * Tests for the proactive answer adapter (#2614 / slice 2a of #2607).
 *
 * Pins:
 *  - Linked path: when `atlasUserId` is non-null, the adapter resolves
 *    the user's org via the supplied `resolveOrgForUser` callback,
 *    builds an actor via `resolveActor`, and the agent observes that
 *    actor on `RequestContext.user`.
 *  - Unlinked path: when `atlasUserId` is null, the agent runs with a
 *    synthetic anonymous identity (`slack-bot:proactive:<threadId>`)
 *    and no `activeOrganizationId`.
 *  - Tool extraction: `executeSQL` tool calls produce `sql` + `data`
 *    entries; `explore` `cat entities/x.yml` commands produce
 *    `entitiesReferenced`; `cat metrics/y.yml` produces
 *    `metricsReferenced`.
 *  - Error surface: when `runAgent` throws, the adapter logs the
 *    developer detail and rethrows the user-safe message.
 *
 * Uses sync `mock.module()` factories per CLAUDE.md (async +
 * inner-await would deadlock the loader).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Layer, ManagedRuntime } from "effect";

// ---------------------------------------------------------------------------
// Module mocks (sync factories only — async deadlocks bun:test's loader)
// ---------------------------------------------------------------------------

interface ObservedRunAgentCall {
  question: string;
  userId?: string;
  orgId?: string | null;
  approvalSurface?: string;
  requestId?: string;
}
const observedRunAgentCalls: ObservedRunAgentCall[] = [];

// `runAgent` return shape — what the adapter awaits via `.text` / `.steps`.
interface RunAgentMockReturn {
  text: Promise<string>;
  steps: Promise<unknown[]>;
  totalUsage?: Promise<unknown>;
}
let nextRunAgentResult: RunAgentMockReturn | null = null;
let nextRunAgentError: Error | null = null;

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: async (params: { messages: { parts: { text: string }[] }[] }) => {
    // Capture observed context inside the mocked runAgent so the test
    // can assert which identity the adapter bound to RequestContext.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRequestContext } = require("@atlas/api/lib/logger") as {
      getRequestContext: () => {
        requestId: string;
        user?: { id: string; activeOrganizationId?: string };
        approvalSurface?: string;
      } | undefined;
    };
    const ctx = getRequestContext();
    const question = params.messages[0].parts.map((p) => p.text).join("");
    observedRunAgentCalls.push({
      question,
      userId: ctx?.user?.id,
      orgId: ctx?.user?.activeOrganizationId ?? null,
      approvalSurface: ctx?.approvalSurface,
      requestId: ctx?.requestId,
    });

    if (nextRunAgentError) throw nextRunAgentError;
    if (!nextRunAgentResult) {
      return {
        text: Promise.resolve(""),
        steps: Promise.resolve([]),
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      };
    }
    return nextRunAgentResult;
  },
  // The adapter doesn't call these but `runAgent` lives next to them
  // and partial `mock.module()` shapes break other tests in the loader.
  getAgentMaxSteps: () => 25,
  buildSystemParam: () => "",
  applyCacheControl: <T,>(messages: T): T => messages,
  runAgentEffect: () => {
    throw new Error("not used in adapter tests");
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const { createAiModelTestLayer } = await import(
  "@atlas/api/lib/effect/ai"
);
const { createProactiveAnswerAdapter, collectProactiveResult } = await import(
  "../answer-adapter"
);
const { createAtlasUser } = await import("@atlas/api/lib/auth/types");

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function buildRuntime() {
  // The adapter only needs `AtlasAiModel`; provide via the test layer.
  return ManagedRuntime.make(
    createAiModelTestLayer({ providerType: "anthropic", modelId: "test-model" }),
  );
}

const slackAsker = {
  platform: "slack",
  externalUserId: "U999",
  userName: "Alice",
};

beforeEach(() => {
  observedRunAgentCalls.length = 0;
  nextRunAgentResult = null;
  nextRunAgentError = null;
});

// ---------------------------------------------------------------------------
// Linked path
// ---------------------------------------------------------------------------

describe("createProactiveAnswerAdapter — linked path", () => {
  it("binds the linked user (with resolved org) onto RequestContext for the agent run", async () => {
    nextRunAgentResult = {
      text: Promise.resolve("Linked answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    };

    const runtime = buildRuntime();
    const linkedActor = createAtlasUser(
      "user-linked",
      "managed",
      "linked@example.com",
      { role: "admin", activeOrganizationId: "org-linked" },
    );

    const adapter = createProactiveAnswerAdapter(runtime, {
      resolveOrgForUser: async () => "org-linked",
      resolveActor: async () => linkedActor,
    });

    const result = await adapter("how many customers?", {
      threadId: "T-1",
      asker: slackAsker,
      atlasUserId: "user-linked",
    });

    expect(result.answer).toBe("Linked answer");
    expect(observedRunAgentCalls).toHaveLength(1);
    expect(observedRunAgentCalls[0].userId).toBe("user-linked");
    expect(observedRunAgentCalls[0].orgId).toBe("org-linked");
    expect(observedRunAgentCalls[0].approvalSurface).toBe("slack");
    expect(observedRunAgentCalls[0].question).toBe("how many customers?");

    await runtime.dispose();
  });

  it("degrades to anonymous identity when the linked user cannot be resolved", async () => {
    nextRunAgentResult = {
      text: Promise.resolve("Fallback answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    };

    const runtime = buildRuntime();
    const adapter = createProactiveAnswerAdapter(runtime, {
      resolveOrgForUser: async () => null,
      // `resolveActor` returns null — user row deleted / not found.
      resolveActor: async () => null,
    });

    const result = await adapter("orphan question", {
      threadId: "T-orphan",
      asker: slackAsker,
      atlasUserId: "user-missing",
    });

    expect(result.answer).toBe("Fallback answer");
    expect(observedRunAgentCalls[0].userId).toBeUndefined();
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Unlinked path
// ---------------------------------------------------------------------------

describe("createProactiveAnswerAdapter — unlinked path", () => {
  it("binds a synthetic anonymous identity (no org) when atlasUserId is null", async () => {
    nextRunAgentResult = {
      text: Promise.resolve("Public-dataset answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    };

    const runtime = buildRuntime();
    const adapter = createProactiveAnswerAdapter(runtime, {
      // Should never be invoked in the unlinked path.
      resolveOrgForUser: async () => {
        throw new Error("resolveOrgForUser must not be called for unlinked askers");
      },
      resolveActor: async () => {
        throw new Error("resolveActor must not be called for unlinked askers");
      },
    });

    const result = await adapter("what is revenue?", {
      threadId: "T-unlinked",
      asker: slackAsker,
      atlasUserId: null,
    });

    expect(result.answer).toBe("Public-dataset answer");
    expect(observedRunAgentCalls[0].userId).toContain("slack-bot:proactive:T-unlinked");
    // Anonymous identity must NOT carry an active org — RLS + workspace
    // model routing both branch on `activeOrganizationId`, so an empty
    // string here is the unlinked-asker fingerprint.
    expect(observedRunAgentCalls[0].orgId === null || observedRunAgentCalls[0].orgId === "").toBe(true);
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("createProactiveAnswerAdapter — error handling", () => {
  it("rethrows a user-safe message when runAgent throws", async () => {
    nextRunAgentError = new Error("ECONNREFUSED postgres://internal:5432");

    const runtime = buildRuntime();
    const adapter = createProactiveAnswerAdapter(runtime, {
      resolveOrgForUser: async () => "org-1",
      resolveActor: async () =>
        createAtlasUser("user-1", "managed", "u1@example.com", {
          activeOrganizationId: "org-1",
        }),
    });

    await expect(
      adapter("trigger an error", {
        threadId: "T-err",
        asker: slackAsker,
        atlasUserId: "user-1",
      }),
    ).rejects.toThrow(/Atlas couldn't answer this/);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tool-result extraction (pure helper)
// ---------------------------------------------------------------------------

describe("collectProactiveResult", () => {
  it("extracts sql + data from executeSQL tool results and entities/metrics from explore commands", () => {
    const collected = collectProactiveResult("final answer", [
      {
        toolResults: [
          {
            toolName: "explore",
            input: { command: "cat entities/customers.yml" },
            output: "table: customers ...",
          },
          {
            toolName: "explore",
            input: {
              command: "grep -r mrr metrics/monthly_revenue.yml entities/accounts.yml",
            },
            output: "metric: mrr ...",
          },
          {
            toolName: "executeSQL",
            input: { sql: "SELECT COUNT(*) FROM customers" },
            output: {
              success: true,
              columns: ["count"],
              rows: [{ count: 42 }],
            },
          },
        ],
      },
      {
        toolResults: [
          {
            toolName: "executeSQL",
            input: { sql: "SELECT SUM(mrr) FROM accounts" },
            output: {
              success: true,
              columns: ["sum"],
              rows: [{ sum: 1000 }],
            },
          },
          {
            // unsuccessful SQL — should be captured in `sql` but not `data`
            toolName: "executeSQL",
            input: { sql: "SELECT * FROM missing_table" },
            output: { success: false },
          },
        ],
      },
    ]);

    expect(collected.answer).toBe("final answer");
    expect(collected.sql).toEqual([
      "SELECT COUNT(*) FROM customers",
      "SELECT SUM(mrr) FROM accounts",
      "SELECT * FROM missing_table",
    ]);
    expect(collected.data).toHaveLength(2);
    expect(collected.data[0]).toEqual({ columns: ["count"], rows: [{ count: 42 }] });
    expect(collected.entitiesReferenced).toEqual(["customers", "accounts"]);
    expect(collected.metricsReferenced).toEqual(["monthly_revenue"]);
  });

  it("returns empty arrays when there are no tool results", () => {
    const collected = collectProactiveResult("hello", []);
    expect(collected.sql).toEqual([]);
    expect(collected.data).toEqual([]);
    expect(collected.entitiesReferenced).toEqual([]);
    expect(collected.metricsReferenced).toEqual([]);
  });

  it("surfaces entities/metrics on the wire-level ProactiveQueryResult", async () => {
    nextRunAgentResult = {
      text: Promise.resolve("Answer with refs"),
      steps: Promise.resolve([
        {
          toolResults: [
            {
              toolName: "explore",
              input: { command: "cat entities/orders.yml" },
              output: "ok",
            },
            {
              toolName: "executeSQL",
              input: { sql: "SELECT 1" },
              output: { success: true, columns: ["x"], rows: [{ x: 1 }] },
            },
          ],
        },
      ]),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    };

    const runtime = buildRuntime();
    const adapter = createProactiveAnswerAdapter(runtime, {
      resolveOrgForUser: async () => "org-x",
      resolveActor: async () =>
        createAtlasUser("user-x", "managed", "u@e.com", {
          activeOrganizationId: "org-x",
        }),
    });

    const result = await adapter("with refs", {
      threadId: "T-refs",
      asker: slackAsker,
      atlasUserId: "user-x",
    });

    expect(result.answer).toBe("Answer with refs");
    expect(result.entitiesReferenced).toEqual(["orders"]);
    // `metricsReferenced` is omitted when empty (matches the listener's
    // "host doesn't report this" fall-through).
    expect(result.metricsReferenced).toBeUndefined();
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Sanity: the factory satisfies the ProactiveExecuteQuery wire contract
// ---------------------------------------------------------------------------

describe("createProactiveAnswerAdapter — contract", () => {
  it("returns a ProactiveExecuteQuery-shaped callback", () => {
    const runtime = ManagedRuntime.make(
      createAiModelTestLayer({ providerType: "anthropic", modelId: "test" }).pipe(
        Layer.merge(Layer.empty),
      ),
    );
    const adapter = createProactiveAnswerAdapter(runtime);
    expect(typeof adapter).toBe("function");
    // Two-arg callback per the @useatlas/chat type.
    expect(adapter.length).toBe(2);
    void runtime.dispose();
  });
});

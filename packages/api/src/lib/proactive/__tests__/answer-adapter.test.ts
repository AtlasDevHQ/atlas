/**
 * Tests for the proactive answer adapter (#2614).
 *
 * Pins:
 *  - Linked path: when `atlasUserId` is non-null, the adapter resolves
 *    the user's org via the supplied `resolveOrgForUser` callback,
 *    builds an actor via `resolveActor`, and the agent observes that
 *    actor on `RequestContext.user`.
 *  - Unlinked path: when `atlasUserId` is null, the agent runs with a
 *    synthetic anonymous identity (`slack-bot:proactive:<threadId>`)
 *    and no `activeOrganizationId`, AND `runAgent` receives the
 *    restricted public-dataset {@link ToolRegistry} (see
 *    `public-dataset-tools.ts`).
 *  - Unlinked refusals: missing `getPublicDataset`, empty allowlist,
 *    and resolver-throw all refuse the request without invoking
 *    `runAgent`. Each path logs an `event` tag specific to the
 *    failure.
 *  - Tool extraction: `executeSQL` tool calls produce `sql` + `data`
 *    entries; `explore` `cat entities/x.yml` commands produce
 *    `entitiesReferenced`; `cat metrics/y.yml` produces
 *    `metricsReferenced`.
 *  - Error surface: when `runAgent` throws, the adapter logs the
 *    developer detail (with `event: proactive.answer.agent_failed`)
 *    and rethrows the user-safe message. The model-resolution path
 *    has its own `event` tag.
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
  hasCustomToolRegistry: boolean;
}
const observedRunAgentCalls: ObservedRunAgentCall[] = [];

// Logger spy — captures every `log.error` call's first arg (the
// structured payload). Lets the error-path test assert that the
// adapter logged `{ threadId, askerId, errorMessage, event }` against
// the right `event` tag.
interface LoggedError {
  payload: Record<string, unknown>;
  message: string;
}
const loggedErrors: LoggedError[] = [];
const loggedWarns: LoggedError[] = [];

// `runAgent` return shape — what the adapter awaits via `.text` / `.steps`.
interface RunAgentMockReturn {
  text: Promise<string>;
  steps: Promise<unknown[]>;
  totalUsage?: Promise<unknown>;
}
let nextRunAgentResult: RunAgentMockReturn | null = null;
let nextRunAgentError: Error | null = null;

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: async (params: {
    messages: { parts: { text: string }[] }[];
    tools?: unknown;
  }) => {
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
      // Non-null when the adapter built a restricted registry for the
      // unlinked-asker path. The unlinked path test asserts truthy;
      // linked path tests assert falsy.
      hasCustomToolRegistry: params.tools !== undefined,
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

// Mock the logger so the error-path tests can assert what the adapter
// logged + against which `event` tag. The factory MUST be sync (per
// CLAUDE.md `bun:test` rule) so we use `require` to grab the real
// module's `withRequestContext` / `getRequestContext` / other exports
// (the adapter and the runAgent mock both rely on those staying
// functional). `createLogger` is replaced with a spy that records
// every `error` / `warn` call's payload + message.
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("@atlas/api/lib/logger") as Record<string, unknown>;
mock.module("@atlas/api/lib/logger", () => ({
  ...realLogger,
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (payload: Record<string, unknown>, message?: string) => {
      loggedWarns.push({ payload, message: message ?? "" });
    },
    error: (payload: Record<string, unknown>, message?: string) => {
      loggedErrors.push({ payload, message: message ?? "" });
    },
    fatal: () => {},
    trace: () => {},
    child: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      trace: () => {},
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { ProactiveAsker } from "@useatlas/chat";
import {
  assertAtlasUserId,
  assertExternalUserId,
  assertWorkspaceId,
} from "@useatlas/chat";

const { createAiModelTestLayer } = await import(
  "@atlas/api/lib/effect/ai"
);
const { createProactiveAnswerAdapter, collectProactiveResult, renderDataAsMarkdownTables } =
  await import("../answer-adapter");
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

const slackAsker: ProactiveAsker = {
  platform: "slack",
  externalUserId: assertExternalUserId("U999"),
  userName: "Alice",
};

beforeEach(() => {
  observedRunAgentCalls.length = 0;
  nextRunAgentResult = null;
  nextRunAgentError = null;
  loggedErrors.length = 0;
  loggedWarns.length = 0;
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
      atlasUserId: assertAtlasUserId("user-linked"),
      workspaceId: assertWorkspaceId("org-linked"),
    });

    expect(result.answer).toBe("Linked answer");
    expect(observedRunAgentCalls).toHaveLength(1);
    expect(observedRunAgentCalls[0].userId).toBe("user-linked");
    expect(observedRunAgentCalls[0].orgId).toBe("org-linked");
    expect(observedRunAgentCalls[0].approvalSurface).toBe("slack");
    expect(observedRunAgentCalls[0].question).toBe("how many customers?");
    // Linked askers get the default ToolRegistry — no `tools` arg
    // passed through to runAgent.
    expect(observedRunAgentCalls[0].hasCustomToolRegistry).toBe(false);

    await runtime.dispose();
  });

  it("refuses (does not invoke the agent) when the linked user no longer resolves to an actor", async () => {
    // Deleted-account scenario: resolveOrgForUser succeeds but
    // resolveActor returns null. Running the agent with actor=null
    // would attach no `user` to RequestContext and short-circuit any
    // downstream rule-matching gate — refuse instead.
    const runtime = buildRuntime();
    const adapter = createProactiveAnswerAdapter(runtime, {
      resolveOrgForUser: async () => null,
      resolveActor: async () => null,
    });

    await expect(
      adapter("orphan question", {
        threadId: "T-orphan",
        asker: slackAsker,
        atlasUserId: assertAtlasUserId("user-missing"),
        workspaceId: assertWorkspaceId("org-orphan"),
      }),
    ).rejects.toThrow(/Atlas couldn't answer this/);

    // Critical: the agent must NOT have been invoked.
    expect(observedRunAgentCalls).toHaveLength(0);
    await runtime.dispose();
  });

  it("refuses (F-55 fail-closed) when resolveOrgForUser throws — never runs the agent with reduced scope", async () => {
    // F-55 regression: a thrown `resolveOrgForUser` is infra failure,
    // not "user has no org" (which returns null). Running with
    // orgId=null would short-circuit checkApprovalRequired and bypass
    // rule-matching gates — refuse instead.
    const runtime = buildRuntime();
    const dbError = new Error("connection terminated unexpectedly");
    const adapter = createProactiveAnswerAdapter(runtime, {
      resolveOrgForUser: async () => {
        throw dbError;
      },
      // Should never be invoked once resolveOrgForUser throws.
      resolveActor: async () => {
        throw new Error("resolveActor must not be called after resolveOrgForUser throws");
      },
    });

    await expect(
      adapter("how many customers?", {
        threadId: "T-fail",
        asker: slackAsker,
        atlasUserId: assertAtlasUserId("user-1"),
        workspaceId: assertWorkspaceId("org-1"),
      }),
    ).rejects.toThrow(/Atlas couldn't answer this/);

    expect(observedRunAgentCalls).toHaveLength(0);
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Unlinked path
// ---------------------------------------------------------------------------

describe("createProactiveAnswerAdapter — unlinked path", () => {
  it("binds a synthetic anonymous identity (no org) AND a restricted tool registry when atlasUserId is null", async () => {
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
      getPublicDataset: async () => [
        { entityName: "public_customers", denyMetrics: [] },
        { entityName: "public_revenue", denyMetrics: ["margin"] },
      ],
    });

    const result = await adapter("what is revenue?", {
      threadId: "T-unlinked",
      asker: slackAsker,
      atlasUserId: null,
      workspaceId: assertWorkspaceId("org-public"),
    });

    expect(result.answer).toBe("Public-dataset answer");
    expect(observedRunAgentCalls[0].userId).toContain("slack-bot:proactive:T-unlinked");
    // Anonymous identity must NOT carry an active org — RLS + workspace
    // model routing both branch on `activeOrganizationId`, so an empty
    // string here is the unlinked-asker fingerprint.
    expect(observedRunAgentCalls[0].orgId === null || observedRunAgentCalls[0].orgId === "").toBe(true);
    // AC #2614 belt-and-braces: agent runs with a restricted registry,
    // not the default workspace toolset. The listener's post-filter is
    // a backstop — the adapter-side gate prevents the agent from
    // reading sensitive entities in the first place.
    expect(observedRunAgentCalls[0].hasCustomToolRegistry).toBe(true);
    await runtime.dispose();
  });

  it("refuses unlinked-asker request when getPublicDataset is not wired", async () => {
    const runtime = buildRuntime();
    // No getPublicDataset — the adapter MUST refuse rather than fall
    // through to an unrestricted agent run.
    const adapter = createProactiveAnswerAdapter(runtime, {});

    await expect(
      adapter("public-dataset question", {
        threadId: "T-missing",
        asker: slackAsker,
        atlasUserId: null,
        workspaceId: assertWorkspaceId("org-missing"),
      }),
    ).rejects.toThrow(/Atlas couldn't answer this/);

    // runAgent must NOT have been called — the refusal happens BEFORE
    // the agent is dispatched.
    expect(observedRunAgentCalls).toHaveLength(0);

    // The refusal logs against its own event tag so operators can
    // distinguish "host wiring bug" from runtime failures.
    const matchingError = loggedErrors.find(
      (e) => e.payload.event === "proactive.answer.public_dataset_missing",
    );
    expect(matchingError).toBeDefined();
    expect(matchingError?.payload.threadId).toBe("T-missing");
    await runtime.dispose();
  });

  it("refuses unlinked-asker request when the allowlist is empty", async () => {
    const runtime = buildRuntime();
    const adapter = createProactiveAnswerAdapter(runtime, {
      getPublicDataset: async () => [],
    });

    await expect(
      adapter("question against empty allowlist", {
        threadId: "T-empty",
        asker: slackAsker,
        atlasUserId: null,
        workspaceId: assertWorkspaceId("org-empty"),
      }),
    ).rejects.toThrow(/Atlas couldn't answer this/);
    expect(observedRunAgentCalls).toHaveLength(0);

    // Empty allowlist is a workspace-config signal, not an error —
    // logged as a warn with the dedicated event tag.
    const matchingWarn = loggedWarns.find(
      (w) => w.payload.event === "proactive.answer.public_dataset_empty",
    );
    expect(matchingWarn).toBeDefined();
    await runtime.dispose();
  });

  it("refuses unlinked-asker request when getPublicDataset throws", async () => {
    const runtime = buildRuntime();
    const adapter = createProactiveAnswerAdapter(runtime, {
      getPublicDataset: async () => {
        throw new Error("registry connection refused");
      },
    });

    await expect(
      adapter("resolver-fail question", {
        threadId: "T-fail",
        asker: slackAsker,
        atlasUserId: null,
        workspaceId: assertWorkspaceId("org-fail"),
      }),
    ).rejects.toThrow(/Atlas couldn't answer this/);
    expect(observedRunAgentCalls).toHaveLength(0);

    const matchingError = loggedErrors.find(
      (e) => e.payload.event === "proactive.answer.public_dataset_failed",
    );
    expect(matchingError).toBeDefined();
    expect(matchingError?.payload.errorMessage).toContain("registry connection refused");
    await runtime.dispose();
  });

  it("threads the per-event workspaceId through to getPublicDataset (#2624 multi-tenant)", async () => {
    // The point: pre-#2624 the adapter called `getPublicDataset(asker)`
    // with no workspaceId, so on multi-tenant SaaS the same Slack
    // user-id seen from two tenants would resolve against whichever
    // tenant's allowlist the host implementation happened to default
    // to. The contract change passes the per-event workspaceId so the
    // host scopes the lookup correctly.
    nextRunAgentResult = {
      text: Promise.resolve("scoped public answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    };
    const observedPublicDatasetCalls: Array<{
      askerExternalId: string | undefined;
      workspaceId: string;
    }> = [];
    const runtime = buildRuntime();
    const adapter = createProactiveAnswerAdapter(runtime, {
      getPublicDataset: async (asker, ctx) => {
        observedPublicDatasetCalls.push({
          askerExternalId: asker.externalUserId,
          workspaceId: ctx.workspaceId,
        });
        return [{ entityName: "tenant_scoped_entity", denyMetrics: [] }];
      },
    });

    await adapter("scoped question", {
      threadId: "T-scoped",
      asker: slackAsker,
      atlasUserId: null,
      workspaceId: assertWorkspaceId("tenant-B"),
    });

    expect(observedPublicDatasetCalls).toHaveLength(1);
    expect(observedPublicDatasetCalls[0]).toEqual({
      askerExternalId: slackAsker.externalUserId,
      workspaceId: assertWorkspaceId("tenant-B"),
    });
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("createProactiveAnswerAdapter — error handling", () => {
  it("rethrows a user-safe message AND logs the developer detail with event tag when runAgent throws", async () => {
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
        atlasUserId: assertAtlasUserId("user-1"),
        workspaceId: assertWorkspaceId("org-1"),
      }),
    ).rejects.toThrow(/Atlas couldn't answer this/);

    // log.error MUST fire with the structured payload (#2614 review
    // P1) so operators can correlate the user-safe rethrow to the
    // underlying agent failure. Event tag distinguishes this from the
    // model-resolution / identity branches.
    const agentFailedEntry = loggedErrors.find(
      (e) => e.payload.event === "proactive.answer.agent_failed",
    );
    expect(agentFailedEntry).toBeDefined();
    expect(agentFailedEntry?.payload.threadId).toBe("T-err");
    expect(agentFailedEntry?.payload.askerId).toBe("slack:U999");
    expect(agentFailedEntry?.payload.errorMessage).toContain("ECONNREFUSED");

    await runtime.dispose();
  });

  it("logs against the model-resolution event tag when AtlasAiModel resolution fails", async () => {
    // Force the runtime's AtlasAiModel resolution to fail by passing a
    // ManagedRuntime that does NOT provide the AtlasAiModel layer.
    // `Layer.empty` carries no services so `runPromise(yield* AtlasAiModel)`
    // collapses to a defect — the adapter must catch and emit the
    // `proactive.answer.model_resolution_failed` event tag.
    const emptyRuntime = ManagedRuntime.make(Layer.empty) as unknown as Parameters<
      typeof createProactiveAnswerAdapter
    >[0];
    const adapter = createProactiveAnswerAdapter(emptyRuntime, {
      resolveOrgForUser: async () => "org-1",
      resolveActor: async () =>
        createAtlasUser("user-1", "managed", "u1@example.com", {
          activeOrganizationId: "org-1",
        }),
    });

    await expect(
      adapter("question with broken model", {
        threadId: "T-model",
        asker: slackAsker,
        atlasUserId: assertAtlasUserId("user-1"),
        workspaceId: assertWorkspaceId("org-1"),
      }),
    ).rejects.toThrow(/Atlas couldn't answer this/);

    expect(observedRunAgentCalls).toHaveLength(0); // never reached runAgent
    const modelFailedEntry = loggedErrors.find(
      (e) => e.payload.event === "proactive.answer.model_resolution_failed",
    );
    expect(modelFailedEntry).toBeDefined();
    expect(modelFailedEntry?.payload.threadId).toBe("T-model");
    await emptyRuntime.dispose();
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
      atlasUserId: assertAtlasUserId("user-x"),
      workspaceId: assertWorkspaceId("org-x"),
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

// ---------------------------------------------------------------------------
// renderDataAsMarkdownTables — #2705 disclosure rendering
// ---------------------------------------------------------------------------

describe("renderDataAsMarkdownTables (#2705)", () => {
  it("normalizes Date cells to ISO 8601 instead of locale-dependent String(date)", () => {
    // pg's type parser hands us Date objects for timestamp columns.
    // `String(date)` produces e.g. "Mon May 23 2026 …" which is
    // locale-dependent and lacks an explicit timezone — useless in a
    // chat post. ISO is canonical and shorter.
    const rendered = renderDataAsMarkdownTables([
      {
        columns: ["created_at"],
        rows: [{ created_at: new Date("2026-05-23T03:30:00.000Z") }],
      },
    ]);
    expect(rendered).toContain("2026-05-23T03:30:00.000Z");
    // The locale-dependent prefix must NOT leak through. "Mon" / "Tue" /
    // "Sat" all show up in `Date.prototype.toString()` — guard a future
    // refactor that drops the Date check.
    expect(rendered).not.toMatch(/Mon |Tue |Wed |Thu |Fri |Sat |Sun /);
  });

  it("truncates the developer view when it exceeds the character budget", () => {
    // Build a single very-wide row that blows past 30k chars on its
    // own. The cap is enforced AFTER per-table row truncation so we
    // can't reach it via row count alone.
    const wideValue = "x".repeat(40_000);
    const rendered = renderDataAsMarkdownTables([
      {
        columns: ["payload"],
        rows: [{ payload: wideValue }],
      },
    ]);
    expect(rendered.length).toBeLessThanOrEqual(30_000 + 200); // budget + truncation marker
    expect(rendered).toContain("developer view truncated");
  });

  it("does not append the truncation marker when the rendered output fits", () => {
    const rendered = renderDataAsMarkdownTables([
      { columns: ["region", "count"], rows: [{ region: "US", count: 3 }] },
    ]);
    expect(rendered).not.toContain("developer view truncated");
    expect(rendered).toContain("US");
  });
});

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

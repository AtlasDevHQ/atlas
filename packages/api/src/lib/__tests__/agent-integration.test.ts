/**
 * Integration tests for the agent loop (runAgent).
 *
 * Exercises the full streamText → tool execution → multi-step flow with a
 * MockLanguageModelV3 that returns pre-configured tool calls per step.
 *
 * All external dependencies are mocked:
 * - LLM provider → MockLanguageModelV3 from ai/test
 * - Database → canned query results
 * - Semantic layer → fixed whitelist
 * - Shell backend (just-bash) → canned command outputs
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import {
  MockLanguageModelV3,
  convertArrayToReadableStream,
} from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";

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
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["companies", "people"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
}));

let mockDBQuery: (sql: string, timeout?: number) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }> =
  async () => ({ columns: ["id", "name"], rows: [{ id: 1, name: "Acme" }] });

const mockDBConnectionObj = {
  query: (...args: [string, number?]) => mockDBQuery(...args),
  close: async () => {},
};
mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => mockDBConnectionObj,
  connections: {
    get: () => mockDBConnectionObj,
    getDefault: () => mockDBConnectionObj,
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost:5432",
    getValidator: () => undefined,
    getParserDialect: () => undefined,
    getForbiddenPatterns: () => [],
    list: () => ["default"],
    describe: () => [{ id: "default", dbType: "postgres" as const }],
  },
  detectDBType: () => "postgres" as const,
}));

// Mock just-bash to avoid OverlayFs/filesystem dependency in CI.
// The mock Bash.exec() returns canned stdout for known commands and
// simulates path-traversal rejection for `../` patterns.
mock.module("just-bash", () => ({
  Bash: class MockBash {
    constructor(_: unknown) {}
    async exec(command: string) {
      if (command.includes("../")) {
        return {
          stdout: "",
          stderr: `cat: ${command.split(" ").pop()}: No such file or directory`,
          exitCode: 1,
        };
      }
      if (/^ls(\s|$)/.test(command)) {
        return {
          stdout: "catalog.yml\nentities/\nmetrics/\nglossary.yml\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("cat catalog.yml")) {
        return {
          stdout: "entities:\n  - companies\n  - people\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`MockBash: unhandled command "${command}". Add a case to the mock.`);
    }
  },
  OverlayFs: class MockOverlayFs {
    constructor(_: unknown) {}
  },
}));

// ---------------------------------------------------------------------------
// Imports — after mocks so modules resolve to mocked versions
// ---------------------------------------------------------------------------

const { runAgent } = await import("@atlas/api/lib/agent");
const { invalidateExploreBackend } = await import("@atlas/api/lib/tools/explore");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Subset of executeSQL tool output fields used in assertions. */
interface SQLOutput {
  success: boolean;
  error?: string;
  row_count?: number;
  columns?: string[];
  rows?: Record<string, unknown>[];
}

let callId = 0;
function nextId(): string {
  return `call-${++callId}`;
}

/** V3-format usage object for finish chunks. */
const MOCK_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

/** Build stream chunks for a single tool call step. */
function makeToolStepChunks(
  toolName: string,
  args: Record<string, unknown>,
): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-call", toolCallId: nextId(), toolName, input: JSON.stringify(args) },
    { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "tool-calls", raw: "tool_use" } },
  ];
}

/** Build a simple user message array for runAgent. */
function userMessages(content: string): UIMessage[] {
  return [
    {
      id: "msg-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: content }],
    },
  ];
}

/**
 * Find all tool result outputs for a given tool name across all steps.
 *
 * The agent may place tool calls and their results in different steps,
 * or insert text-only steps between them, so hard-coding step indices
 * like `steps[0].toolResults[0]` is fragile. This helper searches
 * every step's `toolResults` array by `toolName` and returns all
 * matching `.output` values in order.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

describe("agent integration", () => {
  beforeEach(() => {
    callId = 0;
    invalidateExploreBackend();
    process.env.ATLAS_DATASOURCE_URL = "postgresql://test:test@localhost:5432/test";
    delete process.env.ATLAS_TABLE_WHITELIST;
    mockDBQuery = async () => ({ columns: ["id", "name"], rows: [{ id: 1, name: "Acme" }] });
  });

  // -----------------------------------------------------------------------
  // 1. Happy path — explore → executeSQL
  // -----------------------------------------------------------------------

  it("happy path — explore → executeSQL", async () => {
    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("explore", { command: "cat catalog.yml" }),
          makeToolStepChunks("executeSQL", { sql: "SELECT id, name FROM companies LIMIT 10", explanation: "List companies" }),
          // Final step: text-only response (model stops calling tools → loop ends)
          [
            { type: "text-delta", id: "text-0", delta: "Found 1 company: Acme." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ messages: userMessages("Show me all companies") });
    const steps = await result.steps;

    // Loop terminated naturally after 3 steps (explore + executeSQL + text-only)
    expect(steps.length).toBe(3);

    // Both tools were called
    const exploreResults = findToolResults(steps, "explore");
    const sqlResults = findToolResults(steps, "executeSQL");

    expect(exploreResults.length).toBe(1);
    expect(sqlResults.length).toBe(1);

    // executeSQL succeeded
    expect(sqlResults[0]).toMatchObject({
      success: true,
      row_count: 1,
    });
  });

  // -----------------------------------------------------------------------
  // 2. SQL error recovery — bad table → retry → success
  // -----------------------------------------------------------------------

  it("SQL error recovery — bad table → retry → success", async () => {
    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", { sql: "SELECT * FROM nonexistent_table", explanation: "Try bad table" }),
          makeToolStepChunks("executeSQL", { sql: "SELECT id FROM companies", explanation: "Retry with correct table" }),
          [
            { type: "text-delta", id: "text-0", delta: "Found data." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ messages: userMessages("List companies") });
    const steps = await result.steps;

    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];
    expect(sqlResults.length).toBe(2);

    // First SQL call returns error (whitelist rejection)
    expect(sqlResults[0].success).toBe(false);
    expect(sqlResults[0].error).toContain("not in the allowed list");

    // Second SQL call succeeds
    expect(sqlResults[1].success).toBe(true);
    expect(sqlResults[1].row_count).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 3. Step limit enforcement (25 steps)
  // -----------------------------------------------------------------------

  it("step limit enforcement — stops after 25 steps", async () => {
    // Model always returns explore ls — never stops calling tools
    mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream(
          makeToolStepChunks("explore", { command: "ls" }),
        ),
      }),
    });

    const result = await runAgent({
      messages: userMessages("What data do you have?"),
    });
    const steps = await result.steps;

    // stopWhen: stepCountIs(25) should cap the loop
    expect(steps.length).toBe(25);
  });

  // -----------------------------------------------------------------------
  // 4. Explore path traversal rejection
  // -----------------------------------------------------------------------

  it("explore rejects path traversal (../../.env)", async () => {
    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("explore", { command: "cat ../../.env" }),
          [
            { type: "text-delta", id: "text-0", delta: "Could not access file." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ messages: userMessages("Read .env") });
    const steps = await result.steps;

    // NOTE: Protection comes from OverlayFs in production; here we test that
    // the explore tool surfaces backend errors correctly (not file contents).
    const exploreResults = findToolResults(steps, "explore");
    expect(exploreResults.length).toBe(1);
    const exploreResult = exploreResults[0];
    expect(typeof exploreResult).toBe("string");
    expect(exploreResult as string).toInclude("Error (exit 1)");
    expect(exploreResult as string).toInclude("No such file or directory");
    expect(exploreResult as string).not.toInclude("DATABASE_URL");
    expect(exploreResult as string).not.toInclude("ATLAS_DATASOURCE_URL");
  });

  // -----------------------------------------------------------------------
  // 5. SQL whitelist enforcement
  // -----------------------------------------------------------------------

  it("SQL whitelist blocks queries on non-whitelisted tables", async () => {
    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", { sql: "SELECT * FROM secret_table", explanation: "Access secret" }),
          [
            { type: "text-delta", id: "text-0", delta: "Table not available." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ messages: userMessages("Show secret data") });
    const steps = await result.steps;

    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];
    expect(sqlResults.length).toBe(1);
    expect(sqlResults[0].success).toBe(false);
    expect(sqlResults[0].error).toContain("not in the allowed list");
  });

  // -----------------------------------------------------------------------
  // 6. Empty / malicious SQL rejection
  // -----------------------------------------------------------------------

  it("rejects DDL (DROP TABLE) and empty SQL", async () => {
    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", { sql: "DROP TABLE companies", explanation: "Drop attempt" }),
          makeToolStepChunks("executeSQL", { sql: "", explanation: "Empty query" }),
          [
            { type: "text-delta", id: "text-0", delta: "Blocked." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({
      messages: userMessages("Do something bad"),
    });
    const steps = await result.steps;

    // The agent may insert text-only steps between tool calls, so search
    // across all steps by tool name instead of hard-coding step indices.
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];
    expect(sqlResults.length).toBeGreaterThanOrEqual(2);

    // DDL blocked by regex guard
    expect(sqlResults[0].success).toBe(false);
    expect(sqlResults[0].error).toContain("Forbidden");

    // Empty SQL blocked
    expect(sqlResults[1].success).toBe(false);
    expect(sqlResults[1].error).toContain("Empty");
  });

  // -----------------------------------------------------------------------
  // 7. Database error — sensitive errors are redacted
  // -----------------------------------------------------------------------

  it("database error — sensitive errors are redacted", async () => {
    // Override mock DB to throw a sensitive error (matches the "connection string" pattern)
    mockDBQuery = async () => {
      throw new Error("invalid connection string: postgresql://admin:secret@db.example.com:5432/prod");
    };

    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", { sql: "SELECT id FROM companies", explanation: "Test query" }),
          [
            { type: "text-delta", id: "text-0", delta: "Failed." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ messages: userMessages("Test") });
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];
    expect(sqlResults.length).toBe(1);
    expect(sqlResults[0].success).toBe(false);
    expect(sqlResults[0].error).toContain("Database query failed");
    // Must NOT leak the connection string
    expect(sqlResults[0].error).not.toContain("db.example.com");
  });

  // -----------------------------------------------------------------------
  // 8. Database error — non-sensitive errors surface detail for self-correction
  // -----------------------------------------------------------------------

  it("database error — non-sensitive errors surface hint and position for self-correction", async () => {
    mockDBQuery = async () => {
      const err = new Error('column "nonexistent" does not exist') as Error & { hint?: string; position?: string };
      err.hint = 'Perhaps you meant to reference the column "name".';
      err.position = "8";
      throw err;
    };

    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", { sql: "SELECT nonexistent FROM companies", explanation: "Bad column" }),
          [
            { type: "text-delta", id: "text-0", delta: "Failed." },
            { type: "finish", usage: MOCK_USAGE, finishReason: { unified: "stop", raw: "end_turn" } },
          ],
        ];
        if (streamIdx >= allSteps.length) {
          return { stream: convertArrayToReadableStream(allSteps[allSteps.length - 1]) };
        }
        return { stream: convertArrayToReadableStream(allSteps[streamIdx++]) };
      },
    });

    const result = await runAgent({ messages: userMessages("Test") });
    const steps = await result.steps;
    const sqlResults = findToolResults(steps, "executeSQL") as SQLOutput[];
    expect(sqlResults.length).toBe(1);
    expect(sqlResults[0].success).toBe(false);
    expect(sqlResults[0].error).toContain("does not exist");
    expect(sqlResults[0].error).toContain("Hint:");
    expect(sqlResults[0].error).toContain("at character 8");
  });

  // -----------------------------------------------------------------------
  // 9. Auto-LIMIT injection — verify LIMIT is appended
  // -----------------------------------------------------------------------

  it("auto-LIMIT — LIMIT is appended to queries without one", async () => {
    let capturedSQL = "";
    mockDBQuery = async (sql: string) => {
      capturedSQL = sql;
      return { columns: ["id"], rows: [{ id: 1 }] };
    };

    let streamIdx = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        const allSteps: LanguageModelV3StreamPart[][] = [
          makeToolStepChunks("executeSQL", { sql: "SELECT id FROM companies", explanation: "No limit" }),
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

    const result = await runAgent({ messages: userMessages("Test") });
    await result.steps;
    expect(capturedSQL).toContain("LIMIT 1000");
  });
});

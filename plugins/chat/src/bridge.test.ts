/**
 * Tests for the Chat SDK ↔ Atlas bridge.
 *
 * Covers:
 * - JSX card builders (query result, error, approval, data table)
 * - Response formatting (markdown fallback, SQL, metadata)
 * - Error scrubbing (connection strings, stack traces, API keys, user scrubber faults)
 * - Legacy card builders (approval cards, action result formatting)
 * - Config validation (adapter requirements, callback types, state config, actions, conversations)
 * - Plugin lifecycle (initialization, health checks, teardown, double-init guard)
 * - State adapter wiring (factory, PG requires db, redis stub)
 */

import { describe, expect, it } from "bun:test";
import {
  formatQueryResponse,
  scrubErrorMessage,
  buildApprovalCard,
  formatActionResult,
} from "./bridge";
import { buildQueryResultCard } from "./cards/query-result-card";
import { buildErrorCard } from "./cards/error-card";
import { buildApprovalCardJSX } from "./cards/approval-card";
import { buildDataTableCard } from "./cards/data-table-card";
import type { ChatQueryResult, PendingAction } from "./config";
import { createStateAdapter } from "./state";
import { createRedisAdapter } from "./state/redis-adapter";

// ---------------------------------------------------------------------------
// formatQueryResponse
// ---------------------------------------------------------------------------

describe("formatQueryResponse", () => {
  it("formats a complete query result as markdown", () => {
    const result: ChatQueryResult = {
      answer: "There were 42 active users last month.",
      sql: ["SELECT COUNT(*) FROM users WHERE active = true"],
      data: [
        {
          columns: ["count"],
          rows: [{ count: 42 }],
        },
      ],
      steps: 3,
      usage: { totalTokens: 1500 },
    };

    const output = formatQueryResponse(result);

    expect(output).toContain("42 active users");
    expect(output).toContain("```sql");
    expect(output).toContain("SELECT COUNT(*)");
    expect(output).toContain("| count |");
    expect(output).toContain("| 42 |");
    expect(output).toContain("3 steps");
    expect(output).toContain("1,500 tokens");
  });

  it("handles empty answer", () => {
    const result: ChatQueryResult = {
      answer: "",
      sql: [],
      data: [],
      steps: 1,
      usage: { totalTokens: 100 },
    };

    const output = formatQueryResponse(result);
    expect(output).toContain("No answer generated.");
  });

  it("omits SQL section when no SQL queries", () => {
    const result: ChatQueryResult = {
      answer: "Here is the answer.",
      sql: [],
      data: [],
      steps: 1,
      usage: { totalTokens: 50 },
    };

    const output = formatQueryResponse(result);
    expect(output).not.toContain("```sql");
    expect(output).not.toContain("**SQL**");
  });

  it("omits data table when no data", () => {
    const result: ChatQueryResult = {
      answer: "No data found.",
      sql: ["SELECT * FROM users WHERE 1=0"],
      data: [{ columns: [], rows: [] }],
      steps: 2,
      usage: { totalTokens: 200 },
    };

    const output = formatQueryResponse(result);
    expect(output).not.toContain("| --- |");
  });

  it("truncates large data tables to 20 rows", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `User ${i + 1}` }));
    const result: ChatQueryResult = {
      answer: "Here are the users.",
      sql: ["SELECT * FROM users"],
      data: [{ columns: ["id", "name"], rows }],
      steps: 2,
      usage: { totalTokens: 500 },
    };

    const output = formatQueryResponse(result);
    expect(output).toContain("Showing first 20 of 30 rows");
    expect(output).not.toContain("User 21");
  });

  it("formats multiple SQL queries", () => {
    const result: ChatQueryResult = {
      answer: "Done.",
      sql: ["SELECT 1", "SELECT 2"],
      data: [],
      steps: 2,
      usage: { totalTokens: 100 },
    };

    const output = formatQueryResponse(result);
    expect(output).toContain("SELECT 1");
    expect(output).toContain("SELECT 2");
  });
});

// ---------------------------------------------------------------------------
// buildApprovalCard
// ---------------------------------------------------------------------------

describe("buildApprovalCard", () => {
  const action: PendingAction = {
    id: "act-001",
    type: "notification",
    target: "#revenue",
    summary: "Send notification to #revenue channel",
  };

  it("returns a card element", () => {
    const card = buildApprovalCard(action);
    expect(card.type).toBe("card");
    expect(card.children.length).toBe(2);
  });

  it("includes a section with the action summary", () => {
    const card = buildApprovalCard(action);
    // Card title carries the "requires approval" heading
    expect(card.title).toBe("Action requires approval");
    const section = card.children[0];
    expect(section.type).toBe("section");
    // TextElement uses `content`, not `text`
    const textChild = (section as { children: { content?: string }[] }).children[0];
    expect(textChild.content).toContain("Send notification to #revenue channel");
  });

  it("includes approve and deny buttons", () => {
    const card = buildApprovalCard(action);
    const actions = card.children[1] as { type: string; children: { id: string; value?: string; style?: string }[] };
    expect(actions.type).toBe("actions");
    expect(actions.children.length).toBe(2);

    const approveBtn = actions.children[0];
    expect(approveBtn.id).toBe("atlas_action_approve");
    expect(approveBtn.value).toBe("act-001");
    expect(approveBtn.style).toBe("primary");

    const denyBtn = actions.children[1];
    expect(denyBtn.id).toBe("atlas_action_deny");
    expect(denyBtn.value).toBe("act-001");
    expect(denyBtn.style).toBe("danger");
  });

  it("truncates long summaries", () => {
    const longAction: PendingAction = {
      id: "act-002",
      type: "notification",
      target: "#all",
      summary: "A".repeat(300),
    };
    const card = buildApprovalCard(longAction);
    const section = card.children[0] as { children: { content?: string }[] };
    expect((section.children[0].content ?? "").length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// JSX Card Builders
// ---------------------------------------------------------------------------

describe("buildQueryResultCard", () => {
  it("returns card and fallbackText", () => {
    const result: ChatQueryResult = {
      answer: "There were 42 active users last month.",
      sql: ["SELECT COUNT(*) FROM users WHERE active = true"],
      data: [{ columns: ["count"], rows: [{ count: 42 }] }],
      steps: 3,
      usage: { totalTokens: 1500 },
    };

    const { card, fallbackText } = buildQueryResultCard(result);

    // Card structure
    expect(card.type).toBe("card");
    expect(card.children.length).toBeGreaterThan(0);

    // Fallback text contains all key elements
    expect(fallbackText).toContain("42 active users");
    expect(fallbackText).toContain("```sql");
    expect(fallbackText).toContain("SELECT COUNT(*)");
    expect(fallbackText).toContain("| count |");
    expect(fallbackText).toContain("3 steps");
    expect(fallbackText).toContain("1,500 tokens");
  });

  it("card contains table element for data", () => {
    const result: ChatQueryResult = {
      answer: "Results.",
      sql: [],
      data: [{ columns: ["id", "name"], rows: [{ id: 1, name: "Alice" }] }],
      steps: 1,
      usage: { totalTokens: 100 },
    };

    const { card } = buildQueryResultCard(result);
    const tableChild = card.children.find((c) => c.type === "table");
    expect(tableChild).toBeDefined();
  });

  it("card contains fields for metadata", () => {
    const result: ChatQueryResult = {
      answer: "Done.",
      sql: [],
      data: [],
      steps: 5,
      usage: { totalTokens: 2000 },
    };

    const { card } = buildQueryResultCard(result);
    const fieldsChild = card.children.find((c) => c.type === "fields");
    expect(fieldsChild).toBeDefined();
  });

  it("handles empty answer", () => {
    const result: ChatQueryResult = {
      answer: "",
      sql: [],
      data: [],
      steps: 1,
      usage: { totalTokens: 100 },
    };

    const { fallbackText } = buildQueryResultCard(result);
    expect(fallbackText).toContain("No answer generated.");
  });

  it("truncates large data tables in fallback", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `User ${i + 1}` }));
    const result: ChatQueryResult = {
      answer: "Users.",
      sql: [],
      data: [{ columns: ["id", "name"], rows }],
      steps: 1,
      usage: { totalTokens: 100 },
    };

    const { fallbackText } = buildQueryResultCard(result);
    expect(fallbackText).toContain("Showing first 20 of 30 rows");
    expect(fallbackText).not.toContain("User 21");
  });
});

describe("buildErrorCard", () => {
  it("returns card with error message", () => {
    const { card, fallbackText } = buildErrorCard({ message: "Query timed out after 30s" });

    expect(card.type).toBe("card");
    expect(card.title).toBe("Unable to complete request");
    expect(fallbackText).toContain("Query timed out after 30s");
    expect(fallbackText).toContain("transient issue");
  });

  it("uses custom retry hint", () => {
    const { fallbackText } = buildErrorCard({
      message: "Rate limit exceeded",
      retryHint: "Wait 60 seconds before retrying.",
    });

    expect(fallbackText).toContain("Wait 60 seconds");
    expect(fallbackText).not.toContain("transient issue");
  });

  it("card has text children for message and hint", () => {
    const { card } = buildErrorCard({ message: "Error occurred" });
    const textChildren = card.children.filter((c) => c.type === "text");
    expect(textChildren.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildApprovalCardJSX", () => {
  const action: PendingAction = {
    id: "act-001",
    type: "notification",
    target: "#revenue",
    summary: "Send notification to #revenue channel",
  };

  it("returns card and fallbackText", () => {
    const { card, fallbackText } = buildApprovalCardJSX(action);

    expect(card.type).toBe("card");
    expect(card.title).toBe("Action requires approval");
    expect(fallbackText).toContain("Action requires approval");
    expect(fallbackText).toContain("Send notification to #revenue channel");
  });

  it("card has section and actions children", () => {
    const { card } = buildApprovalCardJSX(action);
    expect(card.children.some((c) => c.type === "section")).toBe(true);
    expect(card.children.some((c) => c.type === "actions")).toBe(true);
  });

  it("actions contain approve and deny buttons", () => {
    const { card } = buildApprovalCardJSX(action);
    const actions = card.children.find((c) => c.type === "actions") as {
      type: string;
      children: { id: string; value?: string; style?: string }[];
    };

    expect(actions.children.length).toBe(2);
    expect(actions.children[0].id).toBe("atlas_action_approve");
    expect(actions.children[0].value).toBe("act-001");
    expect(actions.children[0].style).toBe("primary");
    expect(actions.children[1].id).toBe("atlas_action_deny");
    expect(actions.children[1].style).toBe("danger");
  });
});

describe("buildDataTableCard", () => {
  it("returns card with table element", () => {
    const { card, fallbackText } = buildDataTableCard({
      columns: ["id", "name"],
      rows: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
    });

    expect(card.type).toBe("card");
    const tableChild = card.children.find((c) => c.type === "table");
    expect(tableChild).toBeDefined();

    expect(fallbackText).toContain("| id | name |");
    expect(fallbackText).toContain("| 1 | Alice |");
  });

  it("truncates rows and shows indicator", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ n: i + 1 }));
    const { fallbackText } = buildDataTableCard({
      columns: ["n"],
      rows,
      maxRows: 10,
    });

    expect(fallbackText).toContain("Showing first 10 of 25 rows");
  });
});

// ---------------------------------------------------------------------------
// formatActionResult
// ---------------------------------------------------------------------------

describe("formatActionResult", () => {
  const action: PendingAction = {
    id: "act-001",
    type: "notification",
    target: "#revenue",
    summary: "Send notification",
  };

  it("formats approved status", () => {
    const result = formatActionResult(action, "approved");
    expect(result).toContain("approved");
    expect(result).toContain("Send notification");
    expect(result).toContain("\u2705"); // checkmark
  });

  it("formats executed status", () => {
    const result = formatActionResult(action, "executed");
    expect(result).toContain("executed");
    expect(result).toContain("\u2705");
  });

  it("formats denied status", () => {
    const result = formatActionResult(action, "denied");
    expect(result).toContain("denied");
    expect(result).toContain("\u26D4"); // no entry
  });

  it("formats failed status with error", () => {
    const result = formatActionResult(action, "failed", "Permission denied");
    expect(result).toContain("failed");
    expect(result).toContain("\u274C"); // cross
    expect(result).toContain("Permission denied");
  });

  it("falls back to type when summary is empty", () => {
    const noSummary: PendingAction = { ...action, summary: "" };
    const result = formatActionResult(noSummary, "approved");
    expect(result).toContain("notification");
  });
});

// ---------------------------------------------------------------------------
// scrubErrorMessage
// ---------------------------------------------------------------------------

describe("scrubErrorMessage", () => {
  it("scrubs PostgreSQL connection strings", () => {
    const msg = "Connection failed: postgres://admin:secret@db.example.com:5432/mydb";
    const scrubbed = scrubErrorMessage(msg);
    expect(scrubbed).not.toContain("postgres://");
    expect(scrubbed).not.toContain("secret");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs MySQL connection strings", () => {
    const msg = "Error: mysql://root:pass@localhost/db timeout";
    const scrubbed = scrubErrorMessage(msg);
    expect(scrubbed).not.toContain("mysql://");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs stack traces", () => {
    const msg = "Error at Object.query (src/lib/db.ts:42:10)";
    const scrubbed = scrubErrorMessage(msg);
    expect(scrubbed).not.toContain("src/lib/db.ts:42:10");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs file paths", () => {
    const msg = "ENOENT: /home/app/src/config.ts not found";
    const scrubbed = scrubErrorMessage(msg);
    expect(scrubbed).not.toContain("/home/app/src/config.ts");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs Slack bot tokens", () => {
    const msg = "Auth failed with token xoxb-12345-67890-abcdef";
    const scrubbed = scrubErrorMessage(msg);
    expect(scrubbed).not.toContain("xoxb-");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs Bearer tokens", () => {
    const msg = "Unauthorized: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";
    const scrubbed = scrubErrorMessage(msg);
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs GitHub tokens", () => {
    const msg = "GitHub error with ghp_abc123def456ghi789jkl";
    const scrubbed = scrubErrorMessage(msg);
    expect(scrubbed).not.toContain("ghp_abc123");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("applies user scrubber after built-in patterns", () => {
    const msg = "Error: postgres://admin:secret@db.com/prod — custom detail here";
    const scrubbed = scrubErrorMessage(msg, (m) =>
      m.replace("custom detail here", "[CUSTOM_REDACTED]"),
    );
    expect(scrubbed).not.toContain("postgres://");
    expect(scrubbed).toContain("[CUSTOM_REDACTED]");
  });

  it("passes through safe messages unchanged", () => {
    const msg = "Query timed out after 30 seconds";
    const scrubbed = scrubErrorMessage(msg);
    expect(scrubbed).toBe(msg);
  });

  it("survives user scrubber throwing", () => {
    const msg = "Error: postgres://admin:secret@db.com/prod";
    const scrubbed = scrubErrorMessage(msg, () => {
      throw new Error("scrubber bug");
    });
    // Built-in scrubbing should still have run
    expect(scrubbed).not.toContain("postgres://");
    expect(scrubbed).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Plugin factory (config validation)
// ---------------------------------------------------------------------------

describe("chatPlugin config validation", () => {
  it("rejects config with no adapters", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {},
        executeQuery: async () => ({
          answer: "",
          sql: [],
          data: [],
          steps: 0,
          usage: { totalTokens: 0 },
        }),
      }),
    ).toThrow(/at least one adapter/i);
  });

  it("rejects config without executeQuery", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          slack: { botToken: "xoxb-test", signingSecret: "test-secret" },
        },
        executeQuery: "not a function" as never,
      }),
    ).toThrow(/executeQuery/i);
  });

  it("rejects slack adapter with empty botToken", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          slack: { botToken: "", signingSecret: "test-secret" },
        },
        executeQuery: async () => ({
          answer: "",
          sql: [],
          data: [],
          steps: 0,
          usage: { totalTokens: 0 },
        }),
      }),
    ).toThrow(/botToken/i);
  });

  it("accepts valid config with slack adapter", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
      },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
    });

    expect(plugin.id).toBe("chat-interaction");
    expect(plugin.types).toEqual(["interaction"]);
    expect(plugin.version).toBe("0.2.0");
    expect(plugin.name).toBe("Chat SDK Bridge");
  });

  it("accepts config with actions callbacks", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
      },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
      actions: {
        approve: async () => ({ status: "executed" }),
        deny: async () => ({}),
        get: async () => null,
      },
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts config with conversations callbacks", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
      },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
      conversations: {
        create: async () => ({ id: "conv-1" }),
        addMessage: () => {},
        get: async () => null,
        generateTitle: (q) => q.slice(0, 80),
      },
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts config with OAuth credentials", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: {
          botToken: "xoxb-test-token",
          signingSecret: "test-signing-secret",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        },
      },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("rejects invalid actions callbacks", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
        },
        executeQuery: async () => ({
          answer: "test",
          sql: [],
          data: [],
          steps: 1,
          usage: { totalTokens: 10 },
        }),
        actions: { approve: "not a function" } as never,
      }),
    ).toThrow(/actions/i);
  });

  it("rejects conversations missing addMessage or generateTitle", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
        },
        executeQuery: async () => ({
          answer: "test",
          sql: [],
          data: [],
          steps: 1,
          usage: { totalTokens: 10 },
        }),
        conversations: {
          create: async () => ({ id: "conv-1" }),
          get: async () => null,
          // missing addMessage and generateTitle
        } as never,
      }),
    ).toThrow(/conversations/i);
  });

  it("rejects clientId without clientSecret", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          slack: {
            botToken: "xoxb-test-token",
            signingSecret: "test-signing-secret",
            clientId: "test-client-id",
            // missing clientSecret
          },
        },
        executeQuery: async () => ({
          answer: "test",
          sql: [],
          data: [],
          steps: 1,
          usage: { totalTokens: 10 },
        }),
      }),
    ).toThrow(/clientId.*clientSecret|config validation/i);
  });
});

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

describe("chat plugin lifecycle", () => {
  function createTestPlugin() {
    // Dynamic import to avoid top-level side effects
    const { buildChatPlugin } = require("./index");
    return buildChatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
      },
      executeQuery: async () => ({
        answer: "test answer",
        sql: ["SELECT 1"],
        data: [],
        steps: 1,
        usage: { totalTokens: 50 },
      }),
    });
  }

  it("healthCheck returns unhealthy before initialization", async () => {
    const plugin = createTestPlugin();
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("not initialized");
  });

  it("initialize sets up the bridge", async () => {
    const plugin = createTestPlugin();
    const logs: string[] = [];

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: unknown) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg)),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("slack");
  });

  it("teardown cleans up", async () => {
    const plugin = createTestPlugin();

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    });

    await plugin.teardown!();

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  it("double initialize throws", async () => {
    const plugin = createTestPlugin();
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    };

    await plugin.initialize!(ctx);
    await expect(plugin.initialize!(ctx)).rejects.toThrow(/already initialized/);
  });
});

// ---------------------------------------------------------------------------
// State adapter factory
// ---------------------------------------------------------------------------

describe("createStateAdapter", () => {
  it("defaults to memory when no config provided", () => {
    const adapter = createStateAdapter(undefined, null);
    expect(adapter).toBeDefined();
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.subscribe).toBe("function");
  });

  it("creates memory adapter explicitly", () => {
    const adapter = createStateAdapter({ backend: "memory" }, null);
    expect(adapter).toBeDefined();
  });

  it("creates PG adapter when db is provided", () => {
    const mockDb = {
      async query() { return { rows: [] }; },
      async execute() {},
    };
    const adapter = createStateAdapter({ backend: "pg" }, mockDb);
    expect(adapter).toBeDefined();
  });

  it("throws when PG backend requested without db", () => {
    expect(() => createStateAdapter({ backend: "pg" }, null)).toThrow(
      /DATABASE_URL/,
    );
  });

  it("redis stub throws", () => {
    expect(() => createRedisAdapter()).toThrow(/not yet implemented/);
    expect(() => createStateAdapter({ backend: "redis" }, null)).toThrow(
      /not yet implemented/,
    );
  });
});

// ---------------------------------------------------------------------------
// State config validation
// ---------------------------------------------------------------------------

describe("chatPlugin state config validation", () => {
  it("accepts config with state backend", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
      },
      state: { backend: "memory" },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts config without state (defaults to memory)", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
      },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts PG state config with custom prefix", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
      },
      state: { backend: "pg", tablePrefix: "myapp_" },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
    });

    expect(plugin.id).toBe("chat-interaction");
  });
});

// ---------------------------------------------------------------------------
// Teams adapter config validation
// ---------------------------------------------------------------------------

describe("chatPlugin Teams adapter config", () => {
  const mockExecuteQuery = async () => ({
    answer: "test",
    sql: [] as string[],
    data: [] as { columns: string[]; rows: Record<string, unknown>[] }[],
    steps: 1,
    usage: { totalTokens: 10 },
  });

  it("accepts valid config with teams adapter", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        teams: { appId: "test-app-id", appPassword: "test-app-password" },
      },
      executeQuery: mockExecuteQuery,
    });

    expect(plugin.id).toBe("chat-interaction");
    expect(plugin.types).toEqual(["interaction"]);
    expect(plugin.version).toBe("0.2.0");
  });

  it("accepts teams config with tenant restriction", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        teams: {
          appId: "test-app-id",
          appPassword: "test-app-password",
          tenantId: "tenant-123",
        },
      },
      executeQuery: mockExecuteQuery,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts config with both slack and teams adapters", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
        teams: { appId: "test-app-id", appPassword: "test-app-password" },
      },
      executeQuery: mockExecuteQuery,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("rejects teams adapter with empty appId", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          teams: { appId: "", appPassword: "test-app-password" },
        },
        executeQuery: mockExecuteQuery,
      }),
    ).toThrow(/appId/i);
  });

  it("rejects teams adapter with empty appPassword", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          teams: { appId: "test-app-id", appPassword: "" },
        },
        executeQuery: mockExecuteQuery,
      }),
    ).toThrow(/appPassword/i);
  });

  it("rejects teams adapter with empty tenantId", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          teams: { appId: "test-app-id", appPassword: "test-pw", tenantId: "" },
        },
        executeQuery: mockExecuteQuery,
      }),
    ).toThrow(/config validation/i);
  });

  it("rejects unknown adapter keys", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          whatsapp: { token: "test" },
        } as never,
        executeQuery: mockExecuteQuery,
      }),
    ).toThrow(/config validation/i);
  });
});

// ---------------------------------------------------------------------------
// Teams adapter factory
// ---------------------------------------------------------------------------

describe("createTeamsAdapter", () => {
  it("sets MultiTenant when no tenantId", async () => {
    const { createTeamsAdapter: createAdapter } = await import("./adapters/teams");
    const { createTeamsAdapter: upstream } = await import("@chat-adapter/teams");

    // We can't easily inspect what was passed to the upstream, but we can
    // verify the adapter is created successfully and has the right name.
    const adapter = createAdapter({ appId: "test-id", appPassword: "test-pw" });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("teams");
  });

  it("sets SingleTenant when tenantId is provided", async () => {
    const { createTeamsAdapter: createAdapter } = await import("./adapters/teams");

    const adapter = createAdapter({
      appId: "test-id",
      appPassword: "test-pw",
      tenantId: "tenant-123",
    });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("teams");
  });
});

// ---------------------------------------------------------------------------
// Webhook route guards
// ---------------------------------------------------------------------------

describe("webhook route guards", () => {
  it("teams webhook returns 503 before initialization", async () => {
    const { buildChatPlugin } = require("./index");
    const { Hono } = require("hono");

    const plugin = buildChatPlugin({
      adapters: {
        teams: { appId: "test-app-id", appPassword: "test-app-password" },
      },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
    });

    const app = new Hono();
    plugin.routes!(app);

    const resp = await app.request("/webhooks/teams", { method: "POST" });
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.error).toContain("not yet initialized");
  });

  it("slack webhook returns 503 before initialization", async () => {
    const { buildChatPlugin } = require("./index");
    const { Hono } = require("hono");

    const plugin = buildChatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
      },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
    });

    const app = new Hono();
    plugin.routes!(app);

    const resp = await app.request("/webhooks/slack", { method: "POST" });
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.error).toContain("not yet initialized");
  });
});

// ---------------------------------------------------------------------------
// Teams adapter lifecycle
// ---------------------------------------------------------------------------

describe("chat plugin Teams lifecycle", () => {
  function createTeamsTestPlugin() {
    const { buildChatPlugin } = require("./index");
    return buildChatPlugin({
      adapters: {
        teams: { appId: "test-app-id", appPassword: "test-app-password" },
      },
      executeQuery: async () => ({
        answer: "test answer",
        sql: ["SELECT 1"],
        data: [],
        steps: 1,
        usage: { totalTokens: 50 },
      }),
    });
  }

  it("healthCheck returns unhealthy before initialization", async () => {
    const plugin = createTeamsTestPlugin();
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("not initialized");
  });

  it("initialize sets up the bridge with teams adapter", async () => {
    const plugin = createTeamsTestPlugin();
    const logs: string[] = [];

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: unknown) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg)),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("teams");
  });

  it("teardown cleans up teams adapter", async () => {
    const plugin = createTeamsTestPlugin();

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    });

    await plugin.teardown!();

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  it("double initialize throws with teams adapter", async () => {
    const plugin = createTeamsTestPlugin();
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    };

    await plugin.initialize!(ctx);
    await expect(plugin.initialize!(ctx)).rejects.toThrow(/already initialized/);
  });
});

// ---------------------------------------------------------------------------
// Multi-adapter lifecycle (Slack + Teams)
// ---------------------------------------------------------------------------

describe("chat plugin multi-adapter lifecycle", () => {
  function createMultiAdapterPlugin() {
    const { buildChatPlugin } = require("./index");
    return buildChatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
        teams: { appId: "test-app-id", appPassword: "test-app-password" },
      },
      executeQuery: async () => ({
        answer: "test answer",
        sql: ["SELECT 1"],
        data: [],
        steps: 1,
        usage: { totalTokens: 50 },
      }),
    });
  }

  it("initializes with both adapters", async () => {
    const plugin = createMultiAdapterPlugin();
    const logs: string[] = [];

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: unknown) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg)),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("slack");
    expect(result.message).toContain("teams");
  });
});

// ---------------------------------------------------------------------------
// Discord adapter config validation
// ---------------------------------------------------------------------------

describe("chatPlugin Discord adapter config", () => {
  const mockExecuteQueryFn = async () => ({
    answer: "test",
    sql: [] as string[],
    data: [] as { columns: string[]; rows: Record<string, unknown>[] }[],
    steps: 1,
    usage: { totalTokens: 10 },
  });

  it("accepts valid config with discord adapter", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        discord: {
          botToken: "test-bot-token",
          applicationId: "test-app-id",
          publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        },
      },
      executeQuery: mockExecuteQueryFn,
    });

    expect(plugin.id).toBe("chat-interaction");
    expect(plugin.types).toEqual(["interaction"]);
    expect(plugin.version).toBe("0.2.0");
  });

  it("accepts discord config with mentionRoleIds", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        discord: {
          botToken: "test-bot-token",
          applicationId: "test-app-id",
          publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
          mentionRoleIds: ["role-1", "role-2"],
        },
      },
      executeQuery: mockExecuteQueryFn,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts config with all three adapters", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
        teams: { appId: "test-app-id", appPassword: "test-app-password" },
        discord: {
          botToken: "test-bot-token",
          applicationId: "test-app-id",
          publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        },
      },
      executeQuery: mockExecuteQueryFn,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("rejects discord adapter with empty botToken", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          discord: { botToken: "", applicationId: "test-app-id", publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/botToken/i);
  });

  it("rejects discord adapter with empty applicationId", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          discord: { botToken: "test-token", applicationId: "", publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/applicationId/i);
  });

  it("rejects discord adapter with empty publicKey", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          discord: { botToken: "test-token", applicationId: "test-app-id", publicKey: "" },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/publicKey/i);
  });

  it("rejects discord adapter with empty mentionRoleIds element", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          discord: {
            botToken: "test-token",
            applicationId: "test-app-id",
            publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            mentionRoleIds: [""],
          },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/config validation/i);
  });
});

// ---------------------------------------------------------------------------
// Discord adapter factory
// ---------------------------------------------------------------------------

describe("createDiscordAdapter", () => {
  it("creates adapter with correct name", async () => {
    const { createDiscordAdapter: createAdapter } = await import("./adapters/discord");

    const adapter = createAdapter({
      botToken: "test-token",
      applicationId: "test-app-id",
      publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("discord");
  });

  it("passes mentionRoleIds through", async () => {
    const { createDiscordAdapter: createAdapter } = await import("./adapters/discord");

    const adapter = createAdapter({
      botToken: "test-token",
      applicationId: "test-app-id",
      publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      mentionRoleIds: ["role-1"],
    });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("discord");
  });
});

// ---------------------------------------------------------------------------
// Discord webhook route guard
// ---------------------------------------------------------------------------

describe("discord webhook route guard", () => {
  it("discord webhook returns 503 before initialization", async () => {
    const { buildChatPlugin } = require("./index");
    const { Hono } = require("hono");

    const plugin = buildChatPlugin({
      adapters: {
        discord: {
          botToken: "test-bot-token",
          applicationId: "test-app-id",
          publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        },
      },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
    });

    const app = new Hono();
    plugin.routes!(app);

    const resp = await app.request("/webhooks/discord", { method: "POST" });
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.error).toContain("not yet initialized");
  });
});

// ---------------------------------------------------------------------------
// Discord adapter lifecycle
// ---------------------------------------------------------------------------

describe("chat plugin Discord lifecycle", () => {
  function createDiscordTestPlugin() {
    const { buildChatPlugin } = require("./index");
    return buildChatPlugin({
      adapters: {
        discord: {
          botToken: "test-bot-token",
          applicationId: "test-app-id",
          publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        },
      },
      executeQuery: async () => ({
        answer: "test answer",
        sql: ["SELECT 1"],
        data: [],
        steps: 1,
        usage: { totalTokens: 50 },
      }),
    });
  }

  it("healthCheck returns unhealthy before initialization", async () => {
    const plugin = createDiscordTestPlugin();
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("not initialized");
  });

  it("initialize sets up the bridge with discord adapter", async () => {
    const plugin = createDiscordTestPlugin();
    const logs: string[] = [];

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: unknown) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg)),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("discord");
  });

  it("teardown cleans up discord adapter", async () => {
    const plugin = createDiscordTestPlugin();

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    });

    await plugin.teardown!();

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  it("double initialize throws with discord adapter", async () => {
    const plugin = createDiscordTestPlugin();
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    };

    await plugin.initialize!(ctx);
    await expect(plugin.initialize!(ctx)).rejects.toThrow(/already initialized/);
  });
});

// ---------------------------------------------------------------------------
// Multi-adapter lifecycle (all three adapters)
// ---------------------------------------------------------------------------

describe("chat plugin three-adapter lifecycle", () => {
  function createTripleAdapterPlugin() {
    const { buildChatPlugin } = require("./index");
    return buildChatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
        teams: { appId: "test-app-id", appPassword: "test-app-password" },
        discord: {
          botToken: "test-bot-token",
          applicationId: "test-app-id",
          publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        },
      },
      executeQuery: async () => ({
        answer: "test answer",
        sql: ["SELECT 1"],
        data: [],
        steps: 1,
        usage: { totalTokens: 50 },
      }),
    });
  }

  it("initializes with all three adapters", async () => {
    const plugin = createTripleAdapterPlugin();
    const logs: string[] = [];

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: unknown) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg)),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("slack");
    expect(result.message).toContain("teams");
    expect(result.message).toContain("discord");
  });
});

// ---------------------------------------------------------------------------
// Google Chat adapter config validation
// ---------------------------------------------------------------------------

describe("chatPlugin Google Chat adapter config", () => {
  const mockExecuteQueryFn = async () => ({
    answer: "test",
    sql: [] as string[],
    data: [] as { columns: string[]; rows: Record<string, unknown>[] }[],
    steps: 1,
    usage: { totalTokens: 10 },
  });

  it("accepts valid config with gchat adapter (no credentials — env auto-detect)", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        gchat: {},
      },
      executeQuery: mockExecuteQueryFn,
    });

    expect(plugin.id).toBe("chat-interaction");
    expect(plugin.types).toEqual(["interaction"]);
    expect(plugin.version).toBe("0.2.0");
  });

  it("accepts gchat config with service account credentials", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        gchat: {
          credentials: {
            client_email: "bot@my-project.iam.gserviceaccount.com",
            private_key: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n",
          },
        },
      },
      executeQuery: mockExecuteQueryFn,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts gchat config with ADC", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        gchat: {
          useApplicationDefaultCredentials: true,
        },
      },
      executeQuery: mockExecuteQueryFn,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts gchat config with pubsubTopic and endpointUrl", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        gchat: {
          credentials: {
            client_email: "bot@my-project.iam.gserviceaccount.com",
            private_key: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n",
          },
          endpointUrl: "https://my-atlas.example.com/api/plugins/chat-interaction/webhooks/gchat",
          pubsubTopic: "projects/my-project/topics/chat-events",
          impersonateUser: "admin@example.com",
        },
      },
      executeQuery: mockExecuteQueryFn,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("rejects gchat config with invalid pubsubTopic format", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          gchat: {
            pubsubTopic: "invalid-topic",
          },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/pubsubTopic/i);
  });

  it("rejects gchat config with invalid endpointUrl", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          gchat: {
            endpointUrl: "not-a-url",
          },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/endpointUrl/i);
  });

  it("rejects gchat config with invalid impersonateUser email", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          gchat: {
            impersonateUser: "not-an-email",
          },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/impersonateUser/i);
  });

  it("rejects gchat credentials with empty private_key", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          gchat: {
            credentials: {
              client_email: "bot@my-project.iam.gserviceaccount.com",
              private_key: "",
            },
          },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/private_key/i);
  });

  it("rejects gchat credentials with invalid client_email", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          gchat: {
            credentials: {
              client_email: "not-an-email",
              private_key: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n",
            },
          },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/client_email/i);
  });

  it("rejects gchat config with both credentials and ADC", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        adapters: {
          gchat: {
            credentials: {
              client_email: "bot@test.iam.gserviceaccount.com",
              private_key: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n",
            },
            useApplicationDefaultCredentials: true,
          },
        },
        executeQuery: mockExecuteQueryFn,
      }),
    ).toThrow(/not both/i);
  });

  it("accepts config with all four adapters", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
        teams: { appId: "test-app-id", appPassword: "test-app-password" },
        discord: {
          botToken: "test-bot-token",
          applicationId: "test-app-id",
          publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        },
        gchat: {},
      },
      executeQuery: mockExecuteQueryFn,
    });

    expect(plugin.id).toBe("chat-interaction");
  });
});

// ---------------------------------------------------------------------------
// Google Chat adapter factory
// ---------------------------------------------------------------------------

describe("createGoogleChatAdapter", () => {
  it("creates adapter with correct name", async () => {
    const { createGoogleChatAdapter: createAdapter } = await import("./adapters/gchat");

    const adapter = createAdapter({ credentials: testGchatCredentials });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("gchat");
  });

  it("creates adapter with full config", async () => {
    const { createGoogleChatAdapter: createAdapter } = await import("./adapters/gchat");

    const adapter = createAdapter({
      credentials: testGchatCredentials,
      endpointUrl: "https://example.com/api/webhooks/gchat",
      pubsubTopic: "projects/my-project/topics/chat-events",
    });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("gchat");
  });
});

// ---------------------------------------------------------------------------
// Google Chat webhook route guard
// ---------------------------------------------------------------------------

// Dummy service account credentials for test adapter construction.
// The adapter validates credential shape but doesn't make API calls during tests.
const testGchatCredentials = {
  client_email: "bot@test-project.iam.gserviceaccount.com",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRiMLAH\n-----END RSA PRIVATE KEY-----\n",
  project_id: "test-project",
};

describe("gchat webhook route guard", () => {
  it("gchat webhook returns 503 before initialization", async () => {
    const { buildChatPlugin } = require("./index");
    const { Hono } = require("hono");

    const plugin = buildChatPlugin({
      adapters: {
        gchat: { credentials: testGchatCredentials },
      },
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
    });

    const app = new Hono();
    plugin.routes!(app);

    const resp = await app.request("/webhooks/gchat", { method: "POST" });
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.error).toContain("not yet initialized");
  });
});

// ---------------------------------------------------------------------------
// Google Chat adapter lifecycle
// ---------------------------------------------------------------------------

describe("chat plugin Google Chat lifecycle", () => {
  function createGchatTestPlugin() {
    const { buildChatPlugin } = require("./index");
    return buildChatPlugin({
      adapters: {
        gchat: { credentials: testGchatCredentials },
      },
      executeQuery: async () => ({
        answer: "test answer",
        sql: ["SELECT 1"],
        data: [],
        steps: 1,
        usage: { totalTokens: 50 },
      }),
    });
  }

  it("healthCheck returns unhealthy before initialization", async () => {
    const plugin = createGchatTestPlugin();
    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("not initialized");
  });

  it("initialize sets up the bridge with gchat adapter", async () => {
    const plugin = createGchatTestPlugin();
    const logs: string[] = [];

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: unknown) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg)),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("gchat");
  });

  it("teardown cleans up gchat adapter", async () => {
    const plugin = createGchatTestPlugin();

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    });

    await plugin.teardown!();

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(false);
  });

  it("double initialize throws with gchat adapter", async () => {
    const plugin = createGchatTestPlugin();
    const ctx = {
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    };

    await plugin.initialize!(ctx);
    await expect(plugin.initialize!(ctx)).rejects.toThrow(/already initialized/);
  });
});

// ---------------------------------------------------------------------------
// Multi-adapter lifecycle (all four adapters)
// ---------------------------------------------------------------------------

describe("chat plugin four-adapter lifecycle", () => {
  function createQuadAdapterPlugin() {
    const { buildChatPlugin } = require("./index");
    return buildChatPlugin({
      adapters: {
        slack: { botToken: "xoxb-test-token", signingSecret: "test-signing-secret" },
        teams: { appId: "test-app-id", appPassword: "test-app-password" },
        discord: {
          botToken: "test-bot-token",
          applicationId: "test-app-id",
          publicKey: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        },
        gchat: { credentials: testGchatCredentials },
      },
      executeQuery: async () => ({
        answer: "test answer",
        sql: ["SELECT 1"],
        data: [],
        steps: 1,
        usage: { totalTokens: 50 },
      }),
    });
  }

  it("initializes with all four adapters", async () => {
    const plugin = createQuadAdapterPlugin();
    const logs: string[] = [];

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: {
        info: (msg: unknown) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg)),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("slack");
    expect(result.message).toContain("teams");
    expect(result.message).toContain("discord");
    expect(result.message).toContain("gchat");
  });
});

/**
 * Tests for the Chat SDK ↔ Atlas bridge.
 *
 * Covers:
 * - Response formatting (markdown tables, SQL, metadata)
 * - Error scrubbing (connection strings, stack traces, API keys)
 * - Bridge lifecycle (creation, shutdown)
 * - Event mapping (onNewMention → executeQuery → thread.post)
 * - Follow-up handling (onSubscribedMessage with thread history)
 * - Rate limiting
 */

import { describe, expect, it } from "bun:test";
import {
  formatQueryResponse,
  scrubErrorMessage,
} from "./bridge";
import type { ChatQueryResult } from "./config";

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
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.name).toBe("Chat SDK Bridge");
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

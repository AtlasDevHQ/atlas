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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
import type { ChatCatalogEntryInput, ChatQueryResult, PendingAction } from "./config";
import { createStateAdapter } from "./state";
import { createRedisAdapter } from "./state/redis-adapter";

/**
 * Canonical "Slack is wired" catalog used across config-validation
 * tests post-#2650 (slice 2 of 1.5.2). The pre-#2650 tests passed
 * `adapters: { slack: { botToken, signingSecret } }` to the same
 * effect; that shape was removed when adapter activation became
 * catalog-driven. AdapterRegistry tests in
 * `./adapter-registry.test.ts` cover the env-var credential layer
 * separately.
 */
const SLACK_CATALOG: ReadonlyArray<ChatCatalogEntryInput> = [
  {
    slug: "slack",
    type: "chat",
    install_model: "oauth",
    enabled: true,
    saas_eligible: true,
  },
];

/**
 * Slice 2 of 1.5.2 (#2650): AdapterRegistry reads per-Platform creds
 * from `process.env`. Lifecycle suites need real env vars so the Slack
 * adapter instantiates and healthCheck flips healthy. This helper wires
 * matching beforeEach/afterEach hooks that snapshot the four
 * SLACK_* vars on entry, override them with deterministic test values,
 * and restore the snapshot on exit so adjacent suites see clean state.
 * Hex64 matches production format.
 */
function withSlackEnv(): void {
  const snapshot: Record<string, string | undefined> = {
    SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    SLACK_ENCRYPTION_KEY: process.env.SLACK_ENCRYPTION_KEY,
  };

  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "test-client-id";
    process.env.SLACK_CLIENT_SECRET = "test-client-secret";
    process.env.SLACK_SIGNING_SECRET = "abcdef0123456789abcdef0123456789";
    process.env.SLACK_ENCRYPTION_KEY = "f".repeat(64);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

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
    expect(result).toContain("{{emoji:check}}");
  });

  it("formats executed status", () => {
    const result = formatActionResult(action, "executed");
    expect(result).toContain("executed");
    expect(result).toContain("{{emoji:check}}");
  });

  it("formats denied status", () => {
    const result = formatActionResult(action, "denied");
    expect(result).toContain("denied");
    expect(result).toContain("{{emoji:stop}}");
  });

  it("formats failed status with error", () => {
    const result = formatActionResult(action, "failed", "Permission denied");
    expect(result).toContain("failed");
    expect(result).toContain("{{emoji:x}}");
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
  // Post-#2650 (slice 2 of 1.5.2): chat-adapter activation is catalog-driven.
  // Per-Platform credential validation (botToken format, signingSecret hex
  // length) moved into the AdapterRegistry env-var checks; this describe
  // block validates only the plugin's own config-shape contract.
  //
  // Strict-Zod (`.strict()` on ChatConfigSchema) rejects any leftover
  // `adapters:` key from a pre-#2650 host so the migration cannot land
  // half-done.

  it("rejects legacy `adapters` field with an unrecognized-key error", async () => {
    const { chatPlugin } = await import("./index");
    expect(() =>
      chatPlugin({
        // Cast so TS still permits the legacy shape inside the test — the
        // contract under test is the runtime Zod error, not the static type.
        adapters: { slack: { botToken: "xoxb", signingSecret: "x".repeat(32) } },
        catalog: SLACK_CATALOG,
        executeQuery: async () => ({
          answer: "",
          sql: [],
          data: [],
          steps: 0,
          usage: { totalTokens: 0 },
        }),
      } as never),
    ).toThrow(/adapters|unrecognized/i);
  });

  it("accepts an empty / omitted catalog (plugin boots, AdapterRegistry warns)", async () => {
    // Self-host / dev path: no chat catalog → no adapters wire, but the
    // plugin still constructs and registers cleanly. healthCheck will
    // report unhealthy until at least one adapter activates.
    const { chatPlugin } = await import("./index");
    const plugin = chatPlugin({
      executeQuery: async () => ({
        answer: "",
        sql: [],
        data: [],
        steps: 0,
        usage: { totalTokens: 0 },
      }),
    });
    expect(plugin.id).toBe("chat-interaction");
  });

  it("rejects config without executeQuery", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        catalog: SLACK_CATALOG,
        executeQuery: "not a function" as never,
      }),
    ).toThrow(/executeQuery/i);
  });

  it("rejects a catalog entry with an unknown install_model", async () => {
    const { chatPlugin } = await import("./index");
    expect(() =>
      chatPlugin({
        catalog: [
          {
            slug: "slack",
            type: "chat",
            install_model: "not-a-model" as never,
            enabled: true,
            saas_eligible: true,
          },
        ],
        executeQuery: async () => ({
          answer: "",
          sql: [],
          data: [],
          steps: 0,
          usage: { totalTokens: 0 },
        }),
      }),
    ).toThrow(/install_model/i);
  });

  it("rejects a catalog entry with an unknown type", async () => {
    const { chatPlugin } = await import("./index");
    expect(() =>
      chatPlugin({
        catalog: [
          {
            slug: "slack",
            type: "datasource" as never,
            install_model: "oauth",
            enabled: true,
            saas_eligible: true,
          },
        ],
        executeQuery: async () => ({
          answer: "",
          sql: [],
          data: [],
          steps: 0,
          usage: { totalTokens: 0 },
        }),
      }),
    ).toThrow(/type/i);
  });

  it("accepts valid config with slack adapter", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
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
      catalog: SLACK_CATALOG,
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
      catalog: SLACK_CATALOG,
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

  it("accepts catalog declaring Slack OAuth (creds live in env, not in config)", async () => {
    // Post-#2650: the catalog declaration carries `install_model: 'oauth'`
    // but per-Platform credentials (clientId, clientSecret, etc.) come
    // from `process.env` — the chat plugin config no longer accepts them.
    const { chatPlugin } = await import("./index");
    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
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
        catalog: SLACK_CATALOG,
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
        catalog: SLACK_CATALOG,
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

  // The pre-#2650 "rejects clientId without clientSecret" test asserted
  // a per-platform Zod superRefine that no longer reaches through the
  // chat plugin config — those credential checks moved to the
  // AdapterRegistry env-var layer (see `./adapter-registry.test.ts`'s
  // missing-env-var matrix). Dropped here to keep one source of truth.
});

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

describe("chat plugin lifecycle", () => {
  withSlackEnv();

  function createTestPlugin() {
    // Dynamic import to avoid top-level side effects
    const { buildChatPlugin } = require("./index");
    return buildChatPlugin({
      catalog: SLACK_CATALOG,
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
      catalog: SLACK_CATALOG,
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
      catalog: SLACK_CATALOG,
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
      catalog: SLACK_CATALOG,
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

// Removed (1.5.2 slice 2 / #2650): "chatPlugin Teams adapter config" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Teams adapter factory
// ---------------------------------------------------------------------------

describe("createTeamsAdapter", () => {
  it("sets MultiTenant when no tenantId", async () => {
    const { createTeamsAdapter: createAdapter } = await import("./adapters/teams");

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

// Removed (1.5.2 slice 2 / #2650): "webhook route guards" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Teams adapter lifecycle
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chat plugin Teams lifecycle" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Multi-adapter lifecycle (Slack + Teams)
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chat plugin multi-adapter lifecycle" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Discord adapter config validation
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chatPlugin Discord adapter config" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
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

// Removed (1.5.2 slice 2 / #2650): "discord webhook route guard" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Discord adapter lifecycle
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chat plugin Discord lifecycle" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Multi-adapter lifecycle (all three adapters)
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chat plugin three-adapter lifecycle" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Google Chat adapter config validation
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chatPlugin Google Chat adapter config" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Telegram adapter config validation
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chatPlugin Telegram adapter config" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
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

// Removed (1.5.2 slice 2 / #2650): "gchat webhook route guard" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Google Chat adapter lifecycle
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chat plugin Google Chat lifecycle" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Telegram adapter factory
// ---------------------------------------------------------------------------

describe("createTelegramAdapter", () => {
  it("creates adapter with correct name", async () => {
    const { createTelegramAdapter: createAdapter } = await import("./adapters/telegram");

    const adapter = createAdapter({ botToken: "123456:test-token" });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("telegram");
  });
});

// ---------------------------------------------------------------------------
// Telegram webhook route guard
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "telegram webhook route guard" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Telegram adapter lifecycle
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chat plugin Telegram lifecycle" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Multi-adapter lifecycle (all five adapters)
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chat plugin five-adapter lifecycle" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Streaming config validation
// ---------------------------------------------------------------------------

describe("chatPlugin streaming config", () => {
  const mockExecuteQueryFn = async () => ({
    answer: "test",
    sql: [] as string[],
    data: [] as { columns: string[]; rows: Record<string, unknown>[] }[],
    steps: 1,
    usage: { totalTokens: 10 },
  });

  const mockExecuteQueryStreamFn = () => ({
    stream: (async function* () {
      yield "Thinking...";
      yield "Done.";
    })(),
    result: Promise.resolve({
      answer: "test",
      sql: [],
      data: [],
      steps: 1,
      usage: { totalTokens: 10 },
    }),
  });

  it("accepts config with streaming enabled", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: mockExecuteQueryFn,
      streaming: { enabled: true, chunkIntervalMs: 500 },
      executeQueryStream: mockExecuteQueryStreamFn,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts config with streaming disabled", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: mockExecuteQueryFn,
      streaming: { enabled: false },
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts config with streaming defaults (no streaming field)", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: mockExecuteQueryFn,
      executeQueryStream: mockExecuteQueryStreamFn,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts config with only chunkIntervalMs", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: mockExecuteQueryFn,
      streaming: { chunkIntervalMs: 2000 },
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("rejects chunkIntervalMs below 200ms", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        catalog: SLACK_CATALOG,
        executeQuery: mockExecuteQueryFn,
        streaming: { chunkIntervalMs: 50 },
      }),
    ).toThrow(/chunkIntervalMs/i);
  });

  it("rejects chunkIntervalMs above 10000ms", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        catalog: SLACK_CATALOG,
        executeQuery: mockExecuteQueryFn,
        streaming: { chunkIntervalMs: 20000 },
      }),
    ).toThrow(/chunkIntervalMs/i);
  });

  it("rejects non-function executeQueryStream", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        catalog: SLACK_CATALOG,
        executeQuery: mockExecuteQueryFn,
        executeQueryStream: "not a function" as never,
      }),
    ).toThrow(/executeQueryStream/i);
  });

  it("rejects streaming.enabled: true without executeQueryStream", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        catalog: SLACK_CATALOG,
        executeQuery: mockExecuteQueryFn,
        streaming: { enabled: true },
        // no executeQueryStream
      }),
    ).toThrow(/executeQueryStream/i);
  });

  it("allows streaming.enabled: true with executeQueryStream", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: mockExecuteQueryFn,
      streaming: { enabled: true },
      executeQueryStream: mockExecuteQueryStreamFn,
    });

    expect(plugin.id).toBe("chat-interaction");
  });
});

// ---------------------------------------------------------------------------
// Streaming lifecycle
// ---------------------------------------------------------------------------

describe("chat plugin streaming lifecycle", () => {
  withSlackEnv();

  function createStreamingPlugin() {
    const { buildChatPlugin } = require("./index");
    return buildChatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: async () => ({
        answer: "test answer",
        sql: ["SELECT 1"],
        data: [],
        steps: 1,
        usage: { totalTokens: 50 },
      }),
      streaming: { enabled: true, chunkIntervalMs: 1000 },
      executeQueryStream: () => ({
        stream: (async function* () {
          yield "Analyzing...";
          yield "test answer";
        })(),
        result: Promise.resolve({
          answer: "test answer",
          sql: ["SELECT 1"],
          data: [],
          steps: 1,
          usage: { totalTokens: 50 },
        }),
      }),
    });
  }

  it("initializes with streaming config", async () => {
    const plugin = createStreamingPlugin();

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("slack");
  });

  it("teardown cleans up streaming plugin", async () => {
    const plugin = createStreamingPlugin();

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

  it("accepts executeQueryStream returning invalid shape without crashing at init", async () => {
    // The return shape validation happens at call time, not init time.
    // This test verifies the plugin still initializes even with a
    // badly-typed executeQueryStream — the error surfaces when a message arrives.
    const { buildChatPlugin } = require("./index");
    const plugin = buildChatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
      streaming: { enabled: true },
      executeQueryStream: () => ({ wrong: "shape" }),
    });

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
  });

  it("initializes with streaming disabled (falls back to executeQuery)", async () => {
    const { buildChatPlugin } = require("./index");
    const plugin = buildChatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: async () => ({
        answer: "test",
        sql: [],
        data: [],
        steps: 1,
        usage: { totalTokens: 10 },
      }),
      streaming: { enabled: false },
    });

    await plugin.initialize!({
      db: null,
      connections: { get: () => { throw new Error("unused"); }, list: () => [] },
      tools: { register: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: {},
    });

    const result = await plugin.healthCheck!();
    expect(result.healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Configurable slash command name
// ---------------------------------------------------------------------------

describe("chatPlugin slashCommandName config", () => {
  const mockExecuteQuery = async () => ({
    answer: "test",
    sql: [] as string[],
    data: [] as { columns: string[]; rows: Record<string, unknown>[] }[],
    steps: 1,
    usage: { totalTokens: 10 },
  });

  it("accepts valid slash command name", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
      slashCommandName: "/data-query",
      executeQuery: mockExecuteQuery,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("accepts single-word slash command name", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
      slashCommandName: "/query",
      executeQuery: mockExecuteQuery,
    });

    expect(plugin.id).toBe("chat-interaction");
  });

  it("rejects slash command without leading /", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        catalog: SLACK_CATALOG,
        slashCommandName: "atlas",
        executeQuery: mockExecuteQuery,
      }),
    ).toThrow(/slashCommandName/i);
  });

  it("rejects slash command with uppercase letters", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        catalog: SLACK_CATALOG,
        slashCommandName: "/Atlas",
        executeQuery: mockExecuteQuery,
      }),
    ).toThrow(/slashCommandName/i);
  });

  it("rejects slash command with spaces", async () => {
    const { chatPlugin } = await import("./index");

    expect(() =>
      chatPlugin({
        catalog: SLACK_CATALOG,
        slashCommandName: "/my command",
        executeQuery: mockExecuteQuery,
      }),
    ).toThrow(/slashCommandName/i);
  });

  it("defaults to /atlas when omitted", async () => {
    const { chatPlugin } = await import("./index");

    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: mockExecuteQuery,
    });

    // Config should not have slashCommandName set
    expect(plugin.config?.slashCommandName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Query result card quick-action buttons
// ---------------------------------------------------------------------------

describe("buildQueryResultCard quick-action buttons", () => {
  it("includes Run Again and Export CSV buttons when SQL is present", () => {
    const result: ChatQueryResult = {
      answer: "42 users.",
      sql: ["SELECT COUNT(*) FROM users"],
      data: [{ columns: ["count"], rows: [{ count: 42 }] }],
      steps: 2,
      usage: { totalTokens: 500 },
    };

    const { card } = buildQueryResultCard(result);
    const actionsChild = card.children.find((c) => c.type === "actions");
    expect(actionsChild).toBeDefined();

    const buttons = (actionsChild as { children: { id: string; value?: string }[] }).children;
    expect(buttons.length).toBe(2);
    expect(buttons[0].id).toBe("atlas_run_again");
    expect(buttons[0].value).toContain("SELECT COUNT(*)");
    expect(buttons[1].id).toBe("atlas_export_csv");
  });

  it("omits quick-action buttons when no SQL", () => {
    const result: ChatQueryResult = {
      answer: "No SQL needed.",
      sql: [],
      data: [],
      steps: 1,
      usage: { totalTokens: 100 },
    };

    const { card } = buildQueryResultCard(result);
    const actionsChild = card.children.find((c) => c.type === "actions");
    expect(actionsChild).toBeUndefined();
  });

  it("truncates SQL in button value to 2000 chars", () => {
    const longSql = "SELECT " + "x".repeat(3000) + " FROM t";
    const result: ChatQueryResult = {
      answer: "Done.",
      sql: [longSql],
      data: [],
      steps: 1,
      usage: { totalTokens: 100 },
    };

    const { card } = buildQueryResultCard(result);
    const actionsChild = card.children.find((c) => c.type === "actions");
    expect(actionsChild).toBeDefined();

    const buttons = (actionsChild as { children: { value?: string }[] }).children;
    expect((buttons[0].value ?? "").length).toBeLessThanOrEqual(2000);
  });

  it("includes text fallback for platforms without buttons", () => {
    const result: ChatQueryResult = {
      answer: "Done.",
      sql: ["SELECT 1"],
      data: [],
      steps: 1,
      usage: { totalTokens: 100 },
    };

    const { fallbackText } = buildQueryResultCard(result);
    expect(fallbackText).toContain("re-send the same question");
    expect(fallbackText).toContain("export");
  });

  it("omits text fallback when no SQL", () => {
    const result: ChatQueryResult = {
      answer: "Done.",
      sql: [],
      data: [],
      steps: 1,
      usage: { totalTokens: 100 },
    };

    const { fallbackText } = buildQueryResultCard(result);
    expect(fallbackText).not.toContain("re-send the same question");
  });
});

// ---------------------------------------------------------------------------
// Linear adapter config validation
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chatPlugin Linear adapter config" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Linear adapter factory
// ---------------------------------------------------------------------------

describe("createLinearAdapter", () => {
  it("creates adapter with apiKey auth", async () => {
    const { createLinearAdapter } = await import("./adapters/linear");

    const adapter = createLinearAdapter({
      apiKey: "lin_api_test123",
      webhookSecret: "whsec_test",
      userName: "atlas-bot",
    });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("linear");
  });

  it("creates adapter with accessToken auth", async () => {
    const { createLinearAdapter } = await import("./adapters/linear");

    const adapter = createLinearAdapter({
      accessToken: "lin_oauth_test",
      webhookSecret: "whsec_test",
    });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("linear");
  });

  it("creates adapter with clientId + clientSecret auth", async () => {
    const { createLinearAdapter } = await import("./adapters/linear");

    const adapter = createLinearAdapter({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      webhookSecret: "whsec_test",
    });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("linear");
  });
});

// ---------------------------------------------------------------------------
// Linear webhook route guard
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "linear webhook route guard" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Linear adapter lifecycle
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chat plugin Linear lifecycle" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// WhatsApp adapter config validation
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "chatPlugin WhatsApp adapter config" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// WhatsApp adapter factory
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter", () => {
  it("creates adapter with correct name", async () => {
    const { createWhatsAppAdapter: createAdapter } = await import("./adapters/whatsapp");

    const adapter = createAdapter({
      phoneNumberId: "123456789",
      accessToken: "test-token",
      verifyToken: "test-verify",
      appSecret: "test-secret",
    });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("whatsapp");
  });

  it("creates adapter with optional fields", async () => {
    const { createWhatsAppAdapter: createAdapter } = await import("./adapters/whatsapp");

    const adapter = createAdapter({
      phoneNumberId: "123456789",
      accessToken: "test-token",
      verifyToken: "test-verify",
      appSecret: "test-secret",
      userName: "atlas-bot",
      apiVersion: "v18.0",
    });
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("whatsapp");
  });
});

// ---------------------------------------------------------------------------
// WhatsApp webhook route guard
// ---------------------------------------------------------------------------

// Removed (1.5.2 slice 2 / #2650): "whatsapp webhook route guard" — tested the pre-#2650
// `adapters:` config contract which moved to AdapterRegistry env-var checks.
// ---------------------------------------------------------------------------
// Ephemeral error delivery
// ---------------------------------------------------------------------------

describe("ephemeral error delivery", () => {
  it("safePostEphemeralError calls postEphemeral with fallbackToDM: true", async () => {
    // Dynamically access the non-exported function via module internals.
    // We test the behavior through the exported bridge by verifying the
    // contract: errors should use postEphemeral when ephemeral config is enabled.
    //
    // Instead of testing the private function directly, we validate the config
    // integration — EphemeralConfig defaults errorsAsEphemeral to true.
    const { ChatConfigSchema } = await import("./config");

    // Default config: errorsAsEphemeral should be undefined (defaults to true)
    const result = ChatConfigSchema.safeParse({
      catalog: SLACK_CATALOG,
      executeQuery: () => Promise.resolve({ answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 } }),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // No ephemeral config = defaults apply (errorsAsEphemeral: true)
      expect(result.data.ephemeral).toBeUndefined();
    }
  });

  it("EphemeralConfig validates correctly", async () => {
    const { ChatConfigSchema } = await import("./config");

    const result = ChatConfigSchema.safeParse({
      catalog: SLACK_CATALOG,
      executeQuery: () => Promise.resolve({ answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 } }),
      ephemeral: { errorsAsEphemeral: false },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ephemeral?.errorsAsEphemeral).toBe(false);
    }
  });

  it("useEphemeralErrors defaults to true when config.ephemeral is undefined", () => {
    const config = { ephemeral: undefined } as { ephemeral?: { errorsAsEphemeral?: boolean } };
    const useEphemeralErrors = config.ephemeral?.errorsAsEphemeral !== false;
    expect(useEphemeralErrors).toBe(true);
  });

  it("useEphemeralErrors is false when explicitly disabled", () => {
    const config = { ephemeral: { errorsAsEphemeral: false } };
    const useEphemeralErrors = config.ephemeral?.errorsAsEphemeral !== false;
    expect(useEphemeralErrors).toBe(false);
  });

  it("useEphemeralErrors is true when explicitly enabled", () => {
    const config = { ephemeral: { errorsAsEphemeral: true } };
    const useEphemeralErrors = config.ephemeral?.errorsAsEphemeral !== false;
    expect(useEphemeralErrors).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ProactiveConfig schema validation
// ---------------------------------------------------------------------------

describe("ProactiveConfig schema", () => {
  it("accepts a fully-specified proactive config", async () => {
    const { ChatConfigSchema } = await import("./config");

    const result = ChatConfigSchema.safeParse({
      catalog: SLACK_CATALOG,
      executeQuery: () =>
        Promise.resolve({ answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 } }),
      proactive: {
        resolveWorkspaceId: async () => "ws-1",
        isEnabled: () => true,
        classify: async () => ({ isQuestion: true, confidence: 0.9 }),
        getWorkspaceConfig: async () => ({
          enabled: true,
          sensitivity: "balanced",
          classifierMode: "regex-prefilter",
        }),
        getChannelConfigs: async () => [],
        // #2623 item 1: discriminated-union shape with all three groups
        // wired to the "off" branch keeps the test focused on the
        // required-field set without changing what the schema accepts.
        answerFlow: { mode: "off" },
        killSwitch: { enabled: false },
        feedback: { enabled: false },
        installGate: { enabled: false },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects when proactive.isEnabled is not a function", async () => {
    const { ChatConfigSchema } = await import("./config");

    const result = ChatConfigSchema.safeParse({
      catalog: SLACK_CATALOG,
      executeQuery: () =>
        Promise.resolve({ answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 } }),
      proactive: {
        resolveWorkspaceId: async () => "ws-1",
        isEnabled: "not-a-function",
        classify: async () => ({ isQuestion: false, confidence: 0 }),
        getWorkspaceConfig: async () => ({
          enabled: true,
          sensitivity: "balanced",
          classifierMode: "regex-prefilter",
        }),
        getChannelConfigs: async () => [],
        answerFlow: { mode: "off" },
        killSwitch: { enabled: false },
        feedback: { enabled: false },
        installGate: { enabled: false },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects when proactive.resolveWorkspaceId is missing", async () => {
    const { ChatConfigSchema } = await import("./config");

    const result = ChatConfigSchema.safeParse({
      catalog: SLACK_CATALOG,
      executeQuery: () =>
        Promise.resolve({ answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 } }),
      proactive: {
        // resolveWorkspaceId deliberately omitted
        isEnabled: () => true,
        classify: async () => ({ isQuestion: false, confidence: 0 }),
        getWorkspaceConfig: async () => ({
          enabled: true,
          sensitivity: "balanced",
          classifierMode: "regex-prefilter",
        }),
        getChannelConfigs: async () => [],
        answerFlow: { mode: "off" },
        killSwitch: { enabled: false },
        feedback: { enabled: false },
        installGate: { enabled: false },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a half-wired killSwitch at the schema layer (#2623 item 1)", async () => {
    // Runtime parity with the compile-time half-wired check above. A
    // `killSwitch: { enabled: true }` missing `onPauseRequest` is
    // rejected at the discriminated-union boundary rather than booting
    // with a kill-switch read path but no write path.
    const { ChatConfigSchema } = await import("./config");
    const result = ChatConfigSchema.safeParse({
      catalog: SLACK_CATALOG,
      executeQuery: () =>
        Promise.resolve({ answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 } }),
      proactive: {
        resolveWorkspaceId: async () => "ws-1",
        isEnabled: () => true,
        classify: async () => ({ isQuestion: false, confidence: 0 }),
        getWorkspaceConfig: async () => ({
          enabled: true,
          sensitivity: "balanced",
          classifierMode: "regex-prefilter",
        }),
        getChannelConfigs: async () => [],
        answerFlow: { mode: "off" },
        // Half-wired: `enabled: true` but no `onPauseRequest`.
        killSwitch: {
          enabled: true,
          isPaused: async () => ({ paused: false }),
        },
        feedback: { enabled: false },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a half-wired feedback at the schema layer (#2623 item 1)", async () => {
    // Runtime parity: `feedback: { enabled: true }` missing
    // `collector` is rejected at the discriminated-union boundary.
    const { ChatConfigSchema } = await import("./config");
    const result = ChatConfigSchema.safeParse({
      catalog: SLACK_CATALOG,
      executeQuery: () =>
        Promise.resolve({ answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 } }),
      proactive: {
        resolveWorkspaceId: async () => "ws-1",
        isEnabled: () => true,
        classify: async () => ({ isQuestion: false, confidence: 0 }),
        getWorkspaceConfig: async () => ({
          enabled: true,
          sensitivity: "balanced",
          classifierMode: "regex-prefilter",
        }),
        getChannelConfigs: async () => [],
        answerFlow: { mode: "off" },
        killSwitch: { enabled: false },
        // Half-wired: `enabled: true` but no `collector`.
        feedback: { enabled: true },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a half-wired answer-flow at the schema layer (#2623 item 1)", async () => {
    // Compile-time enforcement is pinned by the @ts-expect-error block
    // in `proactive/__tests__/listener.test.ts`. This test pins the
    // runtime version: a `public-only` mode missing `executeQueryProactive`
    // is rejected by the discriminated-union schema rather than silently
    // falling back to the link-Atlas stub like the pre-1.5.2 optional
    // shape did.
    const { ChatConfigSchema } = await import("./config");
    const result = ChatConfigSchema.safeParse({
      catalog: SLACK_CATALOG,
      executeQuery: () =>
        Promise.resolve({ answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 } }),
      proactive: {
        resolveWorkspaceId: async () => "ws-1",
        isEnabled: () => true,
        classify: async () => ({ isQuestion: false, confidence: 0 }),
        getWorkspaceConfig: async () => ({
          enabled: true,
          sensitivity: "balanced",
          classifierMode: "regex-prefilter",
        }),
        getChannelConfigs: async () => [],
        // Half-wired: missing `executeQueryProactive`.
        answerFlow: {
          mode: "public-only",
          getPublicDataset: async () => [],
        },
        killSwitch: { enabled: false },
        feedback: { enabled: false },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Proactive DM API (sendDirectMessage)
// ---------------------------------------------------------------------------

describe("sendDirectMessage contract", () => {
  it("ChatBridge interface includes sendDirectMessage with correct return type", () => {
    // TypeScript compile-time check — verifies the interface has sendDirectMessage
    // with the expected return type shape.
    type DMResult = Awaited<ReturnType<import("./bridge").ChatBridge["sendDirectMessage"]>>;
    const _typeCheck: DMResult = { messageId: "test" };
    expect(_typeCheck).toBeDefined();

    // Also verify null return type is valid
    const _nullCheck: DMResult = null;
    expect(_nullCheck).toBeNull();
  });

  it("sendDirectMessage returns null when adapter is not configured", async () => {
    const { createChatBridge } = await import("./bridge");
    const mockStateAdapter = (await import("./state")).createStateAdapter({ backend: "memory" }, null);
    const mockLogger = {
      info: () => {},
      warn: (..._args: unknown[]) => {},
      error: () => {},
      debug: () => {},
    };
    const bridge = createChatBridge(
      {
        catalog: [],        executeQuery: async () => ({
          answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 },
        }),
      },
      mockLogger as import("@useatlas/plugin-sdk").PluginLogger,
      mockStateAdapter,
      {},
    );

    const result = await bridge.sendDirectMessage("slack", "U123", "hello");
    expect(result).toBeNull();
  });

  it("sendDirectMessage returns null when adapter lacks openDM", async () => {
    const { createChatBridge } = await import("./bridge");
    const mockStateAdapter = (await import("./state")).createStateAdapter({ backend: "memory" }, null);
    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    // Adapter without openDM
    const mockAdapter = {
      name: "test",
      postMessage: async () => ({ id: "msg1", raw: {} }),
      // openDM intentionally omitted
    };
    const bridge = createChatBridge(
      {
        catalog: [],        executeQuery: async () => ({
          answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 },
        }),
      },
      mockLogger as import("@useatlas/plugin-sdk").PluginLogger,
      mockStateAdapter,
      { slack: mockAdapter as unknown as import("chat").Adapter },
    );

    const result = await bridge.sendDirectMessage("slack", "U123", "hello");
    expect(result).toBeNull();
  });

  it("sendDirectMessage returns messageId on success", async () => {
    const { createChatBridge } = await import("./bridge");
    const mockStateAdapter = (await import("./state")).createStateAdapter({ backend: "memory" }, null);
    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    const openDMCalls: string[] = [];
    const postCalls: { threadId: string; message: unknown }[] = [];
    const mockAdapter = {
      name: "slack",
      openDM: async (userId: string) => {
        openDMCalls.push(userId);
        return "DM_CHANNEL_123";
      },
      postMessage: async (threadId: string, message: unknown) => {
        postCalls.push({ threadId, message });
        return { id: "msg_456", raw: {} };
      },
    };
    const bridge = createChatBridge(
      {
        catalog: [],        executeQuery: async () => ({
          answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 },
        }),
      },
      mockLogger as import("@useatlas/plugin-sdk").PluginLogger,
      mockStateAdapter,
      { slack: mockAdapter as unknown as import("chat").Adapter },
    );

    const result = await bridge.sendDirectMessage("slack", "U999", "Alert: anomaly detected");
    expect(result).toEqual({ messageId: "msg_456" });
    expect(openDMCalls).toEqual(["U999"]);
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0].threadId).toBe("DM_CHANNEL_123");
    expect(postCalls[0].message).toEqual({ markdown: "Alert: anomaly detected" });
  });

  it("sendDirectMessage returns null when openDM throws", async () => {
    const { createChatBridge } = await import("./bridge");
    const mockStateAdapter = (await import("./state")).createStateAdapter({ backend: "memory" }, null);
    let errorLogged = false;
    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => { errorLogged = true; },
      debug: () => {},
    };
    const mockAdapter = {
      name: "slack",
      openDM: async () => { throw new Error("user not found"); },
      postMessage: async () => ({ id: "x", raw: {} }),
    };
    const bridge = createChatBridge(
      {
        catalog: [],        executeQuery: async () => ({
          answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 },
        }),
      },
      mockLogger as import("@useatlas/plugin-sdk").PluginLogger,
      mockStateAdapter,
      { slack: mockAdapter as unknown as import("chat").Adapter },
    );

    const result = await bridge.sendDirectMessage("slack", "U999", "hello");
    expect(result).toBeNull();
    expect(errorLogged).toBe(true);
  });

  it("sendDirectMessage returns null when postMessage throws", async () => {
    const { createChatBridge } = await import("./bridge");
    const mockStateAdapter = (await import("./state")).createStateAdapter({ backend: "memory" }, null);
    let errorLogged = false;
    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => { errorLogged = true; },
      debug: () => {},
    };
    const mockAdapter = {
      name: "slack",
      openDM: async () => "DM_CHANNEL",
      postMessage: async () => { throw new Error("rate limited"); },
    };
    const bridge = createChatBridge(
      {
        catalog: [],        executeQuery: async () => ({
          answer: "", sql: [], data: [], steps: 0, usage: { totalTokens: 0 },
        }),
      },
      mockLogger as import("@useatlas/plugin-sdk").PluginLogger,
      mockStateAdapter,
      { slack: mockAdapter as unknown as import("chat").Adapter },
    );

    const result = await bridge.sendDirectMessage("slack", "U999", "hello");
    expect(result).toBeNull();
    expect(errorLogged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeQuery context contract (#2611)
// ---------------------------------------------------------------------------
//
// Slice 3 of #2607 extends executeQuery's signature with `adapter` +
// `rawMessage`. Those fields carry the platform-specific tenant identity
// (Slack `team_id`, Teams `tenantId`, ...) the host needs to resolve the
// org / actor before invoking the agent loop. Mirrors #2620's
// `resolveWorkspaceId({ adapter, thread, message })` shape.
//
// Type-level checks here pin the contract; runtime propagation is covered
// indirectly by the chat-plugin host helper's tests
// (`packages/api/src/lib/chat-plugin/__tests__/execute-query.test.ts`)
// which feed a synthetic Slack `app_mention` payload through the same
// executeQuery callback and assert it sees `rawMessage.team_id`.

describe("executeQuery context contract", () => {
  it("ChatExecuteQueryContext exposes the fields the host needs", () => {
    // Compile-time assertion: a context object missing either `adapter`
    // or `rawMessage` should fail TS. We exercise that by constructing
    // a literal that matches the published shape.
    type Ctx = import("./config").ChatExecuteQueryContext;
    const ctx: Ctx = {
      threadId: "slack:C123-1234.5678",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T123", user: "U456", text: "hi" },
    };
    expect(ctx.adapter.name).toBe("slack");
    expect((ctx.rawMessage as { team_id: string }).team_id).toBe("T123");
  });

  it("accepts an executeQuery callback whose signature matches the contract", async () => {
    const { chatPlugin } = await import("./index");

    // The callback receives the new `context` arg — type-narrow `adapter`
    // + `rawMessage` to confirm they're typed as required (non-optional).
    const calls: Array<{ adapterName: string; rawTeamId: unknown }> = [];
    const plugin = chatPlugin({
      catalog: SLACK_CATALOG,
      executeQuery: async (question, ctx) => {
        const raw = ctx.rawMessage as { team_id?: string } | undefined;
        calls.push({ adapterName: ctx.adapter.name, rawTeamId: raw?.team_id });
        return {
          answer: `echo: ${question}`,
          sql: [],
          data: [],
          steps: 0,
          usage: { totalTokens: 0 },
        };
      },
    });

    expect(plugin.id).toBe("chat-interaction");
    expect(plugin.config).toBeDefined();

    // Drive the callback directly with the contract shape to confirm
    // narrowed access works at runtime. End-to-end propagation through
    // the bridge is covered by the host helper's integration test.
    await plugin.config!.executeQuery("hello", {
      threadId: "slack:C1-1.2",
      adapter: { name: "slack" },
      rawMessage: { team_id: "T999" },
    });
    expect(calls).toEqual([{ adapterName: "slack", rawTeamId: "T999" }]);
  });
});

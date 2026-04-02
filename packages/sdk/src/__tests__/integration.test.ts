/**
 * SDK integration tests — exercises @useatlas/sdk against a mock server.
 *
 * A real HTTP server (Bun.serve on a random port) returns canned responses.
 * No external deps required — runs in CI without DB or API key.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createAtlasClient, AtlasError } from "../client";
import {
  startMockServer,
  VALID_API_KEY,
  MOCK_QUERY_RESPONSE,
  MOCK_CONVERSATIONS,
  MOCK_CONVERSATION_DETAIL,
  MOCK_ADMIN_OVERVIEW,
  MOCK_CONNECTION_HEALTH,
  MOCK_AUDIT_LOG,
  MOCK_AUDIT_STATS,
  MOCK_SCHEDULED_TASK,
  MOCK_SCHEDULED_TASKS,
  MOCK_SCHEDULED_TASK_RUNS,
  MOCK_TABLES_RESPONSE,
  MOCK_VALIDATE_SQL_VALID,
  type MockServer,
} from "./mock-server";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: MockServer;
let baseUrl: string;

beforeAll(() => {
  server = startMockServer();
  baseUrl = server.url;
});

afterAll(() => {
  server?.stop();
});

/** Create a client with the valid test API key. */
function client() {
  return createAtlasClient({ baseUrl, apiKey: VALID_API_KEY });
}

/** Create a client with an invalid key. */
function badClient() {
  return createAtlasClient({ baseUrl, apiKey: "wrong-key" });
}

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

describe("query()", () => {
  test("returns structured response with answer, sql, data, steps, usage", async () => {
    const result = await client().query("How many users signed up last week?");

    expect(result.answer).toBe(MOCK_QUERY_RESPONSE.answer);
    expect(result.sql).toEqual(MOCK_QUERY_RESPONSE.sql);
    expect(result.data).toEqual(MOCK_QUERY_RESPONSE.data);
    expect(result.steps).toBe(MOCK_QUERY_RESPONSE.steps);
    expect(result.usage.totalTokens).toBe(MOCK_QUERY_RESPONSE.usage.totalTokens);
    expect(result.conversationId).toBe(MOCK_QUERY_RESPONSE.conversationId);
  });

  test("401 unauthorized → AtlasError", async () => {
    try {
      await badClient().query("test");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("auth_error");
      expect(e.status).toBe(401);
      expect(e.message).toBe("Unauthorized");
    }
  });

  test("429 rate limited → AtlasError with retryAfterSeconds", async () => {
    try {
      await client().query("__trigger_rate_limit__");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("rate_limited");
      expect(e.status).toBe(429);
      expect(e.retryAfterSeconds).toBe(60);
    }
  });
});

// ---------------------------------------------------------------------------
// chat()
// ---------------------------------------------------------------------------

describe("chat()", () => {
  test("sends messages and consumes SSE stream", async () => {
    const messages = [
      { id: "1", role: "user" as const, parts: [{ type: "text", text: "Hello" }] },
    ];
    const res = await client().chat(messages);

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // Consume the stream and verify chunks arrive
    const body = await res.text();
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain('"type":"finish"');
    expect(body).toContain("[DONE]");
  });

  test("401 on chat → AtlasError", async () => {
    const messages = [
      { id: "1", role: "user" as const, parts: [{ type: "text", text: "hi" }] },
    ];
    try {
      await badClient().chat(messages);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("auth_error");
      expect(e.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

describe("conversations", () => {
  test("list() returns paginated list", async () => {
    const result = await client().conversations.list();

    expect(result.total).toBe(MOCK_CONVERSATIONS.total);
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0].id).toBe("conv-1");
    expect(result.conversations[1].id).toBe("conv-2");
  });

  test("list() respects limit param", async () => {
    const result = await client().conversations.list({ limit: 1 });

    expect(result.conversations).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  test("list() respects offset param", async () => {
    const result = await client().conversations.list({ offset: 1 });

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].id).toBe("conv-2");
  });

  test("get(id) returns conversation with messages", async () => {
    const result = await client().conversations.get("conv-1");

    expect(result.id).toBe(MOCK_CONVERSATION_DETAIL.id);
    expect(result.title).toBe(MOCK_CONVERSATION_DETAIL.title);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
  });

  test("get(id) with unknown id → 404 AtlasError", async () => {
    try {
      await client().conversations.get("nonexistent");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      expect((err as AtlasError).status).toBe(404);
    }
  });

  test("delete(id) returns success", async () => {
    const result = await client().conversations.delete("conv-1");
    expect(result).toBe(true);
  });

  test("delete(id) with unknown id → 404 AtlasError", async () => {
    try {
      await client().conversations.delete("nonexistent");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      expect((err as AtlasError).status).toBe(404);
    }
  });

  test("star(id) succeeds", async () => {
    // star() returns void — no error means success
    await client().conversations.star("conv-1");
  });

  test("unstar(id) succeeds", async () => {
    await client().conversations.unstar("conv-1");
  });
});

// ---------------------------------------------------------------------------
// scheduledTasks
// ---------------------------------------------------------------------------

describe("scheduledTasks", () => {
  test("list() returns paginated list", async () => {
    const result = await client().scheduledTasks.list();

    expect(result.total).toBe(MOCK_SCHEDULED_TASKS.total);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe("task-1");
  });

  test("get(id) returns task with recent runs", async () => {
    const result = await client().scheduledTasks.get("task-1");

    expect(result.id).toBe(MOCK_SCHEDULED_TASK.id);
    expect(result.name).toBe(MOCK_SCHEDULED_TASK.name);
    expect(result.recentRuns).toHaveLength(1);
    expect(result.recentRuns[0].status).toBe("success");
  });

  test("get(id) with unknown id → 404 AtlasError", async () => {
    try {
      await client().scheduledTasks.get("nonexistent");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      expect((err as AtlasError).status).toBe(404);
    }
  });

  test("create() returns new task", async () => {
    const result = await client().scheduledTasks.create({
      name: "Daily digest",
      question: "Show errors from today",
      cronExpression: "0 8 * * *",
    });

    expect(result.name).toBe("Daily digest");
    expect(result.question).toBe("Show errors from today");
    expect(result.cronExpression).toBe("0 8 * * *");
  });

  test("update() returns modified task", async () => {
    const result = await client().scheduledTasks.update("task-1", {
      name: "Updated report",
      enabled: false,
    });

    expect(result.name).toBe("Updated report");
    expect(result.enabled).toBe(false);
  });

  test("delete(id) returns success", async () => {
    const result = await client().scheduledTasks.delete("task-1");
    expect(result).toBe(true);
  });

  test("trigger(id) succeeds", async () => {
    await client().scheduledTasks.trigger("task-1");
  });

  test("listRuns(id) returns runs", async () => {
    const result = await client().scheduledTasks.listRuns("task-1");

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].id).toBe(MOCK_SCHEDULED_TASK_RUNS.runs[0].id);
    expect(result.runs[0].status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

describe("admin", () => {
  test("overview() returns health + stats", async () => {
    const result = await client().admin.overview();

    expect(result.connections).toBe(MOCK_ADMIN_OVERVIEW.connections);
    expect(result.entities).toBe(MOCK_ADMIN_OVERVIEW.entities);
    expect(result.metrics).toBe(MOCK_ADMIN_OVERVIEW.metrics);
    expect(result.glossaryTerms).toBe(MOCK_ADMIN_OVERVIEW.glossaryTerms);
    expect(result.plugins).toBe(MOCK_ADMIN_OVERVIEW.plugins);
    expect(result.pluginHealth).toHaveLength(1);
    expect(result.pluginHealth[0].status).toBe("healthy");
  });

  test("connections() returns list", async () => {
    const result = await client().admin.connections();
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].id).toBe("default");
  });

  test("testConnection(id) returns health check", async () => {
    const result = await client().admin.testConnection("default");
    expect(result.status).toBe(MOCK_CONNECTION_HEALTH.status);
    expect(result.latencyMs).toBe(MOCK_CONNECTION_HEALTH.latencyMs);
  });

  test("audit() returns log entries", async () => {
    const result = await client().admin.audit();
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(MOCK_AUDIT_LOG.total);
    expect(result.rows[0].sql).toBe("SELECT count(*) FROM users");
  });

  test("auditStats() returns aggregate stats", async () => {
    const result = await client().admin.auditStats();
    expect(result.totalQueries).toBe(MOCK_AUDIT_STATS.totalQueries);
    expect(result.errorRate).toBe(MOCK_AUDIT_STATS.errorRate);
  });

  test("plugins() returns list", async () => {
    const result = await client().admin.plugins();
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].id).toBe("datasource-pg");
  });

  test("pluginHealth(id) returns health", async () => {
    const result = await client().admin.pluginHealth("datasource-pg");
    expect(result.healthy).toBe(true);
  });

  test("semantic.entities() returns list", async () => {
    const result = await client().admin.semantic.entities();
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].table).toBe("users");
  });

  test("semantic.entity(name) returns detail", async () => {
    const result = await client().admin.semantic.entity("users");
    expect(result.entity).toBeTruthy();
  });

  test("semantic.metrics() returns list", async () => {
    const result = await client().admin.semantic.metrics();
    expect(result.metrics).toHaveLength(1);
  });

  test("semantic.glossary() returns terms", async () => {
    const result = await client().admin.semantic.glossary();
    expect(result.glossary).toHaveLength(1);
  });

  test("semantic.catalog() returns catalog", async () => {
    const result = await client().admin.semantic.catalog();
    expect(result.catalog).toBeTruthy();
  });

  test("semantic.stats() returns aggregate stats", async () => {
    const result = await client().admin.semantic.stats();
    expect(result.totalEntities).toBe(15);
    expect(result.coverageGaps.noDescription).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Auth modes
// ---------------------------------------------------------------------------

describe("auth modes", () => {
  test("apiKey sends Authorization: Bearer <key>", async () => {
    const result = await client().query("test");
    expect(result.answer).toBe(MOCK_QUERY_RESPONSE.answer);
  });

  test("bearerToken sends same Authorization header format", async () => {
    const c = createAtlasClient({ baseUrl, bearerToken: VALID_API_KEY });
    const result = await c.query("test");
    expect(result.answer).toBe(MOCK_QUERY_RESPONSE.answer);
  });

  test("invalid credentials rejected across all endpoints", async () => {
    const bad = badClient();

    const endpoints = [
      () => bad.query("test"),
      () => bad.chat([{ id: "1", role: "user" as const, parts: [{ type: "text", text: "hi" }] }]),
      () => bad.conversations.list(),
      () => bad.conversations.get("conv-1"),
      () => bad.conversations.delete("conv-1"),
      () => bad.conversations.star("conv-1"),
      () => bad.conversations.unstar("conv-1"),
      () => bad.scheduledTasks.list(),
      () => bad.scheduledTasks.get("task-1"),
      () => bad.scheduledTasks.delete("task-1"),
      () => bad.admin.overview(),
      () => bad.admin.connections(),
      () => bad.admin.audit(),
      () => bad.admin.plugins(),
      () => bad.listTables(),
      () => bad.validateSQL("SELECT 1"),
    ];

    for (const fn of endpoints) {
      try {
        await fn();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlasError);
        expect((err as AtlasError).code).toBe("auth_error");
        expect((err as AtlasError).status).toBe(401);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("500 → AtlasError with status and message", async () => {
    try {
      await client().query("__trigger_500__");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("internal_error");
      expect(e.status).toBe(500);
      expect(e.message).toBe("Something went wrong");
    }
  });

  test("network error → AtlasError with code network_error", async () => {
    const c = createAtlasClient({ baseUrl: "http://localhost:1", apiKey: VALID_API_KEY });
    try {
      await c.query("test");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("network_error");
      expect(e.status).toBe(0);
    }
  });

  test("invalid JSON response → AtlasError with code invalid_response", async () => {
    try {
      await client().query("__trigger_bad_json__");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("invalid_response");
      expect(e.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// listTables()
// ---------------------------------------------------------------------------

describe("listTables()", () => {
  test("returns tables with columns", async () => {
    const result = await client().listTables();

    expect(result.tables).toHaveLength(2);
    expect(result.tables[0].table).toBe(MOCK_TABLES_RESPONSE.tables[0].table);
    expect(result.tables[0].columns).toHaveLength(2);
    expect(result.tables[1].table).toBe("orders");
    expect(result.tables[1].columns).toHaveLength(3);
  });

  test("401 unauthorized → AtlasError", async () => {
    try {
      await badClient().listTables();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      expect((err as AtlasError).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// validateSQL()
// ---------------------------------------------------------------------------

describe("validateSQL()", () => {
  test("valid SELECT returns valid: true with tables", async () => {
    const result = await client().validateSQL("SELECT count(*) FROM users");

    expect(result.valid).toBe(true);
    expect(result.tables).toEqual(MOCK_VALIDATE_SQL_VALID.tables);
    expect(result.errors).toHaveLength(0);
  });

  test("mutation query returns valid: false with errors", async () => {
    const result = await client().validateSQL("DROP TABLE users");

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].layer).toBe("regex_guard");
  });

  test("empty query returns validation error", async () => {
    const result = await client().validateSQL("");

    expect(result.valid).toBe(false);
    expect(result.errors[0].layer).toBe("empty_check");
  });

  test("passes connectionId when provided", async () => {
    const result = await client().validateSQL("SELECT 1 FROM users", "warehouse");

    expect(result.valid).toBe(true);
  });

  test("401 unauthorized → AtlasError", async () => {
    try {
      await badClient().validateSQL("SELECT 1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      expect((err as AtlasError).status).toBe(401);
    }
  });
});

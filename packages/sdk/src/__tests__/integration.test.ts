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
  server.stop();
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
    expect(result.total).toBe(2); // total is unaffected by limit
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
      const e = err as AtlasError;
      expect(e.status).toBe(404);
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
      const e = err as AtlasError;
      expect(e.status).toBe(404);
    }
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
});

// ---------------------------------------------------------------------------
// Auth modes
// ---------------------------------------------------------------------------

describe("auth modes", () => {
  test("apiKey sends Authorization: Bearer <key>", async () => {
    // If auth works, the query succeeds — mock server validates the header
    const result = await client().query("test");
    expect(result.answer).toBe(MOCK_QUERY_RESPONSE.answer);
  });

  test("bearerToken sends same Authorization header format", async () => {
    // Create a client with bearerToken set to the valid key
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
      () => bad.admin.overview(),
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
    // Point to a port that's not listening
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

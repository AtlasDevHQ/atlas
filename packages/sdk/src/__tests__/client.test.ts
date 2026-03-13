import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createAtlasClient, AtlasError } from "../client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Capture the last fetch call's Request details. */
let lastRequest: Request | null = null;

function installFetchMock(response: Response) {
  lastRequest = null;
  const mockFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
    lastRequest = new Request(input as string, init);
    return response.clone();
  });
  globalThis.fetch = Object.assign(mockFn, {
    preconnect: () => {},
  }) as unknown as typeof fetch;
}

function installFetchError(error: Error) {
  lastRequest = null;
  const mockFn = mock(async () => {
    throw error;
  });
  globalThis.fetch = Object.assign(mockFn, {
    preconnect: () => {},
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("createAtlasClient", () => {
  test("throws if neither apiKey nor bearerToken is provided", () => {
    // @ts-expect-error — intentionally testing runtime guard for plain JS callers
    expect(() => createAtlasClient({ baseUrl: "http://localhost:3001" })).toThrow(
      "requires either apiKey or bearerToken",
    );
  });

  test("does not throw with apiKey", () => {
    expect(() =>
      createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "key" }),
    ).not.toThrow();
  });

  test("does not throw with bearerToken", () => {
    expect(() =>
      createAtlasClient({ baseUrl: "http://localhost:3001", bearerToken: "tok" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Auth header injection
// ---------------------------------------------------------------------------

describe("auth headers", () => {
  test("injects apiKey as Bearer token", async () => {
    installFetchMock(
      jsonResponse({ answer: "ok", sql: [], data: [], steps: 1, usage: { totalTokens: 0 } }),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "test-key" });
    await client.query("test");
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.headers.get("Authorization")).toBe("Bearer test-key");
  });

  test("injects bearerToken as Bearer token", async () => {
    installFetchMock(
      jsonResponse({ answer: "ok", sql: [], data: [], steps: 1, usage: { totalTokens: 0 } }),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", bearerToken: "jwt-tok" });
    await client.query("test");
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.headers.get("Authorization")).toBe("Bearer jwt-tok");
  });

  test("prefers apiKey when both are provided", async () => {
    installFetchMock(
      jsonResponse({ answer: "ok", sql: [], data: [], steps: 1, usage: { totalTokens: 0 } }),
    );
    const client = createAtlasClient({
      baseUrl: "http://localhost:3001",
      apiKey: "the-key",
      bearerToken: "the-token",
    });
    await client.query("test");
    expect(lastRequest!.headers.get("Authorization")).toBe("Bearer the-key");
  });
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe("URL construction", () => {
  test("strips trailing slash from baseUrl", async () => {
    installFetchMock(
      jsonResponse({ answer: "ok", sql: [], data: [], steps: 1, usage: { totalTokens: 0 } }),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001/", apiKey: "k" });
    await client.query("test");
    expect(new URL(lastRequest!.url).pathname).toBe("/api/v1/query");
    expect(lastRequest!.url).not.toContain("//api");
  });

  test("conversations.list() with no args has no query string", async () => {
    installFetchMock(jsonResponse({ conversations: [], total: 0 }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    await client.conversations.list();
    expect(lastRequest!.url).toBe("http://localhost:3001/api/v1/conversations");
  });

  test("conversations.list({ limit: 5 }) — only limit, no offset", async () => {
    installFetchMock(jsonResponse({ conversations: [], total: 0 }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    await client.conversations.list({ limit: 5 });
    const url = new URL(lastRequest!.url);
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.has("offset")).toBe(false);
  });

  test("conversations.list({ limit: 0, offset: 0 }) — falsy values pass through", async () => {
    installFetchMock(jsonResponse({ conversations: [], total: 0 }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    await client.conversations.list({ limit: 0, offset: 0 });
    const url = new URL(lastRequest!.url);
    expect(url.searchParams.get("limit")).toBe("0");
    expect(url.searchParams.get("offset")).toBe("0");
  });

  test("encodeURIComponent for IDs with special characters", async () => {
    installFetchMock(
      jsonResponse({
        id: "a/b",
        userId: null,
        title: null,
        surface: "api",
        connectionId: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        messages: [],
      }),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    await client.conversations.get("a/b");
    expect(new URL(lastRequest!.url).pathname).toBe("/api/v1/conversations/a%2Fb");
  });
});

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

describe("query", () => {
  const queryResponse = {
    answer: "42 users signed up",
    sql: ["SELECT count(*) FROM users"],
    data: [{ columns: ["count"], rows: [{ count: 42 }] }],
    steps: 3,
    usage: { totalTokens: 1500 },
  };

  beforeEach(() => {
    installFetchMock(jsonResponse(queryResponse));
  });

  test("calls POST /api/v1/query with question", async () => {
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    await client.query("How many users?");

    expect(lastRequest!.method).toBe("POST");
    expect(new URL(lastRequest!.url).pathname).toBe("/api/v1/query");

    const body = (await lastRequest!.json()) as Record<string, unknown>;
    expect(body.question).toBe("How many users?");
  });

  test("returns typed response", async () => {
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    const result = await client.query("test");

    expect(result.answer).toBe("42 users signed up");
    expect(result.sql).toEqual(["SELECT count(*) FROM users"]);
    expect(result.steps).toBe(3);
    expect(result.usage.totalTokens).toBe(1500);
  });

  test("passes conversationId option", async () => {
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    await client.query("test", { conversationId: "abc-123" });

    const body = (await lastRequest!.json()) as Record<string, unknown>;
    expect(body.conversationId).toBe("abc-123");
  });
});

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

describe("conversations.list", () => {
  const listResponse = {
    conversations: [
      {
        id: "c1",
        userId: "u1",
        title: "Test",
        surface: "api",
        connectionId: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ],
    total: 1,
  };

  test("calls GET /api/v1/conversations", async () => {
    installFetchMock(jsonResponse(listResponse));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    const result = await client.conversations.list();

    expect(lastRequest!.method).toBe("GET");
    expect(new URL(lastRequest!.url).pathname).toBe("/api/v1/conversations");
    expect(result.total).toBe(1);
    expect(result.conversations).toHaveLength(1);
  });

  test("passes limit and offset as query params", async () => {
    installFetchMock(jsonResponse(listResponse));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    await client.conversations.list({ limit: 10, offset: 20 });

    const url = new URL(lastRequest!.url);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("20");
  });
});

describe("conversations.get", () => {
  const conversation = {
    id: "c1",
    userId: "u1",
    title: "Test",
    surface: "api" as const,
    connectionId: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    messages: [
      {
        id: "m1",
        conversationId: "c1",
        role: "user",
        content: "hello",
        createdAt: "2025-01-01T00:00:00Z",
      },
    ],
  };

  test("calls GET /api/v1/conversations/:id", async () => {
    installFetchMock(jsonResponse(conversation));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    const result = await client.conversations.get("c1");

    expect(lastRequest!.method).toBe("GET");
    expect(new URL(lastRequest!.url).pathname).toBe("/api/v1/conversations/c1");
    expect(result.id).toBe("c1");
    expect(result.messages).toHaveLength(1);
  });
});

describe("conversations.delete", () => {
  test("calls DELETE /api/v1/conversations/:id", async () => {
    installFetchMock(new Response(null, { status: 204 }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });
    const result = await client.conversations.delete("c1");

    expect(lastRequest!.method).toBe("DELETE");
    expect(new URL(lastRequest!.url).pathname).toBe("/api/v1/conversations/c1");
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chat()
// ---------------------------------------------------------------------------

describe("chat", () => {
  test("calls POST /api/chat and returns Response", async () => {
    installFetchMock(new Response("streaming data", { status: 200 }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    const messages = [{ id: "1", role: "user" as const, parts: [{ type: "text", text: "hi" }] }];
    const res = await client.chat(messages);

    expect(lastRequest!.method).toBe("POST");
    expect(new URL(lastRequest!.url).pathname).toBe("/api/chat");
    expect(res).toBeInstanceOf(Response);

    const body = (await lastRequest!.json()) as Record<string, unknown>;
    expect(body.messages).toHaveLength(1);
  });

  test("passes conversationId option", async () => {
    installFetchMock(new Response("ok", { status: 200 }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    await client.chat(
      [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      { conversationId: "conv-1" },
    );

    const body = (await lastRequest!.json()) as Record<string, unknown>;
    expect(body.conversationId).toBe("conv-1");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("throws AtlasError on 401", async () => {
    installFetchMock(jsonResponse({ error: "auth_error", message: "Unauthorized" }, 401));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "bad" });

    try {
      await client.query("test");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("auth_error");
      expect(e.message).toBe("Unauthorized");
      expect(e.status).toBe(401);
    }
  });

  test("throws AtlasError on 500 with JSON body", async () => {
    installFetchMock(
      jsonResponse({ error: "internal_error", message: "Something broke" }, 500),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("internal_error");
      expect(e.status).toBe(500);
    }
  });

  test("throws AtlasError on non-JSON error body", async () => {
    installFetchMock(new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("unknown_error");
      expect(e.status).toBe(502);
    }
  });

  test("throws AtlasError on 429 rate limit", async () => {
    installFetchMock(
      jsonResponse({ error: "rate_limited", message: "Too many requests" }, 429),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("rate_limited");
      expect(e.status).toBe(429);
    }
  });

  test("chat throws AtlasError on error response", async () => {
    installFetchMock(jsonResponse({ error: "auth_error", message: "Forbidden" }, 403));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.chat([{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("auth_error");
      expect(e.status).toBe(403);
    }
  });

  test("conversations.delete throws AtlasError on 404", async () => {
    installFetchMock(jsonResponse({ error: "not_found", message: "Not found" }, 404));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.conversations.delete("nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      // "not_found" is a server code outside the SDK's known union — cast is intentional
      expect(e.code as string).toBe("not_found");
      expect(e.status).toBe(404);
    }
  });

  test("conversations.get throws AtlasError on 404", async () => {
    installFetchMock(jsonResponse({ error: "not_found", message: "Not found" }, 404));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.conversations.get("nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code as string).toBe("not_found");
      expect(e.status).toBe(404);
    }
  });

  test("chat throws AtlasError on non-JSON error body", async () => {
    installFetchMock(new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.chat([{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("unknown_error");
      expect(e.status).toBe(503);
    }
  });

  test("network failure throws AtlasError with code network_error and retryable true", async () => {
    installFetchError(new TypeError("fetch failed"));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("network_error");
      expect(e.message).toBe("fetch failed");
      expect(e.status).toBe(0);
      expect(e.retryable).toBe(true);
    }
  });

  test("200 with non-JSON body throws AtlasError with code invalid_response and retryable false", async () => {
    installFetchMock(new Response("not json", { status: 200 }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("invalid_response");
      expect(e.status).toBe(200);
      expect(e.message).toContain("unparseable body");
      expect(e.retryable).toBe(false);
    }
  });

  test("429 response includes retryAfterSeconds on AtlasError", async () => {
    installFetchMock(
      jsonResponse({ error: "rate_limited", message: "Slow down", retryAfterSeconds: 30, retryable: true }, 429),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("rate_limited");
      expect(e.retryAfterSeconds).toBe(30);
      expect(e.retryable).toBe(true);
    }
  });

  test("retryable is true for transient errors", async () => {
    installFetchMock(
      jsonResponse({ error: "provider_timeout", message: "Timed out", retryable: true }, 504),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.retryable).toBe(true);
    }
  });

  test("retryable is false for permanent errors", async () => {
    installFetchMock(
      jsonResponse({ error: "auth_error", message: "Unauthorized", retryable: false }, 401),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.retryable).toBe(false);
    }
  });

  test("retryable computed from code when server omits the field", async () => {
    installFetchMock(
      jsonResponse({ error: "internal_error", message: "fail" }, 500),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      // internal_error is transient — SDK computes retryable from code
      expect(e.retryable).toBe(true);
    }
  });

  test("retryable computed as false for permanent code when server omits the field", async () => {
    installFetchMock(
      jsonResponse({ error: "configuration_error", message: "bad config" }, 400),
    );
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.retryable).toBe(false);
    }
  });

  test("502 with HTML body includes truncated body text in error message", async () => {
    const htmlBody = "<html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>";
    installFetchMock(new Response(htmlBody, { status: 502, statusText: "Bad Gateway" }));
    const client = createAtlasClient({ baseUrl: "http://localhost:3001", apiKey: "k" });

    try {
      await client.query("test");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(AtlasError);
      const e = err as AtlasError;
      expect(e.code).toBe("unknown_error");
      expect(e.status).toBe(502);
      expect(e.message).toContain("Bad Gateway");
      expect(e.message).toContain("<html>");
    }
  });
});

// ---------------------------------------------------------------------------
// AtlasError constructor — direct tests
// ---------------------------------------------------------------------------

describe("AtlasError constructor", () => {
  test("3-arg form defaults retryable from code (transient)", () => {
    const e = new AtlasError("internal_error", "fail", 500);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterSeconds).toBeUndefined();
  });

  test("3-arg form defaults retryable from code (permanent)", () => {
    const e = new AtlasError("auth_error", "unauthorized", 401);
    expect(e.retryable).toBe(false);
    expect(e.retryAfterSeconds).toBeUndefined();
  });

  test("backward compat: positional number 4th arg sets retryAfterSeconds", () => {
    const e = new AtlasError("rate_limited", "slow down", 429, 30);
    expect(e.retryAfterSeconds).toBe(30);
    expect(e.retryable).toBe(true);
  });

  test("opts object sets both retryAfterSeconds and retryable", () => {
    const e = new AtlasError("rate_limited", "slow down", 429, { retryAfterSeconds: 15, retryable: true });
    expect(e.retryAfterSeconds).toBe(15);
    expect(e.retryable).toBe(true);
  });

  test("server retryable: false overrides code-based classification", () => {
    const e = new AtlasError("internal_error", "fail", 500, { retryable: false });
    expect(e.retryable).toBe(false);
  });

  test("network_error is retryable by default", () => {
    const e = new AtlasError("network_error", "fetch failed", 0);
    expect(e.retryable).toBe(true);
  });

  test("unknown_error is not retryable by default", () => {
    const e = new AtlasError("unknown_error", "???", 0);
    expect(e.retryable).toBe(false);
  });
});

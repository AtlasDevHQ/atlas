/**
 * Lightweight mock Atlas API server for SDK integration tests.
 *
 * Uses Bun.serve directly — no external dependencies.
 * Returns canned responses for each endpoint the SDK exercises.
 */

// ---------------------------------------------------------------------------
// Canned response data
// ---------------------------------------------------------------------------

export const MOCK_QUERY_RESPONSE = {
  answer: "42 users signed up last week",
  sql: ["SELECT count(*) FROM users WHERE created_at > now() - interval '7 days'"],
  data: [{ columns: ["count"], rows: [{ count: 42 }] }],
  steps: 3,
  usage: { totalTokens: 1500 },
  conversationId: "conv-123",
};

export const MOCK_CONVERSATIONS = {
  conversations: [
    {
      id: "conv-1",
      userId: "user-1",
      title: "First conversation",
      surface: "api" as const,
      connectionId: null,
      starred: false,
      createdAt: "2025-06-01T00:00:00Z",
      updatedAt: "2025-06-01T01:00:00Z",
    },
    {
      id: "conv-2",
      userId: "user-1",
      title: "Second conversation",
      surface: "web" as const,
      connectionId: "default",
      starred: true,
      createdAt: "2025-06-02T00:00:00Z",
      updatedAt: "2025-06-02T02:00:00Z",
    },
  ],
  total: 2,
};

export const MOCK_CONVERSATION_DETAIL = {
  id: "conv-1",
  userId: "user-1",
  title: "First conversation",
  surface: "api" as const,
  connectionId: null,
  starred: false,
  createdAt: "2025-06-01T00:00:00Z",
  updatedAt: "2025-06-01T01:00:00Z",
  messages: [
    {
      id: "msg-1",
      conversationId: "conv-1",
      role: "user" as const,
      content: "How many users?",
      createdAt: "2025-06-01T00:00:00Z",
    },
    {
      id: "msg-2",
      conversationId: "conv-1",
      role: "assistant" as const,
      content: "There are 42 users.",
      createdAt: "2025-06-01T00:00:01Z",
    },
  ],
};

export const MOCK_ADMIN_OVERVIEW = {
  connections: 2,
  entities: 15,
  metrics: 8,
  glossaryTerms: 5,
  plugins: 1,
  pluginHealth: [
    {
      id: "datasource-pg",
      type: "datasource" as const,
      version: "1.0.0",
      name: "PostgreSQL",
      status: "healthy" as const,
    },
  ],
};

const VALID_API_KEY = "test-api-key-123";

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const events = [
        'data: {"type":"text-delta","textDelta":"Hello"}\n\n',
        'data: {"type":"text-delta","textDelta":" world"}\n\n',
        'data: {"type":"finish","finishReason":"stop","usage":{"promptTokens":10,"completionTokens":5}}\n\n',
        "data: [DONE]\n\n",
      ];
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function checkAuth(req: Request): Response | null {
  const auth = req.headers.get("Authorization");
  if (!auth || auth !== `Bearer ${VALID_API_KEY}`) {
    return json({ error: "auth_error", message: "Unauthorized" }, 401);
  }
  return null;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  // ---- POST /api/v1/query ----
  if (method === "POST" && pathname === "/api/v1/query") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;

    const body = (await req.json()) as Record<string, unknown>;

    // Simulate rate limit for a magic question
    if (body.question === "__trigger_rate_limit__") {
      return json(
        { error: "rate_limited", message: "Too many requests", retryAfterSeconds: 60 },
        429,
      );
    }

    // Simulate server error for a magic question
    if (body.question === "__trigger_500__") {
      return json({ error: "internal_error", message: "Something went wrong" }, 500);
    }

    // Simulate invalid JSON
    if (body.question === "__trigger_bad_json__") {
      return new Response("this is not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return json(MOCK_QUERY_RESPONSE);
  }

  // ---- POST /api/chat ----
  if (method === "POST" && pathname === "/api/chat") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;

    return new Response(sseStream(), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // ---- GET /api/v1/conversations ----
  if (method === "GET" && pathname === "/api/v1/conversations") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;

    // Respect limit/offset query params
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const all = MOCK_CONVERSATIONS.conversations;
    const sliced = all.slice(offset, offset + limit);

    return json({ conversations: sliced, total: all.length });
  }

  // ---- GET /api/v1/conversations/:id ----
  if (method === "GET" && pathname.startsWith("/api/v1/conversations/")) {
    const authErr = checkAuth(req);
    if (authErr) return authErr;

    const id = decodeURIComponent(pathname.split("/api/v1/conversations/")[1]);
    if (id === MOCK_CONVERSATION_DETAIL.id) {
      return json(MOCK_CONVERSATION_DETAIL);
    }
    return json({ error: "not_found", message: "Conversation not found" }, 404);
  }

  // ---- DELETE /api/v1/conversations/:id ----
  if (method === "DELETE" && pathname.startsWith("/api/v1/conversations/")) {
    const authErr = checkAuth(req);
    if (authErr) return authErr;

    const id = decodeURIComponent(pathname.split("/api/v1/conversations/")[1]);
    if (id === "conv-1") {
      return new Response(null, { status: 204 });
    }
    return json({ error: "not_found", message: "Conversation not found" }, 404);
  }

  // ---- GET /api/v1/admin/overview ----
  if (method === "GET" && pathname === "/api/v1/admin/overview") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json(MOCK_ADMIN_OVERVIEW);
  }

  return json({ error: "not_found", message: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface MockServer {
  url: string;
  port: number;
  stop: () => void;
}

/** Start a mock Atlas API server on a random available port. */
export function startMockServer(): MockServer {
  const server = Bun.serve({
    port: 0, // random available port
    fetch: handleRequest,
  });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    stop: () => server.stop(true),
  };
}

export { VALID_API_KEY };

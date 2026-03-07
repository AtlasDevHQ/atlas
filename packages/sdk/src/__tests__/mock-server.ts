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

export const MOCK_ADMIN_CONNECTIONS = {
  connections: [
    { id: "default", dbType: "postgres" as const, description: "Primary database" },
  ],
};

export const MOCK_CONNECTION_HEALTH = {
  status: "healthy" as const,
  latencyMs: 12,
  checkedAt: "2025-06-01T00:00:00Z",
};

export const MOCK_AUDIT_LOG = {
  rows: [
    {
      id: "audit-1",
      timestamp: "2025-06-01T00:00:00Z",
      userId: "user-1",
      userLabel: "alice",
      authMode: "managed" as const,
      sql: "SELECT count(*) FROM users",
      durationMs: 42,
      rowCount: 1,
      success: true,
      error: null,
      sourceId: null,
      sourceType: null,
      targetHost: null,
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

export const MOCK_AUDIT_STATS = {
  totalQueries: 100,
  totalErrors: 2,
  errorRate: 0.02,
  queriesPerDay: [{ day: "2025-06-01", count: 50 }],
};

export const MOCK_PLUGINS = {
  plugins: [
    {
      id: "datasource-pg",
      type: "datasource" as const,
      version: "1.0.0",
      name: "PostgreSQL",
      status: "healthy" as const,
    },
  ],
};

export const MOCK_SEMANTIC_ENTITIES = {
  entities: [
    {
      table: "users",
      description: "User accounts",
      columnCount: 5,
      joinCount: 1,
      measureCount: 2,
      connection: null,
      type: null,
      source: "default",
    },
  ],
};

export const MOCK_SCHEDULED_TASK = {
  id: "task-1",
  ownerId: "user-1",
  name: "Weekly report",
  question: "How many users signed up this week?",
  cronExpression: "0 9 * * 1",
  deliveryChannel: "email" as const,
  recipients: [{ type: "email" as const, address: "alice@example.com" }],
  connectionId: null,
  approvalMode: "auto" as const,
  enabled: true,
  lastRunAt: null,
  nextRunAt: "2025-06-09T09:00:00Z",
  createdAt: "2025-06-01T00:00:00Z",
  updatedAt: "2025-06-01T00:00:00Z",
};

export const MOCK_SCHEDULED_TASKS = {
  tasks: [MOCK_SCHEDULED_TASK],
  total: 1,
};

export const MOCK_SCHEDULED_TASK_RUNS = {
  runs: [
    {
      id: "run-1",
      taskId: "task-1",
      startedAt: "2025-06-02T09:00:00Z",
      completedAt: "2025-06-02T09:00:05Z",
      status: "success" as const,
      conversationId: "conv-run-1",
      actionId: null,
      error: null,
      tokensUsed: 800,
      createdAt: "2025-06-02T09:00:00Z",
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
// Route helpers
// ---------------------------------------------------------------------------

/** Match a parameterized route like /api/v1/conversations/:id (single segment only). */
function matchRoute(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  // Only match a single path segment (no sub-paths)
  if (!rest || rest.includes("/")) return null;
  return decodeURIComponent(rest);
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

async function parseJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_request", message: "Invalid JSON body" }, 400);
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  // ---- POST /api/v1/query ----
  if (method === "POST" && pathname === "/api/v1/query") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;

    const bodyOrErr = await parseJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    const body = bodyOrErr;

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

    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const all = MOCK_CONVERSATIONS.conversations;
    const sliced = all.slice(offset, offset + limit);

    return json({ conversations: sliced, total: all.length });
  }

  // ---- PATCH /api/v1/conversations/:id/star ----
  if (method === "PATCH" && pathname.endsWith("/star")) {
    const starMatch = pathname.match(/^\/api\/v1\/conversations\/([^/]+)\/star$/);
    if (starMatch) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      const id = decodeURIComponent(starMatch[1]);
      if (id !== "conv-1" && id !== "conv-2") {
        return json({ error: "not_found", message: "Conversation not found" }, 404);
      }
      return json({ ok: true });
    }
  }

  // ---- GET /api/v1/conversations/:id ----
  if (method === "GET") {
    const convId = matchRoute(pathname, "/api/v1/conversations/");
    if (convId) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      if (convId === MOCK_CONVERSATION_DETAIL.id) {
        return json(MOCK_CONVERSATION_DETAIL);
      }
      return json({ error: "not_found", message: "Conversation not found" }, 404);
    }
  }

  // ---- DELETE /api/v1/conversations/:id ----
  if (method === "DELETE") {
    const convId = matchRoute(pathname, "/api/v1/conversations/");
    if (convId) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      if (convId === "conv-1") {
        return new Response(null, { status: 204 });
      }
      return json({ error: "not_found", message: "Conversation not found" }, 404);
    }
  }

  // ---- Scheduled tasks ----

  // POST /api/v1/scheduled-tasks (create)
  if (method === "POST" && pathname === "/api/v1/scheduled-tasks") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    const bodyOrErr = await parseJsonBody(req);
    if (bodyOrErr instanceof Response) return bodyOrErr;
    return json({ ...MOCK_SCHEDULED_TASK, ...bodyOrErr });
  }

  // POST /api/v1/scheduled-tasks/:id/run (trigger)
  if (method === "POST") {
    const triggerMatch = pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)\/run$/);
    if (triggerMatch) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      const id = decodeURIComponent(triggerMatch[1]);
      if (id !== "task-1") return json({ error: "not_found", message: "Task not found" }, 404);
      return json({ ok: true });
    }
  }

  // GET /api/v1/scheduled-tasks/:id/runs
  if (method === "GET") {
    const runsMatch = pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)\/runs$/);
    if (runsMatch) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      return json(MOCK_SCHEDULED_TASK_RUNS);
    }
  }

  // GET /api/v1/scheduled-tasks (list)
  if (method === "GET" && pathname === "/api/v1/scheduled-tasks") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json(MOCK_SCHEDULED_TASKS);
  }

  // GET /api/v1/scheduled-tasks/:id
  if (method === "GET") {
    const taskId = matchRoute(pathname, "/api/v1/scheduled-tasks/");
    if (taskId) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      if (taskId === "task-1") {
        return json({ ...MOCK_SCHEDULED_TASK, recentRuns: MOCK_SCHEDULED_TASK_RUNS.runs });
      }
      return json({ error: "not_found", message: "Task not found" }, 404);
    }
  }

  // PUT /api/v1/scheduled-tasks/:id
  if (method === "PUT") {
    const taskId = matchRoute(pathname, "/api/v1/scheduled-tasks/");
    if (taskId) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      if (taskId !== "task-1") return json({ error: "not_found", message: "Task not found" }, 404);
      const bodyOrErr = await parseJsonBody(req);
      if (bodyOrErr instanceof Response) return bodyOrErr;
      return json({ ...MOCK_SCHEDULED_TASK, ...bodyOrErr });
    }
  }

  // DELETE /api/v1/scheduled-tasks/:id
  if (method === "DELETE") {
    const taskId = matchRoute(pathname, "/api/v1/scheduled-tasks/");
    if (taskId) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      if (taskId === "task-1") return new Response(null, { status: 204 });
      return json({ error: "not_found", message: "Task not found" }, 404);
    }
  }

  // ---- Admin routes ----

  if (method === "GET" && pathname === "/api/v1/admin/overview") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json(MOCK_ADMIN_OVERVIEW);
  }

  if (method === "GET" && pathname === "/api/v1/admin/connections") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json(MOCK_ADMIN_CONNECTIONS);
  }

  // POST /api/v1/admin/connections/:id/test
  if (method === "POST") {
    const connTestMatch = pathname.match(/^\/api\/v1\/admin\/connections\/([^/]+)\/test$/);
    if (connTestMatch) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      return json(MOCK_CONNECTION_HEALTH);
    }
  }

  if (method === "GET" && pathname === "/api/v1/admin/audit") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json(MOCK_AUDIT_LOG);
  }

  if (method === "GET" && pathname === "/api/v1/admin/audit/stats") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json(MOCK_AUDIT_STATS);
  }

  if (method === "GET" && pathname === "/api/v1/admin/plugins") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json(MOCK_PLUGINS);
  }

  // POST /api/v1/admin/plugins/:id/health
  if (method === "POST") {
    const pluginHealthMatch = pathname.match(/^\/api\/v1\/admin\/plugins\/([^/]+)\/health$/);
    if (pluginHealthMatch) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      return json({ healthy: true, message: "OK", latencyMs: 5, status: "healthy" });
    }
  }

  if (method === "GET" && pathname === "/api/v1/admin/semantic/entities") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json(MOCK_SEMANTIC_ENTITIES);
  }

  if (method === "GET") {
    const entityName = matchRoute(pathname, "/api/v1/admin/semantic/entities/");
    if (entityName) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      if (entityName === "users") return json({ entity: { table: "users", description: "User accounts" } });
      return json({ error: "not_found", message: "Entity not found" }, 404);
    }
  }

  if (method === "GET" && pathname === "/api/v1/admin/semantic/metrics") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json({ metrics: [{ source: "default", data: {} }] });
  }

  if (method === "GET" && pathname === "/api/v1/admin/semantic/glossary") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json({ glossary: [{ term: "user", definition: "An account holder" }] });
  }

  if (method === "GET" && pathname === "/api/v1/admin/semantic/catalog") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json({ catalog: { version: "1.0" } });
  }

  if (method === "GET" && pathname === "/api/v1/admin/semantic/stats") {
    const authErr = checkAuth(req);
    if (authErr) return authErr;
    return json({
      totalEntities: 15,
      totalColumns: 80,
      totalJoins: 10,
      totalMeasures: 20,
      coverageGaps: { noDescription: 2, noColumns: 0, noJoins: 5 },
    });
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
    error(err) {
      return json({ error: "internal_error", message: `Mock server error: ${err.message}` }, 500);
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    stop: () => server.stop(true),
  };
}

export { VALID_API_KEY };

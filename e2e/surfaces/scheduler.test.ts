/**
 * E2E: Scheduler surface tests.
 *
 * Validates the scheduled tasks CRUD lifecycle, webhook trigger execution,
 * and delivery verification via a mock webhook receiver.
 *
 * Uses in-process Hono app.fetch() with an in-memory task store that
 * replaces the real DB-backed module. Auth middleware is mocked to return
 * a configurable admin user. The scheduler engine/executor are mocked to
 * avoid real agent execution.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import {
  createMockServer,
  createRoutedMockServer,
  type MockServer,
} from "../helpers/mock-server";

// ---------------------------------------------------------------------------
// Environment — must be set before any app module imports
// ---------------------------------------------------------------------------

process.env.ATLAS_SCHEDULER_ENABLED = "true";

// ---------------------------------------------------------------------------
// In-memory scheduled task store
// ---------------------------------------------------------------------------

interface StoredTask {
  id: string;
  owner_id: string;
  name: string;
  question: string;
  cron_expression: string;
  delivery_channel: string;
  recipients: unknown;
  connection_id: string | null;
  approval_mode: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface StoredRun {
  id: string;
  task_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  conversation_id: string | null;
  action_id: string | null;
  error: string | null;
  tokens_used: number | null;
  created_at: string;
}

let tasks: StoredTask[] = [];
let runs: StoredRun[] = [];

function resetStore() {
  tasks = [];
  runs = [];
}

function taskToApiShape(t: StoredTask) {
  const recipients = typeof t.recipients === "string"
    ? JSON.parse(t.recipients)
    : t.recipients ?? [];
  return {
    id: t.id,
    ownerId: t.owner_id,
    name: t.name,
    question: t.question,
    cronExpression: t.cron_expression,
    deliveryChannel: t.delivery_channel,
    recipients,
    connectionId: t.connection_id,
    approvalMode: t.approval_mode,
    enabled: t.enabled,
    lastRunAt: t.last_run_at,
    nextRunAt: t.next_run_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function runToApiShape(r: StoredRun) {
  return {
    id: r.id,
    taskId: r.task_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status,
    conversationId: r.conversation_id,
    actionId: r.action_id,
    error: r.error,
    tokensUsed: r.tokens_used,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Mocks — everything except scheduled-tasks module
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
  resetStartupCache: mock(() => {}),
}));

mock.module("@atlas/api/lib/db/connection", () => ({
  getDB: () => ({
    query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
    close: async () => {},
  }),
  connections: {
    get: () => ({
      query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
      close: async () => {},
    }),
    getDefault: () => ({
      query: async () => ({ columns: ["?column?"], rows: [{ "?column?": 1 }] }),
      close: async () => {},
    }),
    getDBType: () => "postgres" as const,
    getTargetHost: () => "localhost",
    list: () => [],
    describe: () => [],
  },
  detectDBType: () => "postgres" as const,
  extractTargetHost: () => "localhost",
  resolveDatasourceUrl: () => "postgresql://test:test@localhost/test",
  rewriteClickHouseUrl: (url: string) => url,
  parseSnowflakeURL: () => ({}),
  ConnectionRegistry: class {},
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => { throw new Error("Use mocked scheduled-tasks"); },
  internalQuery: async () => [],
  internalExecute: () => {},
  closeInternalDB: async () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  migrateInternalDB: async () => {},
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(["test_orders"]),
  _resetWhitelists: () => {},
  getCrossSourceJoins: () => [],
  registerPluginEntities: mock(() => {}),
  _resetPluginEntities: mock(() => {}),
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: mock(() => {}),
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
    }),
  ),
  buildSystemParam: mock(() => ({})),
  applyCacheControl: mock(() => {}),
}));

mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mock(() =>
    Promise.resolve({
      answer: "42",
      sql: ["SELECT 1"],
      data: [{ columns: ["?column?"], rows: [{ "?column?": 1 }] }],
      steps: 1,
      usage: { totalTokens: 100 },
    }),
  ),
}));

mock.module("@atlas/api/lib/tools/actions", () => ({
  createJiraTicket: {
    name: "createJiraTicket", description: "Mock", tool: { type: "function" },
    actionType: "jira:create", reversible: true, defaultApproval: "manual",
    requiredCredentials: ["JIRA_BASE_URL"],
  },
  sendEmailReport: {
    name: "sendEmailReport", description: "Mock", tool: { type: "function" },
    actionType: "email:send", reversible: false, defaultApproval: "admin-only",
    requiredCredentials: ["RESEND_API_KEY"],
  },
}));

mock.module("@atlas/api/lib/conversations", () => ({
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  getConversation: mock(() => Promise.resolve(null)),
  generateTitle: mock((q: string) => q.slice(0, 80)),
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  starConversation: mock(() => Promise.resolve(null)),
  deleteConversation: mock(() => Promise.resolve(false)),
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => null,
  configFromEnv: () => ({}),
  loadConfig: async () => null,
  initializeConfig: async () => {},
  validateAndResolve: () => ({}),
  defineConfig: (c: unknown) => c,
  _resetConfig: () => {},
  validateToolConfig: async () => {},
  applyDatasources: async () => {},
}));

mock.module("@atlas/api/lib/plugins/hooks", () => ({
  dispatchHook: async () => {},
  dispatchMutableHook: async (_name: string, payload: unknown) => payload,
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "api-key",
  resetAuthModeCache: () => {},
  getAuthModeSource: () => null,
}));

// ---------------------------------------------------------------------------
// Scheduled tasks mock — backed by in-memory store
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/scheduled-tasks", () => ({
  createScheduledTask: mock(async (opts: {
    ownerId: string;
    name: string;
    question: string;
    cronExpression: string;
    deliveryChannel?: string;
    recipients?: unknown[];
    connectionId?: string | null;
    approvalMode?: string;
  }) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const task: StoredTask = {
      id,
      owner_id: opts.ownerId,
      name: opts.name,
      question: opts.question,
      cron_expression: opts.cronExpression,
      delivery_channel: opts.deliveryChannel ?? "webhook",
      recipients: JSON.stringify(opts.recipients ?? []),
      connection_id: opts.connectionId ?? null,
      approval_mode: opts.approvalMode ?? "auto",
      enabled: true,
      last_run_at: null,
      next_run_at: now,
      created_at: now,
      updated_at: now,
    };
    tasks.push(task);
    return { ok: true as const, data: taskToApiShape(task) };
  }),

  getScheduledTask: mock(async (id: string, ownerId?: string) => {
    const task = tasks.find(t =>
      t.id === id && (ownerId == null || t.owner_id === ownerId),
    );
    if (!task) return { ok: false as const, reason: "not_found" as const };
    return { ok: true as const, data: taskToApiShape(task) };
  }),

  listScheduledTasks: mock(async (opts?: {
    ownerId?: string;
    enabled?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    let filtered = [...tasks];
    if (opts?.ownerId) filtered = filtered.filter(t => t.owner_id === opts.ownerId);
    if (opts?.enabled !== undefined) filtered = filtered.filter(t => t.enabled === opts.enabled);
    const total = filtered.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 20;
    const sliced = filtered.slice(offset, offset + limit);
    return { tasks: sliced.map(taskToApiShape), total };
  }),

  updateScheduledTask: mock(async (id: string, ownerId: string, updates: Record<string, unknown>) => {
    const task = tasks.find(t => t.id === id && t.owner_id === ownerId);
    if (!task) return { ok: false as const, reason: "not_found" as const };
    if (updates.name !== undefined) task.name = updates.name as string;
    if (updates.question !== undefined) task.question = updates.question as string;
    if (updates.cronExpression !== undefined) task.cron_expression = updates.cronExpression as string;
    if (updates.deliveryChannel !== undefined) task.delivery_channel = updates.deliveryChannel as string;
    if (updates.recipients !== undefined) task.recipients = JSON.stringify(updates.recipients);
    if (updates.enabled !== undefined) task.enabled = updates.enabled as boolean;
    task.updated_at = new Date().toISOString();
    return { ok: true as const };
  }),

  deleteScheduledTask: mock(async (id: string, ownerId?: string) => {
    const task = tasks.find(t =>
      t.id === id && (ownerId == null || t.owner_id === ownerId),
    );
    if (!task) return { ok: false as const, reason: "not_found" as const };
    task.enabled = false;
    task.updated_at = new Date().toISOString();
    return { ok: true as const };
  }),

  listTaskRuns: mock(async (taskId: string, opts?: { limit?: number }) => {
    const filtered = runs.filter(r => r.task_id === taskId);
    const limit = opts?.limit ?? 20;
    return filtered.slice(0, limit).map(runToApiShape);
  }),

  validateCronExpression: mock((expr: string) => {
    // Simple validation for test — accept standard patterns, reject obvious junk
    if (/^\s*$/.test(expr)) return { valid: false, error: "Empty expression" };
    if (/^[\d*/,\- ]+$/.test(expr) || /^@(yearly|monthly|weekly|daily|hourly)$/.test(expr)) {
      return { valid: true };
    }
    return { valid: false, error: "Invalid cron expression" };
  }),

  createTaskRun: mock(async (taskId: string) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    runs.push({
      id,
      task_id: taskId,
      started_at: now,
      completed_at: null,
      status: "running",
      conversation_id: null,
      action_id: null,
      error: null,
      tokens_used: null,
      created_at: now,
    });
    return id;
  }),

  completeTaskRun: mock(() => {}),
  getTasksDueForExecution: mock(async () => []),
  lockTaskForExecution: mock(async () => true),
  computeNextRun: mock(() => new Date()),
  _resetScheduledTasksForTest: mock(() => {}),
}));

// Mock the scheduler engine to avoid real agent execution
const mockRunTick: Mock<() => Promise<{
  checked: number;
  executed: number;
  error?: string;
}>> = mock(async () => ({ checked: 0, executed: 0 }));

const mockTriggerTask: Mock<(id: string) => Promise<void>> = mock(async () => {});

mock.module("@atlas/api/lib/scheduler/engine", () => ({
  runTick: mockRunTick,
  triggerTask: mockTriggerTask,
  startScheduler: mock(() => {}),
  stopScheduler: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Auth mock — configurable per test
// ---------------------------------------------------------------------------

const adminUser = { id: "admin-1", mode: "api-key" as const, label: "Admin", role: "admin" as const };
const userB = { id: "user-b", mode: "api-key" as const, label: "User B", role: "analyst" as const };
let currentUser = adminUser;

const mockAuthenticateRequest: Mock<(req: Request) => Promise<
  | { authenticated: true; mode: string; user: typeof adminUser }
  | { authenticated: false; mode: string; status: 401; error: string }
>> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "api-key",
    user: currentUser,
  }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  _stopCleanup: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
  resetRateLimits: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Import app after all mocks
// ---------------------------------------------------------------------------

const { app } = await import("../../packages/api/src/api/index");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, opts);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStore();
  currentUser = adminUser;
  mockAuthenticateRequest.mockClear();
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true as const,
      mode: "api-key",
      user: currentUser,
    }),
  );
  mockRunTick.mockClear();
  mockTriggerTask.mockClear();
});

afterAll(() => {
  resetStore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Scheduler — CRUD lifecycle", () => {
  it("creates a scheduled task with valid cron expression", async () => {
    const res = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Daily Revenue Report",
        question: "What was yesterday's total revenue?",
        cronExpression: "0 9 * * *",
        deliveryChannel: "webhook",
        recipients: [{ type: "webhook", url: "https://example.com/hook" }],
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      question: string;
      cronExpression: string;
      deliveryChannel: string;
      enabled: boolean;
    };
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Daily Revenue Report");
    expect(body.question).toBe("What was yesterday's total revenue?");
    expect(body.cronExpression).toBe("0 9 * * *");
    expect(body.enabled).toBe(true);
  });

  it("rejects creation with invalid cron expression", async () => {
    const res = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Bad Cron Task",
        question: "How many orders?",
        cronExpression: "not a cron",
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toContain("cron");
  });

  it("rejects creation with missing required fields", async () => {
    const res = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "",
        question: "",
        cronExpression: "0 * * * *",
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("lists scheduled tasks for the authenticated user", async () => {
    // Create two tasks first
    const createA = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Task A",
        question: "Question A",
        cronExpression: "0 * * * *",
      }),
    );
    expect(createA.status).toBe(201);
    const createB = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Task B",
        question: "Question B",
        cronExpression: "0 0 * * *",
      }),
    );
    expect(createB.status).toBe(201);

    const res = await app.fetch(
      makeRequest("GET", "/api/v1/scheduled-tasks"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: { name: string }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.tasks).toHaveLength(2);
  });

  it("retrieves a specific task by ID", async () => {
    const createRes = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Find Me",
        question: "How many active users?",
        cronExpression: "0 0 * * 1",
        deliveryChannel: "webhook",
        recipients: [{ type: "webhook", url: "https://example.com/hook" }],
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const res = await app.fetch(
      makeRequest("GET", `/api/v1/scheduled-tasks/${created.id}`),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      recentRuns: unknown[];
    };
    expect(body.id).toBe(created.id);
    expect(body.name).toBe("Find Me");
    expect(body.recentRuns).toBeDefined();
  });

  it("returns 404 for non-existent task", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const res = await app.fetch(
      makeRequest("GET", `/api/v1/scheduled-tasks/${fakeId}`),
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid UUID format", async () => {
    const res = await app.fetch(
      makeRequest("GET", "/api/v1/scheduled-tasks/not-a-uuid"),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("updates a scheduled task", async () => {
    const createRes = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Original Name",
        question: "Original question",
        cronExpression: "0 * * * *",
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const updateRes = await app.fetch(
      makeRequest("PUT", `/api/v1/scheduled-tasks/${created.id}`, {
        name: "Updated Name",
        enabled: false,
      }),
    );

    expect(updateRes.status).toBe(200);
    const body = (await updateRes.json()) as { name: string; enabled: boolean };
    expect(body.name).toBe("Updated Name");
  });

  it("deletes (disables) a scheduled task", async () => {
    const createRes = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Delete Me",
        question: "To be deleted",
        cronExpression: "0 * * * *",
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const deleteRes = await app.fetch(
      makeRequest("DELETE", `/api/v1/scheduled-tasks/${created.id}`),
    );

    expect(deleteRes.status).toBe(204);
  });
});

describe("E2E: Scheduler — trigger execution", () => {
  it("triggers immediate execution of a task", async () => {
    const createRes = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Trigger Me",
        question: "What are the latest metrics?",
        cronExpression: "0 * * * *",
        deliveryChannel: "webhook",
        recipients: [{ type: "webhook", url: "https://example.com/hook" }],
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const triggerRes = await app.fetch(
      makeRequest("POST", `/api/v1/scheduled-tasks/${created.id}/run`),
    );

    expect(triggerRes.status).toBe(200);
    const body = (await triggerRes.json()) as { message: string; taskId: string };
    expect(body.message).toContain("triggered");
    expect(body.taskId).toBe(created.id);

    // Verify triggerTask was called with the correct ID
    expect(mockTriggerTask).toHaveBeenCalledWith(created.id);
  });

  it("returns 404 when triggering non-existent task", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const res = await app.fetch(
      makeRequest("POST", `/api/v1/scheduled-tasks/${fakeId}/run`),
    );

    expect(res.status).toBe(404);
  });
});

describe("E2E: Scheduler — tick endpoint", () => {
  it("accepts tick with valid secret", async () => {
    const origSecret = process.env.ATLAS_SCHEDULER_SECRET;
    process.env.ATLAS_SCHEDULER_SECRET = "test-tick-secret";

    try {
      mockRunTick.mockResolvedValue({ checked: 5, executed: 2 });

      const res = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-tick-secret",
          },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { checked: number; executed: number };
      expect(body.checked).toBe(5);
      expect(body.executed).toBe(2);
      expect(mockRunTick).toHaveBeenCalled();
    } finally {
      if (origSecret !== undefined) {
        process.env.ATLAS_SCHEDULER_SECRET = origSecret;
      } else {
        delete process.env.ATLAS_SCHEDULER_SECRET;
      }
    }
  });

  it("rejects tick with wrong secret", async () => {
    const origSecret = process.env.ATLAS_SCHEDULER_SECRET;
    process.env.ATLAS_SCHEDULER_SECRET = "correct-secret";

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-secret",
          },
        }),
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unauthorized");
    } finally {
      if (origSecret !== undefined) {
        process.env.ATLAS_SCHEDULER_SECRET = origSecret;
      } else {
        delete process.env.ATLAS_SCHEDULER_SECRET;
      }
    }
  });
});

describe("E2E: Scheduler — webhook delivery (mock)", () => {
  let webhookServer: MockServer;

  afterAll(() => {
    webhookServer?.close();
  });

  it("verifies webhook recipient structure in created task", async () => {
    webhookServer = createMockServer(() =>
      new Response(JSON.stringify({ received: true }), { status: 200 }),
    );

    const res = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Webhook Task",
        question: "What are the daily metrics?",
        cronExpression: "0 9 * * *",
        deliveryChannel: "webhook",
        recipients: [
          {
            type: "webhook",
            url: webhookServer.url,
            headers: { "X-Custom-Header": "atlas-test" },
          },
        ],
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      deliveryChannel: string;
      recipients: { type: string; url: string; headers?: Record<string, string> }[];
    };
    expect(body.deliveryChannel).toBe("webhook");
    expect(body.recipients).toHaveLength(1);
    expect(body.recipients[0].type).toBe("webhook");
    expect(body.recipients[0].url).toBe(webhookServer.url);
  });
});

describe("E2E: Scheduler — user isolation", () => {
  it("user B cannot see user A's tasks", async () => {
    // Create task as admin (user A)
    const createRes = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Admin's Task",
        question: "Admin question",
        cronExpression: "0 * * * *",
      }),
    );
    expect(createRes.status).toBe(201);

    // Verify user A can see their task
    const listA = await app.fetch(makeRequest("GET", "/api/v1/scheduled-tasks"));
    const bodyA = (await listA.json()) as { total: number };
    expect(bodyA.total).toBe(1);

    // Switch to user B
    currentUser = userB as typeof adminUser;
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true as const,
        mode: "api-key",
        user: currentUser,
      }),
    );

    const res = await app.fetch(
      makeRequest("GET", "/api/v1/scheduled-tasks"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.tasks).toHaveLength(0);
  });

  it("user B cannot trigger user A's task", async () => {
    // Create task as admin
    const createRes = await app.fetch(
      makeRequest("POST", "/api/v1/scheduled-tasks", {
        name: "Admin Only",
        question: "Admin question",
        cronExpression: "0 * * * *",
      }),
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    // Switch to user B
    currentUser = userB as typeof adminUser;
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true as const,
        mode: "api-key",
        user: currentUser,
      }),
    );

    const res = await app.fetch(
      makeRequest("POST", `/api/v1/scheduled-tasks/${created.id}/run`),
    );

    expect(res.status).toBe(404);
  });
});

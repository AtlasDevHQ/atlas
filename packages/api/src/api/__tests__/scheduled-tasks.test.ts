/**
 * Unit tests for the scheduled tasks REST routes.
 *
 * Uses mock.module() pattern from actions.test.ts.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  type Mock,
} from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";

// --- Auth mocks ---

const mockAuthenticateRequest: Mock<
  (req: Request) => Promise<AuthResult>
> = mock(() =>
  Promise.resolve({
    authenticated: true as const,
    mode: "simple-key" as const,
    user: { id: "u1", label: "test@test.com", mode: "simple-key" as const },
  }),
);

const mockCheckRateLimit: Mock<
  (key: string) => { allowed: boolean; retryAfterMs?: number }
> = mock(() => ({ allowed: true }));

const mockGetClientIP: Mock<(req: Request) => string | null> = mock(
  () => null,
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mockCheckRateLimit,
  getClientIP: mockGetClientIP,
}));

// --- CRUD mocks ---

const mockCreateScheduledTask = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { id: "task-123", name: "Test" } }),
);
const mockGetScheduledTask = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { id: "task-123", name: "Test" } }),
);
const mockListScheduledTasks = mock((): Promise<unknown> =>
  Promise.resolve({ tasks: [], total: 0 }),
);
const mockUpdateScheduledTask = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true }),
);
const mockDeleteScheduledTask = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true }),
);
const mockListTaskRuns = mock((): Promise<unknown> => Promise.resolve([]));
const mockValidateCronExpression = mock((): unknown => ({ valid: true }));

mock.module("@atlas/api/lib/scheduled-tasks", () => ({
  createScheduledTask: mockCreateScheduledTask,
  getScheduledTask: mockGetScheduledTask,
  listScheduledTasks: mockListScheduledTasks,
  updateScheduledTask: mockUpdateScheduledTask,
  deleteScheduledTask: mockDeleteScheduledTask,
  listTaskRuns: mockListTaskRuns,
  validateCronExpression: mockValidateCronExpression,
}));

// --- Other mocks (required by Hono app index.ts) ---

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: mock(() =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
      text: Promise.resolve("answer"),
      steps: Promise.resolve([]),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    }),
  ),
}));

mock.module("@atlas/api/lib/conversations", () => ({
  listConversations: mock(() => Promise.resolve({ conversations: [], total: 0 })),
  getConversation: mock(() => Promise.resolve(null)),
  deleteConversation: mock(() => Promise.resolve(false)),
  createConversation: mock(() => Promise.resolve(null)),
  addMessage: mock(() => {}),
  generateTitle: mock(() => "Test title"),
  starConversation: async () => false,
}));

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => new Set(),
  _resetWhitelists: () => {},
}));

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: () => [],
}));

const mockRunTick = mock((): Promise<{ tasksFound: number; tasksDispatched: number; tasksCompleted: number; tasksFailed: number; error?: string }> =>
  Promise.resolve({ tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0 }),
);

mock.module("@atlas/api/lib/scheduler/engine", () => ({
  triggerTask: mock(() => Promise.resolve()),
  runTick: mockRunTick,
  getScheduler: () => ({ start: () => {}, stop: () => {}, isRunning: () => false }),
  _resetScheduler: () => {},
}));

const mockGetConfig = mock(() => ({ scheduler: { backend: "bun" } }));
mock.module("@atlas/api/lib/config", () => ({
  getConfig: mockGetConfig,
  loadConfig: mock(() => Promise.resolve({})),
  configFromEnv: mock(() => ({})),
  initializeConfig: mock(() => Promise.resolve({})),
  _resetConfig: () => {},
}));

// Enable routes before importing the app
process.env.ATLAS_SCHEDULER_ENABLED = "true";

// Import after mocks
const { app } = await import("../index");

const VALID_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("scheduled-tasks routes", () => {
  const origDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    mockAuthenticateRequest.mockReset();
    mockAuthenticateRequest.mockResolvedValue({
      authenticated: true as const,
      mode: "simple-key" as const,
      user: { id: "u1", label: "test@test.com", mode: "simple-key" as const },
    });
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockReturnValue({ allowed: true });
    mockGetClientIP.mockReset();
    mockGetClientIP.mockReturnValue(null);
    mockCreateScheduledTask.mockReset();
    mockCreateScheduledTask.mockResolvedValue({ ok: true, data: { id: "task-123", name: "Test" } });
    mockGetScheduledTask.mockReset();
    mockGetScheduledTask.mockResolvedValue({ ok: true, data: { id: VALID_ID, name: "Test" } });
    mockListScheduledTasks.mockReset();
    mockListScheduledTasks.mockResolvedValue({ tasks: [], total: 0 });
    mockUpdateScheduledTask.mockReset();
    mockUpdateScheduledTask.mockResolvedValue({ ok: true });
    mockDeleteScheduledTask.mockReset();
    mockDeleteScheduledTask.mockResolvedValue({ ok: true });
    mockListTaskRuns.mockReset();
    mockListTaskRuns.mockResolvedValue([]);
    mockValidateCronExpression.mockReset();
    mockValidateCronExpression.mockReturnValue({ valid: true });
    mockRunTick.mockReset();
    mockRunTick.mockResolvedValue({ tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0 });
    mockGetConfig.mockReset();
    mockGetConfig.mockReturnValue({ scheduler: { backend: "bun" } });
    delete process.env.CRON_SECRET;
    delete process.env.ATLAS_SCHEDULER_SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    if (origDatabaseUrl !== undefined) process.env.DATABASE_URL = origDatabaseUrl;
    else delete process.env.DATABASE_URL;
    delete process.env.CRON_SECRET;
    delete process.env.ATLAS_SCHEDULER_SECRET;
    delete process.env.NODE_ENV;
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/scheduled-tasks
  // -------------------------------------------------------------------------

  describe("GET /api/v1/scheduled-tasks", () => {
    it("returns 200 with task list", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { tasks: unknown[]; total: number };
      expect(body.tasks).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks"),
      );
      expect(response.status).toBe(404);
    });

    it("returns 401 when unauthenticated", async () => {
      mockAuthenticateRequest.mockResolvedValueOnce({
        authenticated: false as const,
        mode: "simple-key" as const,
        status: 401 as const,
        error: "API key required",
      });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks"),
      );
      expect(response.status).toBe(401);
    });

    it("returns 429 when rate limited", async () => {
      mockCheckRateLimit.mockReturnValueOnce({
        allowed: false,
        retryAfterMs: 30000,
      });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks"),
      );
      expect(response.status).toBe(429);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/scheduled-tasks
  // -------------------------------------------------------------------------

  describe("POST /api/v1/scheduled-tasks", () => {
    it("returns 201 on valid create", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Daily Revenue",
            question: "What was yesterday's revenue?",
            cronExpression: "0 9 * * 1",
            deliveryChannel: "email",
            recipients: [{ type: "email", address: "test@test.com" }],
          }),
        }),
      );
      expect(response.status).toBe(201);
    });

    it("returns 400 for missing name", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: "What?",
            cronExpression: "0 9 * * 1",
          }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid JSON", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json{",
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid cron expression", async () => {
      mockValidateCronExpression.mockReturnValueOnce({ valid: false, error: "Bad cron" });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Test",
            question: "Q?",
            cronExpression: "bad",
          }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.message).toContain("Invalid cron expression");
    });

    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Test",
            question: "Q?",
            cronExpression: "0 9 * * 1",
          }),
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/scheduled-tasks/:id
  // -------------------------------------------------------------------------

  describe("GET /api/v1/scheduled-tasks/:id", () => {
    it("returns 200 with task and recent runs", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.id).toBe(VALID_ID);
      expect(body.recentRuns).toBeDefined();
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/not-a-uuid"),
      );
      expect(response.status).toBe(400);
    });

    it("returns 404 when not found", async () => {
      mockGetScheduledTask.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}`),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/v1/scheduled-tasks/:id
  // -------------------------------------------------------------------------

  describe("PUT /api/v1/scheduled-tasks/:id", () => {
    it("returns 200 on valid update", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Updated Name" }),
        }),
      );
      expect(response.status).toBe(200);
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/bad-id", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "X" }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid JSON", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "not json{",
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 404 when not found", async () => {
      mockUpdateScheduledTask.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Updated" }),
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/scheduled-tasks/:id
  // -------------------------------------------------------------------------

  describe("DELETE /api/v1/scheduled-tasks/:id", () => {
    it("returns 204 on success", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(204);
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/bad-id", {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 404 when not found", async () => {
      mockDeleteScheduledTask.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}`, {
          method: "DELETE",
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/scheduled-tasks/:id/run
  // -------------------------------------------------------------------------

  describe("POST /api/v1/scheduled-tasks/:id/run", () => {
    it("returns 200 on successful trigger", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}/run`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.taskId).toBe(VALID_ID);
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/bad-id/run", {
          method: "POST",
        }),
      );
      expect(response.status).toBe(400);
    });

    it("returns 404 when task not found", async () => {
      mockGetScheduledTask.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}/run`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/scheduled-tasks/:id/runs
  // -------------------------------------------------------------------------

  describe("GET /api/v1/scheduled-tasks/:id/runs", () => {
    it("returns 200 with runs", async () => {
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}/runs`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { runs: unknown[] };
      expect(body.runs).toEqual([]);
    });

    it("returns 400 for invalid UUID", async () => {
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/bad-id/runs"),
      );
      expect(response.status).toBe(400);
    });

    it("returns 404 when task not found", async () => {
      mockGetScheduledTask.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const response = await app.fetch(
        new Request(`http://localhost/api/v1/scheduled-tasks/${VALID_ID}/runs`),
      );
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/scheduled-tasks/tick
  // -------------------------------------------------------------------------

  describe("POST /api/v1/scheduled-tasks/tick", () => {
    it("returns 404 when no internal DB", async () => {
      delete process.env.DATABASE_URL;
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", { method: "POST" }),
      );
      expect(response.status).toBe(404);
    });

    it("returns 200 with tick result when no secret is set (non-production)", async () => {
      mockRunTick.mockResolvedValueOnce({ tasksFound: 2, tasksDispatched: 2, tasksCompleted: 2, tasksFailed: 0 });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", { method: "POST" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.tasksFound).toBe(2);
    });

    it("returns 200 when CRON_SECRET matches", async () => {
      process.env.CRON_SECRET = "test-secret";
      mockRunTick.mockResolvedValueOnce({ tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0 });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", {
          method: "POST",
          headers: { Authorization: "Bearer test-secret" },
        }),
      );
      expect(response.status).toBe(200);
    });

    it("returns 200 when ATLAS_SCHEDULER_SECRET matches", async () => {
      process.env.ATLAS_SCHEDULER_SECRET = "my-secret";
      mockRunTick.mockResolvedValueOnce({ tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0 });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", {
          method: "POST",
          headers: { Authorization: "Bearer my-secret" },
        }),
      );
      expect(response.status).toBe(200);
    });

    it("returns 401 when CRON_SECRET is set but Authorization is wrong", async () => {
      process.env.CRON_SECRET = "test-secret";
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", {
          method: "POST",
          headers: { Authorization: "Bearer wrong" },
        }),
      );
      expect(response.status).toBe(401);
    });

    it("returns 401 when CRON_SECRET is set but Authorization is missing", async () => {
      process.env.CRON_SECRET = "test-secret";
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", { method: "POST" }),
      );
      expect(response.status).toBe(401);
    });

    it("returns 500 when backend is vercel and no secret is configured", async () => {
      mockGetConfig.mockReturnValue({ scheduler: { backend: "vercel" } });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", { method: "POST" }),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("misconfigured");
    });

    it("returns 500 in production when no secret is configured", async () => {
      process.env.NODE_ENV = "production";
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", { method: "POST" }),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("misconfigured");
    });

    it("returns 500 when runTick returns an error", async () => {
      mockRunTick.mockResolvedValueOnce({
        tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0, error: "db down",
      });
      const response = await app.fetch(
        new Request("http://localhost/api/v1/scheduled-tasks/tick", { method: "POST" }),
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("db down");
    });
  });
});

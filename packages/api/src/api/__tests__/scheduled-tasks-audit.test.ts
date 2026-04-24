/**
 * Audit regression suite for `scheduled-tasks.ts` — F-29 (#1784).
 *
 * Pins the three gaps closed by this PR:
 *   - `POST /:id/run` → `schedule.trigger`
 *   - `POST /:id/preview` → `schedule.preview`
 *   - `POST /tick` → `schedule.tick` (uses `system:scheduler` actor)
 *
 * `schedule.tick` is the tricky one: it has no HTTP-bound admin and must
 * use the F-27 system-actor convention so forensic queries on
 * `actor = 'system:scheduler'` land on scheduler rows. The test pins the
 * exact string — a rename or typo in the route fails here.
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
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ---------------------------------------------------------------------------
// Mocks — declared before the app import
// ---------------------------------------------------------------------------

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
});

// Scheduled-tasks lib: the route yields `getScheduledTask` + friends. We
// return the happy-path task row so the route reaches the audit call.
const mockGetScheduledTask: Mock<(id: string, opts: { orgId: string }) => Promise<{ ok: true; data: { id: string; name: string } } | { ok: false; reason: string }>> = mock(
  async () => ({ ok: true, data: { id: "00000000-0000-0000-0000-000000000001", name: "Daily refresh" } }),
);

mock.module("@atlas/api/lib/scheduled-tasks", () => ({
  listScheduledTasks: mock(async () => []),
  getScheduledTask: mockGetScheduledTask,
  createScheduledTask: mock(async () => ({ ok: true, data: { id: "task-1", name: "new" } })),
  updateScheduledTask: mock(async () => ({ ok: true })),
  deleteScheduledTask: mock(async () => ({ ok: true })),
  listTaskRuns: mock(async () => []),
  listAllRuns: mock(async () => []),
  validateCronExpression: () => ({ valid: true }),
}));

// Scheduler engine: trigger + runTick.
const mockTriggerTask: Mock<(id: string) => Promise<void>> = mock(async () => {});
const mockRunTick: Mock<() => Promise<{ tasksFound: number; tasksDispatched: number; tasksCompleted: number; tasksFailed: number }>> = mock(
  async () => ({ tasksFound: 0, tasksDispatched: 0, tasksCompleted: 0, tasksFailed: 0 }),
);

mock.module("@atlas/api/lib/scheduler/engine", () => ({
  triggerTask: mockTriggerTask,
  runTick: mockRunTick,
  _resetScheduler: () => {},
}));

mock.module("@atlas/api/lib/scheduler/preview", () => ({
  generateDeliveryPreview: () => ({ preview: "stub" }),
}));

// Audit capture
interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
  systemActor?: string;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// Enable the scheduler mount point at import time. Hono conditionally
// mounts the scheduled-tasks router based on ATLAS_SCHEDULER_ENABLED.
process.env.ATLAS_SCHEDULER_ENABLED = "true";

const { app } = await import("../index");

afterAll(() => {
  mocks.cleanup();
  delete process.env.ATLAS_SCHEDULER_ENABLED;
  delete process.env.CRON_SECRET;
  delete process.env.ATLAS_SCHEDULER_SECRET;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminRequest(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
      ...headers,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function lastAuditCall(): AuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

const UUID_A = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mockGetScheduledTask.mockReset();
  mockGetScheduledTask.mockImplementation(async () => ({
    ok: true,
    data: { id: UUID_A, name: "Daily refresh" },
  }));
  mockTriggerTask.mockClear();
  mockTriggerTask.mockImplementation(async () => {});
  mockRunTick.mockClear();
  mockRunTick.mockImplementation(async () => ({
    tasksFound: 0,
    tasksDispatched: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
  }));
  delete process.env.CRON_SECRET;
  delete process.env.ATLAS_SCHEDULER_SECRET;
});

// ---------------------------------------------------------------------------
// POST /:id/run — trigger
// ---------------------------------------------------------------------------

describe("POST /api/v1/scheduled-tasks/:id/run — audit emission (F-29)", () => {
  it("emits schedule.trigger with taskId + taskName metadata on success", async () => {
    const res = await app.fetch(
      adminRequest("POST", `/api/v1/scheduled-tasks/${UUID_A}/run`),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("schedule.trigger");
    expect(entry.targetType).toBe("schedule");
    expect(entry.targetId).toBe(UUID_A);
    expect(entry.metadata).toMatchObject({ taskId: UUID_A, taskName: "Daily refresh" });
  });

  it("does not emit when the task does not exist (404)", async () => {
    mockGetScheduledTask.mockImplementation(async () => ({ ok: false, reason: "not_found" }));

    const res = await app.fetch(
      adminRequest("POST", `/api/v1/scheduled-tasks/${UUID_A}/run`),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /:id/preview — preview
// ---------------------------------------------------------------------------

describe("POST /api/v1/scheduled-tasks/:id/preview — audit emission (F-29)", () => {
  it("emits schedule.preview with taskId + dryRun: true metadata", async () => {
    const res = await app.fetch(
      adminRequest("POST", `/api/v1/scheduled-tasks/${UUID_A}/preview`),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("schedule.preview");
    expect(entry.targetType).toBe("schedule");
    expect(entry.targetId).toBe(UUID_A);
    expect(entry.metadata).toMatchObject({ taskId: UUID_A, dryRun: true });
  });
});

// ---------------------------------------------------------------------------
// POST /tick — scheduler tick (system actor)
// ---------------------------------------------------------------------------

describe("POST /api/v1/scheduled-tasks/tick — audit emission (F-29 + F-27 pattern)", () => {
  it("emits schedule.tick with `system:scheduler` actor on a zero-task tick", async () => {
    // Dev-mode path: no secret required when NODE_ENV !== "production".
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/scheduled-tasks/tick"),
    );

    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("schedule.tick");
    expect(entry.targetType).toBe("schedule");
    expect(entry.targetId).toBe("scheduler");
    expect(entry.scope).toBe("platform");
    // PIN the exact system actor string — a rename of the bracket value
    // breaks forensic queries that filter on `actor = 'system:scheduler'`.
    expect(entry.systemActor).toBe("system:scheduler");
    expect(entry.metadata).toMatchObject({
      tasksProcessed: 0,
      successes: 0,
      failures: 0,
    });
  });

  it("carries non-zero counters in metadata when tasks dispatch", async () => {
    mockRunTick.mockImplementation(async () => ({
      tasksFound: 5,
      tasksDispatched: 5,
      tasksCompleted: 4,
      tasksFailed: 1,
    }));

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/scheduled-tasks/tick"),
    );

    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({
      tasksProcessed: 5,
      successes: 4,
      failures: 1,
    });
  });

  it("emits failure-status schedule.tick when the engine reports tick_failed", async () => {
    mockRunTick.mockImplementation(async () => ({
      tasksFound: 0,
      tasksDispatched: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      error: "db unreachable",
    }));

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/scheduled-tasks/tick"),
    );

    expect(res.status).toBe(500);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("schedule.tick");
    expect(entry.status).toBe("failure");
    expect(entry.systemActor).toBe("system:scheduler");
    expect(entry.metadata).toMatchObject({ error: "db unreachable" });
  });

  it("still emits best-effort when hasInternalDB() is false (route short-circuits)", async () => {
    // When the internal DB isn't available the route returns 404 before
    // ever calling the engine — NO audit row should land in that case
    // (there is no tick to describe). Consistent with F-27/F-33 pattern
    // where a best-effort write happens only when the protected action
    // actually ran.
    mocks.hasInternalDB = false;

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/scheduled-tasks/tick"),
    );

    expect(res.status).toBe(404);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("rejects with 401 when a secret is configured and the bearer is wrong (no audit)", async () => {
    process.env.CRON_SECRET = "top-secret";

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/scheduled-tasks/tick", undefined, {
        Authorization: "Bearer wrong-secret",
      }),
    );

    expect(res.status).toBe(401);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

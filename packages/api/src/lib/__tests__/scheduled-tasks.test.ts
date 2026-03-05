/**
 * Unit tests for the scheduled tasks CRUD module.
 *
 * Uses _resetPool(mockPool) injection pattern from conversations.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";
import {
  createScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  createTaskRun,
  completeTaskRun,
  listTaskRuns,
  getTasksDueForExecution,
  lockTaskForExecution,
  validateCronExpression,
  computeNextRun,
} from "../scheduled-tasks";

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
let queryResultIndex = 0;
let queryThrow: Error | null = null;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (queryThrow) throw queryThrow;
    queryCalls.push({ sql, params });
    const result = queryResults[queryResultIndex] ?? { rows: [] };
    queryResultIndex++;
    return result;
  },
  end: async () => {},
  on: () => {},
};

function enableInternalDB() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}

function setResults(...results: Array<{ rows: Record<string, unknown>[] }>) {
  queryResults = results;
  queryResultIndex = 0;
}

function makeTaskRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "task-123",
    owner_id: "u1",
    name: "Daily Report",
    question: "What was yesterday's revenue?",
    cron_expression: "0 9 * * 1",
    delivery_channel: "email",
    recipients: JSON.stringify([{ type: "email", address: "test@test.com" }]),
    connection_id: null,
    approval_mode: "auto",
    enabled: true,
    last_run_at: null,
    next_run_at: "2024-01-08T09:00:00Z",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRunRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "run-123",
    task_id: "task-123",
    started_at: "2024-01-08T09:00:00Z",
    completed_at: "2024-01-08T09:00:30Z",
    status: "success",
    conversation_id: null,
    action_id: null,
    error: null,
    tokens_used: 1500,
    created_at: "2024-01-08T09:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("scheduled-tasks module", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    queryThrow = null;
    delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  // -------------------------------------------------------------------------
  // validateCronExpression
  // -------------------------------------------------------------------------

  describe("validateCronExpression()", () => {
    it("returns valid for standard cron", () => {
      expect(validateCronExpression("0 9 * * 1")).toEqual({ valid: true });
    });

    it("returns valid for every minute", () => {
      expect(validateCronExpression("* * * * *")).toEqual({ valid: true });
    });

    it("returns invalid for garbage", () => {
      const result = validateCronExpression("not a cron");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns invalid for empty string", () => {
      const result = validateCronExpression("");
      expect(result.valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // computeNextRun
  // -------------------------------------------------------------------------

  describe("computeNextRun()", () => {
    it("returns a Date for valid cron", () => {
      const next = computeNextRun("0 9 * * 1");
      expect(next).toBeInstanceOf(Date);
    });

    it("returns null for invalid cron", () => {
      expect(computeNextRun("invalid")).toBeNull();
    });

    it("respects the 'after' parameter", () => {
      const after = new Date("2024-01-01T00:00:00Z");
      const next = computeNextRun("0 9 * * 1", after);
      expect(next).toBeInstanceOf(Date);
      expect(next!.getTime()).toBeGreaterThan(after.getTime());
    });
  });

  // -------------------------------------------------------------------------
  // createScheduledTask
  // -------------------------------------------------------------------------

  describe("createScheduledTask()", () => {
    it("returns { ok: true, data } on success", async () => {
      enableInternalDB();
      setResults({ rows: [makeTaskRow()] });

      const result = await createScheduledTask({
        ownerId: "u1",
        name: "Daily Report",
        question: "Revenue?",
        cronExpression: "0 9 * * 1",
        deliveryChannel: "email",
        recipients: [{ type: "email", address: "test@test.com" }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toBe("task-123");
        expect(result.data.name).toBe("Daily Report");
        expect(result.data.deliveryChannel).toBe("email");
        expect(result.data.recipients).toHaveLength(1);
      }
      expect(queryCalls[0].sql).toContain("INSERT INTO scheduled_tasks");
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      const result = await createScheduledTask({
        ownerId: "u1",
        name: "Test",
        question: "Q?",
        cronExpression: "0 9 * * 1",
      });
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns { ok: false, reason: 'error' } for invalid cron", async () => {
      enableInternalDB();
      const result = await createScheduledTask({
        ownerId: "u1",
        name: "Test",
        question: "Q?",
        cronExpression: "not valid",
      });
      expect(result).toEqual({ ok: false, reason: "error" });
      expect(queryCalls.length).toBe(0); // No DB call made
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("connection refused");
      const result = await createScheduledTask({
        ownerId: "u1",
        name: "Test",
        question: "Q?",
        cronExpression: "0 9 * * 1",
      });
      expect(result).toEqual({ ok: false, reason: "error" });
    });

    it("defaults delivery_channel to webhook", async () => {
      enableInternalDB();
      setResults({ rows: [makeTaskRow({ delivery_channel: "webhook" })] });

      await createScheduledTask({
        ownerId: "u1",
        name: "Test",
        question: "Q?",
        cronExpression: "0 9 * * 1",
      });
      expect(queryCalls[0].params![4]).toBe("webhook");
    });
  });

  // -------------------------------------------------------------------------
  // getScheduledTask
  // -------------------------------------------------------------------------

  describe("getScheduledTask()", () => {
    it("returns { ok: true, data } when found", async () => {
      enableInternalDB();
      setResults({ rows: [makeTaskRow()] });

      const result = await getScheduledTask("task-123", "u1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toBe("task-123");
        expect(result.data.ownerId).toBe("u1");
      }
    });

    it("returns { ok: false, reason: 'not_found' } when not found", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      expect(await getScheduledTask("missing")).toEqual({ ok: false, reason: "not_found" });
    });

    it("scopes by ownerId when provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      await getScheduledTask("task-123", "u1");
      expect(queryCalls[0].sql).toContain("owner_id");
      expect(queryCalls[0].params).toEqual(["task-123", "u1"]);
    });

    it("does not scope by ownerId when not provided", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      await getScheduledTask("task-123");
      expect(queryCalls[0].sql).not.toContain("owner_id");
      expect(queryCalls[0].params).toEqual(["task-123"]);
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      expect(await getScheduledTask("task-123")).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("fail");
      expect(await getScheduledTask("task-123")).toEqual({ ok: false, reason: "error" });
    });
  });

  // -------------------------------------------------------------------------
  // listScheduledTasks
  // -------------------------------------------------------------------------

  describe("listScheduledTasks()", () => {
    it("returns tasks and total", async () => {
      enableInternalDB();
      setResults(
        { rows: [{ total: 1 }] },
        { rows: [makeTaskRow()] },
      );

      const result = await listScheduledTasks({ ownerId: "u1" });
      expect(result.total).toBe(1);
      expect(result.tasks).toHaveLength(1);
    });

    it("returns empty when no DB", async () => {
      expect(await listScheduledTasks()).toEqual({ tasks: [], total: 0 });
    });

    it("respects limit and offset", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 50 }] }, { rows: [] });
      await listScheduledTasks({ limit: 5, offset: 10 });
      expect(queryCalls[1].params).toEqual([5, 10]);
    });

    it("filters by enabled", async () => {
      enableInternalDB();
      setResults({ rows: [{ total: 3 }] }, { rows: [] });
      await listScheduledTasks({ enabled: true });
      expect(queryCalls[0].sql).toContain("enabled");
      expect(queryCalls[0].params).toEqual([true]);
    });

    it("returns empty on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("fail");
      expect(await listScheduledTasks()).toEqual({ tasks: [], total: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // updateScheduledTask
  // -------------------------------------------------------------------------

  describe("updateScheduledTask()", () => {
    it("returns { ok: true } on success", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "task-123" }] });

      const result = await updateScheduledTask("task-123", "u1", { name: "Updated" });
      expect(result).toEqual({ ok: true });
      expect(queryCalls[0].sql).toContain("UPDATE scheduled_tasks");
      expect(queryCalls[0].sql).toContain("name =");
    });

    it("returns { ok: true } when no updates", async () => {
      enableInternalDB();
      const result = await updateScheduledTask("task-123", "u1", {});
      expect(result).toEqual({ ok: true });
      expect(queryCalls.length).toBe(0);
    });

    it("returns { ok: false, reason: 'not_found' } when not found", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      expect(await updateScheduledTask("missing", "u1", { name: "X" })).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      expect(await updateScheduledTask("t", "u1", { name: "X" })).toEqual({ ok: false, reason: "no_db" });
    });

    it("recomputes next_run_at when cron changes", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "task-123" }] });

      await updateScheduledTask("task-123", "u1", { cronExpression: "0 10 * * *" });
      expect(queryCalls[0].sql).toContain("cron_expression");
      expect(queryCalls[0].sql).toContain("next_run_at");
    });

    it("returns error for invalid cron", async () => {
      enableInternalDB();
      const result = await updateScheduledTask("t", "u1", { cronExpression: "bad" });
      expect(result).toEqual({ ok: false, reason: "error" });
    });

    it("returns { ok: false, reason: 'error' } on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("fail");
      expect(await updateScheduledTask("t", "u1", { name: "X" })).toEqual({ ok: false, reason: "error" });
    });
  });

  // -------------------------------------------------------------------------
  // deleteScheduledTask
  // -------------------------------------------------------------------------

  describe("deleteScheduledTask()", () => {
    it("soft deletes by setting enabled=false", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "task-123" }] });

      const result = await deleteScheduledTask("task-123", "u1");
      expect(result).toEqual({ ok: true });
      expect(queryCalls[0].sql).toContain("SET enabled = false");
      expect(queryCalls[0].sql).toContain("owner_id");
    });

    it("returns { ok: false, reason: 'not_found' } when not found", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      expect(await deleteScheduledTask("missing", "u1")).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      expect(await deleteScheduledTask("t")).toEqual({ ok: false, reason: "no_db" });
    });

    it("does not scope by ownerId when not provided", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "task-123" }] });
      await deleteScheduledTask("task-123");
      expect(queryCalls[0].sql).not.toContain("owner_id");
    });
  });

  // -------------------------------------------------------------------------
  // createTaskRun / completeTaskRun / listTaskRuns
  // -------------------------------------------------------------------------

  describe("createTaskRun()", () => {
    it("returns run ID on success", async () => {
      enableInternalDB();
      setResults({ rows: [{ id: "run-456" }] });
      expect(await createTaskRun("task-123")).toBe("run-456");
    });

    it("returns null when no DB", async () => {
      expect(await createTaskRun("task-123")).toBeNull();
    });

    it("returns null on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("fail");
      expect(await createTaskRun("task-123")).toBeNull();
    });
  });

  describe("completeTaskRun()", () => {
    it("fires update query", () => {
      enableInternalDB();
      completeTaskRun("run-123", "success", { tokensUsed: 1500 });
      expect(queryCalls.length).toBe(1);
      expect(queryCalls[0].sql).toContain("UPDATE scheduled_task_runs");
    });

    it("is a no-op when no DB", () => {
      completeTaskRun("run-123", "success");
      expect(queryCalls.length).toBe(0);
    });
  });

  describe("listTaskRuns()", () => {
    it("returns runs", async () => {
      enableInternalDB();
      setResults({ rows: [makeRunRow()] });

      const runs = await listTaskRuns("task-123");
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe("run-123");
      expect(runs[0].status).toBe("success");
      expect(runs[0].tokensUsed).toBe(1500);
    });

    it("returns empty when no DB", async () => {
      expect(await listTaskRuns("task-123")).toEqual([]);
    });

    it("returns empty on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("fail");
      expect(await listTaskRuns("task-123")).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getTasksDueForExecution
  // -------------------------------------------------------------------------

  describe("getTasksDueForExecution()", () => {
    it("returns due tasks", async () => {
      enableInternalDB();
      setResults({ rows: [makeTaskRow()] });
      const tasks = await getTasksDueForExecution();
      expect(tasks).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("enabled = true");
      expect(queryCalls[0].sql).toContain("next_run_at <= now()");
    });

    it("returns empty when no DB", async () => {
      expect(await getTasksDueForExecution()).toEqual([]);
    });

    it("returns empty on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("fail");
      expect(await getTasksDueForExecution()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // lockTaskForExecution
  // -------------------------------------------------------------------------

  describe("lockTaskForExecution()", () => {
    it("returns true when lock acquired", async () => {
      enableInternalDB();
      // First call: SELECT task (getScheduledTask to read cron expression)
      // Second call: UPDATE with atomic lock (next_run_at IS NOT NULL)
      setResults(
        { rows: [makeTaskRow()] },
        { rows: [{ id: "task-123" }] },
      );

      const result = await lockTaskForExecution("task-123");
      expect(result).toBe(true);
      // First query is the SELECT to read cron
      expect(queryCalls[0].sql).toContain("SELECT");
      // Second query is the atomic UPDATE
      expect(queryCalls[1].sql).toContain("UPDATE scheduled_tasks");
      expect(queryCalls[1].sql).toContain("last_run_at = now()");
      expect(queryCalls[1].sql).toContain("next_run_at IS NOT NULL");
    });

    it("returns false when task not found", async () => {
      enableInternalDB();
      // getScheduledTask returns empty
      setResults({ rows: [] });
      expect(await lockTaskForExecution("missing")).toBe(false);
    });

    it("returns false when UPDATE matches no rows (already locked)", async () => {
      enableInternalDB();
      // getScheduledTask succeeds, but UPDATE returns empty (already locked)
      setResults(
        { rows: [makeTaskRow()] },
        { rows: [] },
      );
      expect(await lockTaskForExecution("task-123")).toBe(false);
    });

    it("returns false when no DB", async () => {
      expect(await lockTaskForExecution("task-123")).toBe(false);
    });

    it("returns false on DB error", async () => {
      enableInternalDB();
      queryThrow = new Error("fail");
      expect(await lockTaskForExecution("task-123")).toBe(false);
    });
  });
});

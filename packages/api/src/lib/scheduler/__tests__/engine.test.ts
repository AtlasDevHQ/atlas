/**
 * Unit tests for the scheduler engine.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Mock dependencies before importing
const mockGetTasksDueForExecution = mock((): Promise<unknown[]> => Promise.resolve([]));
const mockLockTaskForExecution = mock((): Promise<boolean> => Promise.resolve(true));
const mockCreateTaskRun = mock((): Promise<string | null> => Promise.resolve("run-123"));
const mockCompleteTaskRun = mock((): void => {});
const mockGetScheduledTask = mock((): Promise<unknown> =>
  Promise.resolve({ ok: true, data: { id: "task-123", question: "Q?", cronExpression: "0 9 * * 1" } }),
);
const mockComputeNextRun = mock((): Date | null => new Date("2025-01-01T09:00:00Z"));

mock.module("@atlas/api/lib/scheduled-tasks", () => ({
  getTasksDueForExecution: mockGetTasksDueForExecution,
  lockTaskForExecution: mockLockTaskForExecution,
  createTaskRun: mockCreateTaskRun,
  completeTaskRun: mockCompleteTaskRun,
  getScheduledTask: mockGetScheduledTask,
  computeNextRun: mockComputeNextRun,
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  internalExecute: mock(() => {}),
}));

const mockExecuteResult = {
  tokensUsed: 1500,
  deliveryAttempted: 1,
  deliverySucceeded: 1,
  deliveryFailed: 0,
};
const mockExecuteScheduledTask = mock(() => Promise.resolve(mockExecuteResult));

mock.module("../executor", () => ({
  executeScheduledTask: mockExecuteScheduledTask,
}));

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({
    scheduler: {
      maxConcurrentTasks: 5,
      taskTimeout: 60_000,
      tickIntervalSeconds: 1,
    },
  }),
}));

const { getScheduler, triggerTask, runTick, _resetScheduler } = await import("../engine");

describe("scheduler engine", () => {
  beforeEach(() => {
    _resetScheduler();
    mockGetTasksDueForExecution.mockReset();
    mockGetTasksDueForExecution.mockResolvedValue([]);
    mockLockTaskForExecution.mockReset();
    mockLockTaskForExecution.mockResolvedValue(true);
    mockCreateTaskRun.mockReset();
    mockCreateTaskRun.mockResolvedValue("run-123");
    mockCompleteTaskRun.mockReset();
    mockExecuteScheduledTask.mockReset();
    mockExecuteScheduledTask.mockResolvedValue(mockExecuteResult);
    mockGetScheduledTask.mockReset();
    mockGetScheduledTask.mockResolvedValue({ ok: true, data: { id: "task-123", question: "Q?", cronExpression: "0 9 * * 1" } });
    mockComputeNextRun.mockReset();
    mockComputeNextRun.mockReturnValue(new Date("2025-01-01T09:00:00Z"));
  });

  afterEach(() => {
    _resetScheduler();
  });

  describe("getScheduler()", () => {
    it("returns a singleton", () => {
      const s1 = getScheduler();
      const s2 = getScheduler();
      expect(s1).toBe(s2);
    });

    it("starts and stops", () => {
      const scheduler = getScheduler();
      expect(scheduler.isRunning()).toBe(false);
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it("start is idempotent", () => {
      const scheduler = getScheduler();
      scheduler.start();
      scheduler.start(); // Should not throw
      expect(scheduler.isRunning()).toBe(true);
    });

    it("stop is idempotent", () => {
      const scheduler = getScheduler();
      scheduler.stop(); // Not running — should not throw
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe("triggerTask()", () => {
    it("executes a task immediately and records token usage", async () => {
      await triggerTask("task-123");
      expect(mockLockTaskForExecution).toHaveBeenCalledWith("task-123");
      expect(mockCreateTaskRun).toHaveBeenCalledWith("task-123");
      expect(mockExecuteScheduledTask).toHaveBeenCalledWith("task-123", "run-123", 60_000);
      expect(mockCompleteTaskRun).toHaveBeenCalledWith("run-123", "success", { tokensUsed: 1500 });
    });

    it("throws when lock fails", async () => {
      mockLockTaskForExecution.mockResolvedValueOnce(false);
      await expect(triggerTask("task-123")).rejects.toThrow("Failed to lock task");
    });

    it("throws when createTaskRun fails", async () => {
      mockCreateTaskRun.mockResolvedValueOnce(null);
      await expect(triggerTask("task-123")).rejects.toThrow("Failed to create run record");
    });

    it("marks run as failed on execution error", async () => {
      mockExecuteScheduledTask.mockRejectedValueOnce(new Error("boom"));
      await expect(triggerTask("task-123")).rejects.toThrow("boom");
      expect(mockCompleteTaskRun).toHaveBeenCalledWith("run-123", "failed", { error: "boom" });
    });
  });

  describe("runTick()", () => {
    it("returns zero counts when no tasks are due", async () => {
      mockGetTasksDueForExecution.mockResolvedValueOnce([]);
      const result = await runTick();
      expect(result).toEqual({
        tasksFound: 0,
        tasksDispatched: 0,
        tasksCompleted: 0,
        tasksFailed: 0,
      });
      expect(result.error).toBeUndefined();
    });

    it("awaits completion and returns correct counts", async () => {
      mockGetTasksDueForExecution.mockResolvedValueOnce([
        { id: "t1" },
        { id: "t2" },
      ]);
      const result = await runTick();
      expect(result).toEqual({
        tasksFound: 2,
        tasksDispatched: 2,
        tasksCompleted: 2,
        tasksFailed: 0,
      });
      expect(mockExecuteScheduledTask).toHaveBeenCalledTimes(2);
    });

    it("counts execution failures in tasksFailed", async () => {
      mockGetTasksDueForExecution.mockResolvedValueOnce([{ id: "t1" }]);
      mockExecuteScheduledTask.mockRejectedValueOnce(new Error("boom"));
      const result = await runTick();
      expect(result).toEqual({
        tasksFound: 1,
        tasksDispatched: 1,
        tasksCompleted: 0,
        tasksFailed: 1,
      });
      expect(mockCompleteTaskRun).toHaveBeenCalledWith("run-123", "failed", { error: "boom" });
    });

    it("skips tasks that fail to lock (not counted as failure)", async () => {
      mockGetTasksDueForExecution.mockResolvedValueOnce([{ id: "t1" }, { id: "t2" }]);
      mockLockTaskForExecution
        .mockResolvedValueOnce(false) // t1 — lock fails
        .mockResolvedValueOnce(true); // t2 — lock succeeds
      const result = await runTick();
      expect(result).toEqual({
        tasksFound: 2,
        tasksDispatched: 1,
        tasksCompleted: 1,
        tasksFailed: 0,
      });
    });

    it("respects maxConcurrentTasks limit", async () => {
      // Config mock returns maxConcurrentTasks: 5, but we send 7 tasks
      mockGetTasksDueForExecution.mockResolvedValueOnce([
        { id: "t1" }, { id: "t2" }, { id: "t3" },
        { id: "t4" }, { id: "t5" }, { id: "t6" }, { id: "t7" },
      ]);
      const result = await runTick();
      expect(result.tasksFound).toBe(7);
      expect(result.tasksDispatched).toBe(5); // capped at maxConcurrentTasks
      expect(mockExecuteScheduledTask).toHaveBeenCalledTimes(5);
      expect(mockLockTaskForExecution).toHaveBeenCalledTimes(5);
    });

    it("surfaces error when getTasksDueForExecution throws", async () => {
      mockGetTasksDueForExecution.mockRejectedValueOnce(new Error("db down"));
      const result = await runTick();
      expect(result.error).toBe("db down");
      expect(result.tasksFound).toBe(0);
      expect(result.tasksDispatched).toBe(0);
    });

    it("counts createTaskRun failure as tasksFailed without executing", async () => {
      mockGetTasksDueForExecution.mockResolvedValueOnce([{ id: "t1" }]);
      mockCreateTaskRun.mockResolvedValueOnce(null);
      const result = await runTick();
      expect(result).toEqual({
        tasksFound: 1,
        tasksDispatched: 1,
        tasksCompleted: 0,
        tasksFailed: 1,
      });
      expect(mockExecuteScheduledTask).not.toHaveBeenCalled();
      expect(mockCompleteTaskRun).not.toHaveBeenCalled();
      // Should attempt to reschedule
      expect(mockGetScheduledTask).toHaveBeenCalledWith("t1");
    });

    it("skips tasks where lockTaskForExecution throws", async () => {
      mockGetTasksDueForExecution.mockResolvedValueOnce([{ id: "t1" }, { id: "t2" }]);
      mockLockTaskForExecution
        .mockRejectedValueOnce(new Error("lock query timeout"))
        .mockResolvedValueOnce(true);
      const result = await runTick();
      expect(result).toEqual({
        tasksFound: 2,
        tasksDispatched: 1,
        tasksCompleted: 1,
        tasksFailed: 0,
      });
    });
  });

  describe("_resetScheduler()", () => {
    it("stops and clears the singleton", () => {
      const s1 = getScheduler();
      s1.start();
      _resetScheduler();
      const s2 = getScheduler();
      expect(s2).not.toBe(s1);
      expect(s2.isRunning()).toBe(false);
    });
  });
});

/**
 * Unit tests for the scheduler executor (Effect.ts migration).
 *
 * Covers: Effect.timeout replacing Promise.race, typed error propagation,
 * delivery status recording.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

const mockGetScheduledTask = mock(() =>
  Promise.resolve({
    ok: true,
    data: {
      id: "task-1",
      question: "What is revenue?",
      recipients: [{ type: "webhook", url: "https://hook.example.com" }],
      deliveryChannel: "webhook",
    },
  }),
);
const mockUpdateRunDeliveryStatus = mock((): void => {});

mock.module("@atlas/api/lib/scheduled-tasks", () => ({
  getScheduledTask: mockGetScheduledTask,
  updateRunDeliveryStatus: mockUpdateRunDeliveryStatus,
  getTasksDueForExecution: mock(() => Promise.resolve([])),
  lockTaskForExecution: mock(() => Promise.resolve(true)),
  createTaskRun: mock(() => Promise.resolve("run-1")),
  completeTaskRun: mock(() => {}),
  computeNextRun: mock(() => null),
  validateCronExpression: mock(() => ({ valid: true })),
  listScheduledTasks: mock(() => Promise.resolve({ tasks: [], total: 0 })),
  updateScheduledTask: mock(() => Promise.resolve({ ok: true })),
  deleteScheduledTask: mock(() => Promise.resolve({ ok: true })),
  listTaskRuns: mock(() => Promise.resolve([])),
  listAllRuns: mock(() => Promise.resolve({ runs: [], total: 0 })),
  _resetScheduledTasksForTest: mock(() => {}),
}));

const mockAgentResult = {
  answer: "Revenue is $1M",
  sql: ["SELECT SUM(revenue)"],
  data: [{ columns: ["total"], rows: [{ total: 1000000 }] }],
  steps: 2,
  usage: { totalTokens: 800 },
};

let agentQueryDelay = 0;
const mockExecuteAgentQuery = mock(() => {
  if (agentQueryDelay > 0) {
    return new Promise((resolve) => setTimeout(() => resolve(mockAgentResult), agentQueryDelay));
  }
  return Promise.resolve(mockAgentResult);
});

mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mockExecuteAgentQuery,
}));

const mockDeliverResult = mock(() =>
  Promise.resolve({ attempted: 1, succeeded: 1, failed: 0 }),
);

mock.module("../delivery", () => ({
  deliverResult: mockDeliverResult,
}));

const { executeScheduledTask } = await import("../executor");

describe("executor", () => {
  beforeEach(() => {
    agentQueryDelay = 0;
    mockGetScheduledTask.mockReset();
    mockGetScheduledTask.mockResolvedValue({
      ok: true,
      data: {
        id: "task-1",
        question: "What is revenue?",
        recipients: [{ type: "webhook", url: "https://hook.example.com" }],
        deliveryChannel: "webhook",
      },
    });
    mockExecuteAgentQuery.mockReset();
    mockExecuteAgentQuery.mockImplementation(() => {
      if (agentQueryDelay > 0) {
        return new Promise((resolve) => setTimeout(() => resolve(mockAgentResult), agentQueryDelay));
      }
      return Promise.resolve(mockAgentResult);
    });
    mockDeliverResult.mockReset();
    mockDeliverResult.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
    mockUpdateRunDeliveryStatus.mockReset();
  });

  it("executes task and returns result with delivery counts", async () => {
    const result = await executeScheduledTask("task-1", "run-1", 30_000);
    expect(result.tokensUsed).toBe(800);
    expect(result.deliveryAttempted).toBe(1);
    expect(result.deliverySucceeded).toBe(1);
    expect(result.deliveryFailed).toBe(0);
    expect(mockExecuteAgentQuery).toHaveBeenCalledTimes(1);
  });

  it("throws when task is not found", async () => {
    mockGetScheduledTask.mockResolvedValueOnce({ ok: false } as unknown as Awaited<ReturnType<typeof mockGetScheduledTask>>);
    await expect(executeScheduledTask("bad-id", "run-1", 30_000)).rejects.toThrow("Task not found");
  });

  it("marks delivery as sent on full success", async () => {
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockUpdateRunDeliveryStatus).toHaveBeenCalledWith("run-1", "pending");
    expect(mockUpdateRunDeliveryStatus).toHaveBeenCalledWith("run-1", "sent");
  });

  it("marks delivery as failed on full failure", async () => {
    mockDeliverResult.mockResolvedValueOnce({ attempted: 2, succeeded: 0, failed: 2 });
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockUpdateRunDeliveryStatus).toHaveBeenCalledWith("run-1", "failed", "All 2 deliveries failed");
  });

  it("marks delivery as failed on partial failure", async () => {
    mockDeliverResult.mockResolvedValueOnce({ attempted: 3, succeeded: 1, failed: 2 });
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockUpdateRunDeliveryStatus).toHaveBeenCalledWith("run-1", "failed", "Partial failure: 2/3 deliveries failed");
  });

  it("skips delivery status when no recipients attempted", async () => {
    mockDeliverResult.mockResolvedValueOnce({ attempted: 0, succeeded: 0, failed: 0 });
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockUpdateRunDeliveryStatus).not.toHaveBeenCalled();
  });

  it("throws SchedulerTaskTimeoutError when agent exceeds timeout", async () => {
    agentQueryDelay = 500;
    await expect(executeScheduledTask("task-1", "run-1", 50)).rejects.toThrow(
      /timed out/i,
    );
  });

  it("propagates agent execution errors", async () => {
    mockExecuteAgentQuery.mockRejectedValueOnce(new Error("Agent crashed"));
    await expect(executeScheduledTask("task-1", "run-1", 30_000)).rejects.toThrow(
      /Agent crashed/,
    );
  });
});

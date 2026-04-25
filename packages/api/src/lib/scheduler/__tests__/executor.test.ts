/**
 * Unit tests for the scheduler executor (Effect.ts migration).
 *
 * Covers: Effect.timeout replacing Promise.race, typed error propagation,
 * delivery status recording, and the F-54 actor-binding + approval-required
 * regression tests.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

const mockGetScheduledTask = mock(() =>
  Promise.resolve({
    ok: true,
    data: {
      id: "task-1",
      ownerId: "user-1",
      orgId: "org-1",
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

type ActorUserLike = {
  id: string;
  mode: "managed";
  label: string;
  role: "admin";
  activeOrganizationId: string;
};
const mockLoadActorUser = mock<(userId: string, orgId: string | null) => Promise<ActorUserLike | null>>(() =>
  Promise.resolve({
    id: "user-1",
    mode: "managed",
    label: "user-1@example.com",
    role: "admin",
    activeOrganizationId: "org-1",
  }),
);

mock.module("@atlas/api/lib/auth/actor", () => ({
  loadActorUser: mockLoadActorUser,
  botActorUser: mock(() => ({ id: "slack-bot:T1", mode: "simple-key", label: "slack-bot:T1" })),
}));

const mockAgentResult = {
  answer: "Revenue is $1M",
  sql: ["SELECT SUM(revenue)"],
  data: [{ columns: ["total"], rows: [{ total: 1000000 }] }],
  steps: 2,
  usage: { totalTokens: 800 },
};

let agentQueryDelay = 0;
type AgentResultLike = typeof mockAgentResult & {
  pendingApproval?: { requestId: string; ruleName: string; matchedRules: string[]; message: string };
};
let agentResultOverride: AgentResultLike | null = null;
type ExecuteAgentQueryOptionsLike = {
  actor?: { id: string; activeOrganizationId?: string };
  priorMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  conversationId?: string;
};
const mockExecuteAgentQuery = mock<(question: string, requestId?: string, options?: ExecuteAgentQueryOptionsLike) => Promise<AgentResultLike>>(() => {
  const result = agentResultOverride ?? mockAgentResult;
  if (agentQueryDelay > 0) {
    return new Promise<AgentResultLike>((resolve) => setTimeout(() => resolve(result), agentQueryDelay));
  }
  return Promise.resolve(result);
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
    agentResultOverride = null;
    mockGetScheduledTask.mockReset();
    mockGetScheduledTask.mockResolvedValue({
      ok: true,
      data: {
        id: "task-1",
        ownerId: "user-1",
        orgId: "org-1",
        question: "What is revenue?",
        recipients: [{ type: "webhook", url: "https://hook.example.com" }],
        deliveryChannel: "webhook",
      },
    });
    mockLoadActorUser.mockReset();
    mockLoadActorUser.mockResolvedValue({
      id: "user-1",
      mode: "managed",
      label: "user-1@example.com",
      role: "admin",
      activeOrganizationId: "org-1",
    });
    mockExecuteAgentQuery.mockReset();
    mockExecuteAgentQuery.mockImplementation(() => {
      const result = agentResultOverride ?? mockAgentResult;
      if (agentQueryDelay > 0) {
        return new Promise((resolve) => setTimeout(() => resolve(result), agentQueryDelay));
      }
      return Promise.resolve(result);
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

  // ── F-54 regression tests ──────────────────────────────────────────

  it("F-54: resolves the task creator and binds them as the agent actor", async () => {
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockLoadActorUser).toHaveBeenCalledWith("user-1", "org-1");
    expect(mockExecuteAgentQuery).toHaveBeenCalledTimes(1);
    const calls = mockExecuteAgentQuery.mock.calls;
    // executeAgentQuery(question, requestId, options) — options.actor must
    // carry the resolved user so checkApprovalRequired sees the orgId.
    const opts = calls[0][2] as { actor?: { id: string; activeOrganizationId?: string } } | undefined;
    expect(opts?.actor?.id).toBe("user-1");
    expect(opts?.actor?.activeOrganizationId).toBe("org-1");
  });

  it("F-54: refuses to run when the task creator can't be resolved (deleted user)", async () => {
    mockLoadActorUser.mockResolvedValueOnce(null);
    await expect(executeScheduledTask("task-1", "run-1", 30_000)).rejects.toThrow(
      /could not be resolved/,
    );
    expect(mockExecuteAgentQuery).not.toHaveBeenCalled();
    expect(mockDeliverResult).not.toHaveBeenCalled();
  });

  it("F-54: when an approval rule matches, the run fails with a clear message and skips delivery", async () => {
    agentResultOverride = {
      ...mockAgentResult,
      pendingApproval: {
        requestId: "approval-req-42",
        ruleName: "Block PII reads",
        matchedRules: ["Block PII reads"],
        message: "This query requires approval before execution.",
      },
    };
    await expect(executeScheduledTask("task-1", "run-1", 30_000)).rejects.toThrow(
      /Approval required: Block PII reads.*approval-req-42/,
    );
    expect(mockDeliverResult).not.toHaveBeenCalled();
    expect(mockUpdateRunDeliveryStatus).not.toHaveBeenCalled();
  });
});

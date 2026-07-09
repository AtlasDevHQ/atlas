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
      connectionId: "legacy-connection",
      connectionGroupId: "group-1",
      question: "What is revenue?",
      recipients: [{ type: "webhook", url: "https://hook.example.com" }],
      deliveryChannel: "webhook",
    },
  }),
);
const mockUpdateRunDeliveryStatus = mock((): void => {});

void mock.module("@atlas/api/lib/scheduled-tasks", () => ({
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

void mock.module("@atlas/api/lib/auth/actor", () => ({
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
  connectionId?: string;
  connectionGroupId?: string;
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

void mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mockExecuteAgentQuery,
}));

const mockDeliverResult = mock(() =>
  Promise.resolve({ attempted: 1, succeeded: 1, failed: 0, permanentFailures: 0, firstPermanentError: null as string | null }),
);

void mock.module("../delivery", () => ({
  deliverResult: mockDeliverResult,
}));

const mockResolveScheduledTaskConnection = mock(() => Promise.resolve("resolved-connection"));

// Stub mirrors the real error class so executor.ts's
// `err instanceof NoScheduledTaskGroupMembersError` check stays compilable
// under the mocked module. None of the tests in this file exercise the
// empty-group path — `executor.empty-group.test.ts` covers that against
// the real group-resolve module.
class NoScheduledTaskGroupMembersErrorStub extends Error {
  override readonly name = "NoScheduledTaskGroupMembersError";
  readonly groupId: string;
  readonly orgId: string | null;
  constructor(groupId: string, orgId: string | null) {
    super(`stub: group ${groupId} (org=${orgId ?? "__global__"}) empty`);
    this.groupId = groupId;
    this.orgId = orgId;
  }
}

void mock.module("../group-resolve", () => ({
  resolveScheduledTaskConnection: mockResolveScheduledTaskConnection,
  NoScheduledTaskGroupMembersError: NoScheduledTaskGroupMembersErrorStub,
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
        connectionId: "legacy-connection",
        connectionGroupId: "group-1",
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
    mockDeliverResult.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0, permanentFailures: 0, firstPermanentError: null });
    mockUpdateRunDeliveryStatus.mockReset();
    mockResolveScheduledTaskConnection.mockReset();
    mockResolveScheduledTaskConnection.mockResolvedValue("resolved-connection");
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

  it("marks delivery as failed on full transient failure", async () => {
    mockDeliverResult.mockResolvedValueOnce({ attempted: 2, succeeded: 0, failed: 2, permanentFailures: 0, firstPermanentError: null });
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockUpdateRunDeliveryStatus).toHaveBeenCalledWith("run-1", "failed", "All 2 deliveries failed");
  });

  it("marks delivery as failed on partial failure", async () => {
    mockDeliverResult.mockResolvedValueOnce({ attempted: 3, succeeded: 1, failed: 2, permanentFailures: 0, firstPermanentError: null });
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockUpdateRunDeliveryStatus).toHaveBeenCalledWith("run-1", "failed", "Partial failure: 2/3 deliveries failed");
  });

  // ── #3379: permanent-failure surfacing ─────────────────────────────

  it("marks delivery as failed_permanent when ALL failures are permanent (#3379)", async () => {
    mockDeliverResult.mockResolvedValueOnce({
      attempted: 2,
      succeeded: 0,
      failed: 2,
      permanentFailures: 2,
      firstPermanentError: "No email delivery backend configured (configure a platform email provider or set RESEND_API_KEY)",
    });
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockUpdateRunDeliveryStatus).toHaveBeenCalledWith(
      "run-1",
      "failed_permanent",
      "All 2 deliveries failed — No email delivery backend configured (configure a platform email provider or set RESEND_API_KEY)",
    );
  });

  it("keeps plain failed when failures are mixed permanent + transient (#3379)", async () => {
    mockDeliverResult.mockResolvedValueOnce({
      attempted: 3,
      succeeded: 0,
      failed: 3,
      permanentFailures: 1,
      firstPermanentError: "Blocked URL",
    });
    await executeScheduledTask("task-1", "run-1", 30_000);
    // Mixed → a retry may still help, so NOT failed_permanent; the first
    // permanent error is still appended for context.
    expect(mockUpdateRunDeliveryStatus).toHaveBeenCalledWith(
      "run-1",
      "failed",
      "All 3 deliveries failed — Blocked URL",
    );
  });

  it("marks failed_permanent on partial success when every failure is permanent (#3379)", async () => {
    mockDeliverResult.mockResolvedValueOnce({
      attempted: 3,
      succeeded: 1,
      failed: 2,
      permanentFailures: 2,
      firstPermanentError: "No Slack bot token",
    });
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockUpdateRunDeliveryStatus).toHaveBeenCalledWith(
      "run-1",
      "failed_permanent",
      "Partial failure: 2/3 deliveries failed — No Slack bot token",
    );
  });

  // ── #3420: billing enforcement blocks ──────────────────────────────

  it("records a billing block on the run with the user-safe reason and never delivers (#3420)", async () => {
    const { BillingBlockedError } = await import("@atlas/api/lib/billing/agent-gate");
    mockExecuteAgentQuery.mockImplementationOnce(() =>
      Promise.reject(
        new BillingBlockedError({
          allowed: false,
          errorCode: "trial_expired",
          errorMessage:
            "Your free trial has expired. Upgrade to a paid plan to continue using Atlas.",
          httpStatus: 403,
          retryable: false,
        }),
      ),
    );
    // The thrown message is what engine.ts records on the run row via
    // completeTaskRun(runId, "failed", { error }) — it must name billing
    // enforcement AND carry the user-safe reason so the task owner sees
    // exactly why the run was blocked in run history.
    const promise = executeScheduledTask("task-1", "run-1", 30_000);
    await expect(promise).rejects.toThrow(/Blocked by billing enforcement/);
    await expect(promise).rejects.toThrow(/trial has expired/);
    expect(mockDeliverResult).not.toHaveBeenCalled();
    expect(mockUpdateRunDeliveryStatus).not.toHaveBeenCalled();
  });

  it("records a claim-required block on the run with the claim reason (#3651)", async () => {
    const { ClaimRequiredError } = await import("@atlas/api/lib/billing/claim-gate");
    mockExecuteAgentQuery.mockImplementationOnce(() =>
      Promise.reject(new ClaimRequiredError("https://app.example.test/claim")),
    );
    const promise = executeScheduledTask("task-1", "run-1", 30_000);
    await expect(promise).rejects.toThrow(/Workspace not yet claimed \[claim_required\]/);
    expect(mockDeliverResult).not.toHaveBeenCalled();
    expect(mockUpdateRunDeliveryStatus).not.toHaveBeenCalled();
  });

  it("labels a transient claim-check failure on the run for parity (#3803)", async () => {
    const { ClaimCheckFailedError } = await import("@atlas/api/lib/billing/claim-gate");
    mockExecuteAgentQuery.mockImplementationOnce(() =>
      Promise.reject(new ClaimCheckFailedError()),
    );
    // A fail-closed 503 claim-status lookup failure: the run must be recorded
    // failed with the labeled, user-safe reason (parity with query/chat paths)
    // rather than an unattributed error. The next tick retries.
    const promise = executeScheduledTask("task-1", "run-1", 30_000);
    await expect(promise).rejects.toThrow(/Claim status check failed \[claim_check_failed\]/);
    expect(mockDeliverResult).not.toHaveBeenCalled();
    expect(mockUpdateRunDeliveryStatus).not.toHaveBeenCalled();
  });

  it("skips delivery status when no recipients attempted", async () => {
    mockDeliverResult.mockResolvedValueOnce({ attempted: 0, succeeded: 0, failed: 0, permanentFailures: 0, firstPermanentError: null });
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

  it("resolves the group member once and runs the agent against that connection", async () => {
    await executeScheduledTask("task-1", "run-1", 30_000);
    expect(mockResolveScheduledTaskConnection).toHaveBeenCalledWith({
      taskId: "task-1",
      orgId: "org-1",
      connectionGroupId: "group-1",
    });
    const opts = mockExecuteAgentQuery.mock.calls[0][2];
    expect(opts?.connectionId).toBe("resolved-connection");
    expect(opts?.connectionGroupId).toBe("group-1");
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

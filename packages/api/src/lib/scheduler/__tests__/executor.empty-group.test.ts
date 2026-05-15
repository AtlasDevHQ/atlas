/**
 * Executor empty-group test (#2416).
 *
 * Pair with `executor.test.ts`, which mocks `../group-resolve` to keep the
 * existing tests focused on executor behavior. This file is intentionally
 * separate so we can run executor against the REAL `loadScheduledTaskGroupSnapshot`
 * — `mock.module()` is file-scoped in `bun:test`, so we can't selectively
 * unmock the group-resolve module for a single test within `executor.test.ts`.
 *
 * The contract being verified: when a tenant's connection group has zero
 * non-archived members, the executor must log + skip the tick without firing
 * the agent. No SQL must touch the `__global__` org for a tenant caller —
 * that was the pre-#2416 silent cross-tenant boundary leak this fix closes.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";

// ── Mocks: everything EXCEPT ../group-resolve ────────────────────────

const mockGetScheduledTask = mock(() =>
  Promise.resolve({
    ok: true,
    data: {
      id: "task-1",
      ownerId: "user-1",
      orgId: "org-1",
      connectionId: null,
      connectionGroupId: "g_prod",
      question: "What is revenue?",
      recipients: [],
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
  botActorUser: mock(() => ({ id: "bot", mode: "simple-key", label: "bot" })),
}));

// Agent + delivery are mocked purely so we can assert NOT-called.
const mockExecuteAgentQuery = mock(() => Promise.resolve({
  answer: "should never run",
  sql: [],
  data: [],
  steps: 0,
  usage: { totalTokens: 0 },
}));
mock.module("@atlas/api/lib/agent-query", () => ({
  executeAgentQuery: mockExecuteAgentQuery,
}));

const mockDeliverResult = mock(() =>
  Promise.resolve({ attempted: 0, succeeded: 0, failed: 0 }),
);
mock.module("../delivery", () => ({
  deliverResult: mockDeliverResult,
}));

// NOTE: ../group-resolve intentionally NOT mocked.

// ── Mock internal pool — captures every SQL call ─────────────────────

interface CapturedQuery {
  readonly sql: string;
  readonly params?: unknown[];
}

let queryCalls: CapturedQuery[] = [];
let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
let queryResultIndex = 0;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    const result = queryResults[queryResultIndex] ?? { rows: [] };
    queryResultIndex++;
    return result;
  },
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

const origDbUrl = process.env.DATABASE_URL;

const { executeScheduledTask } = await import("../executor");

beforeEach(() => {
  queryCalls = [];
  queryResults = [];
  queryResultIndex = 0;
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);

  mockGetScheduledTask.mockReset();
  mockGetScheduledTask.mockResolvedValue({
    ok: true,
    data: {
      id: "task-1",
      ownerId: "user-1",
      orgId: "org-1",
      connectionId: null,
      connectionGroupId: "g_prod",
      question: "What is revenue?",
      recipients: [],
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
  mockDeliverResult.mockReset();
  mockUpdateRunDeliveryStatus.mockReset();
});

afterEach(() => {
  if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  _resetPool(null);
});

describe("executor — empty connection group (#2416)", () => {
  it("when the tenant's group has zero non-archived members, the executor throws WITHOUT firing the agent and WITHOUT crossing into __global__", async () => {
    // Real loadScheduledTaskGroupSnapshot runs against this mock pool.
    // First query: connection_groups row exists (tenant owns the group).
    // Second query: zero non-archived members (every connection archived).
    queryResults = [
      { rows: [{ primary_connection_id: null }] },
      { rows: [] },
    ];
    queryResultIndex = 0;

    await expect(executeScheduledTask("task-1", "run-1", 30_000)).rejects.toThrow(
      /no non-archived members/i,
    );

    // The agent must NOT have been invoked. This is the multi-tenant
    // isolation guarantee — pre-#2416 the executor would silently fire
    // the agent against a __global__ connection here.
    expect(mockExecuteAgentQuery).not.toHaveBeenCalled();
    expect(mockDeliverResult).not.toHaveBeenCalled();
    expect(mockUpdateRunDeliveryStatus).not.toHaveBeenCalled();

    // Real SQL path was exercised — exactly the two scoped queries ran
    // (group row + member rows), both bound to org-1, never __global__.
    expect(queryCalls.length).toBe(2);
    for (const call of queryCalls) {
      expect(call.params).toContain("org-1");
      expect(call.params).not.toContain("__global__");
      expect(call.sql).not.toContain("'__global__'");
    }
  });
});

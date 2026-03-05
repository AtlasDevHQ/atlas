/**
 * Unit tests for the webhook formatter.
 */
import { describe, it, expect } from "bun:test";
import { formatWebhookPayload } from "../format-webhook";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-123",
    ownerId: "u1",
    name: "Daily Revenue",
    question: "What was yesterday's revenue?",
    cronExpression: "0 9 * * 1",
    deliveryChannel: "webhook",
    recipients: [],
    connectionId: null,
    approvalMode: "auto",
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeResult(overrides: Partial<AgentQueryResult> = {}): AgentQueryResult {
  return {
    answer: "Revenue was $1M",
    sql: ["SELECT SUM(revenue) FROM orders"],
    data: [{ columns: ["total"], rows: [{ total: 1000000 }] }],
    steps: 3,
    usage: { totalTokens: 1500 },
    ...overrides,
  };
}

describe("formatWebhookPayload", () => {
  it("includes all required fields", () => {
    const payload = formatWebhookPayload(makeTask(), makeResult());
    expect(payload.taskId).toBe("task-123");
    expect(payload.taskName).toBe("Daily Revenue");
    expect(payload.question).toBe("What was yesterday's revenue?");
    expect(payload.answer).toBe("Revenue was $1M");
    expect(payload.sql).toEqual(["SELECT SUM(revenue) FROM orders"]);
    expect(payload.data).toHaveLength(1);
    expect(payload.steps).toBe(3);
    expect(payload.usage.totalTokens).toBe(1500);
    expect(payload.timestamp).toBeDefined();
  });

  it("includes ISO timestamp", () => {
    const payload = formatWebhookPayload(makeTask(), makeResult());
    expect(() => new Date(payload.timestamp)).not.toThrow();
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles empty answer", () => {
    const payload = formatWebhookPayload(makeTask(), makeResult({ answer: "" }));
    expect(payload.answer).toBe("");
  });

  it("handles empty data", () => {
    const payload = formatWebhookPayload(makeTask(), makeResult({ data: [] }));
    expect(payload.data).toEqual([]);
  });

  it("preserves full data without truncation", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const payload = formatWebhookPayload(
      makeTask(),
      makeResult({ data: [{ columns: ["id"], rows }] }),
    );
    expect(payload.data[0].rows.length).toBe(100);
  });
});

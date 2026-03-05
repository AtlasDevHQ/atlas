/**
 * Unit tests for the email formatter.
 */
import { describe, it, expect } from "bun:test";
import { formatEmailReport } from "../format-email";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-123",
    ownerId: "u1",
    name: "Daily Revenue",
    question: "What was yesterday's revenue?",
    cronExpression: "0 9 * * 1",
    deliveryChannel: "email",
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

describe("formatEmailReport", () => {
  it("produces subject and body", () => {
    const { subject, body } = formatEmailReport(makeTask(), makeResult());
    expect(subject).toBe("Atlas Report: Daily Revenue");
    expect(body).toContain("Daily Revenue");
    expect(body).toContain("Revenue was $1M");
  });

  it("includes data table", () => {
    const { body } = formatEmailReport(makeTask(), makeResult());
    expect(body).toContain("<table");
    expect(body).toContain("total");
    expect(body).toContain("1000000");
  });

  it("includes SQL", () => {
    const { body } = formatEmailReport(makeTask(), makeResult());
    expect(body).toContain("SELECT SUM(revenue)");
  });

  it("includes metadata footer", () => {
    const { body } = formatEmailReport(makeTask(), makeResult());
    expect(body).toContain("3 steps");
    expect(body).toContain("1,500 tokens");
  });

  it("handles empty answer", () => {
    const { body } = formatEmailReport(makeTask(), makeResult({ answer: "" }));
    expect(body).toContain("No answer generated.");
  });

  it("handles empty data", () => {
    const { body } = formatEmailReport(makeTask(), makeResult({ data: [] }));
    expect(body).not.toContain("<table");
  });

  it("handles empty SQL", () => {
    const { body } = formatEmailReport(makeTask(), makeResult({ sql: [] }));
    expect(body).not.toContain("<pre");
  });

  it("escapes HTML in task name", () => {
    const task = makeTask({ name: "Test <script>alert(1)</script>" });
    const { body } = formatEmailReport(task, makeResult());
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("truncates large data tables", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, value: `row-${i}` }));
    const { body } = formatEmailReport(
      makeTask(),
      makeResult({ data: [{ columns: ["id", "value"], rows }] }),
    );
    expect(body).toContain("Showing first 50");
  });
});

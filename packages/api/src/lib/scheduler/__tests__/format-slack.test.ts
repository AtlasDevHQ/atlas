/**
 * Unit tests for the Slack formatter.
 */
import { describe, it, expect } from "bun:test";
import { formatSlackReport } from "../format-slack";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-123",
    ownerId: "u1",
    name: "Daily Revenue",
    question: "What was yesterday's revenue?",
    cronExpression: "0 9 * * 1",
    deliveryChannel: "slack",
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

describe("formatSlackReport", () => {
  it("produces text and blocks", () => {
    const { text, blocks } = formatSlackReport(makeTask(), makeResult());
    expect(text).toContain("Daily Revenue");
    expect(blocks.length).toBeGreaterThan(1);
  });

  it("includes header block with task name", () => {
    const { blocks } = formatSlackReport(makeTask(), makeResult());
    const header = blocks[0];
    expect(header.type).toBe("section");
    if ("text" in header) {
      expect(header.text.text).toContain("*Daily Revenue*");
    }
  });

  it("includes answer from formatQueryResponse", () => {
    const { blocks } = formatSlackReport(makeTask(), makeResult());
    const answerBlock = blocks.find(
      (b) => b.type === "section" && "text" in b && b.text.text.includes("Revenue was $1M"),
    );
    expect(answerBlock).toBeDefined();
  });

  it("includes question in header", () => {
    const { blocks } = formatSlackReport(makeTask(), makeResult());
    if ("text" in blocks[0]) {
      expect(blocks[0].text.text).toContain("yesterday's revenue");
    }
  });

  it("truncates long questions", () => {
    const longQuestion = "a".repeat(300);
    const { blocks } = formatSlackReport(makeTask({ question: longQuestion }), makeResult());
    if ("text" in blocks[0]) {
      expect(blocks[0].text.text.length).toBeLessThan(350);
    }
  });
});

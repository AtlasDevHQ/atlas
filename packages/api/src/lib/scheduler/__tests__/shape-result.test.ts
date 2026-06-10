/**
 * Unit tests for the shared delivery shaping module — truncation,
 * metadata, and dataset ordering, asserted without rendering.
 */
import { describe, it, expect } from "bun:test";
import { shapeResult, MAX_DATA_ROWS } from "../shape-result";
import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-123",
    ownerId: "u1",
    orgId: null,
    name: "Daily Revenue",
    question: "What was yesterday's revenue?",
    cronExpression: "0 9 * * 1",
    deliveryChannel: "email",
    recipients: [],
    connectionGroupId: null,
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

function makeRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ id: i }));
}

describe("shapeResult", () => {
  it("carries task and result metadata", () => {
    const shaped = shapeResult(makeTask(), makeResult());
    expect(shaped.taskId).toBe("task-123");
    expect(shaped.taskName).toBe("Daily Revenue");
    expect(shaped.question).toBe("What was yesterday's revenue?");
    expect(shaped.answer).toBe("Revenue was $1M");
    expect(shaped.sql).toEqual(["SELECT SUM(revenue) FROM orders"]);
    expect(shaped.steps).toBe(3);
    expect(shaped.totalTokens).toBe(1500);
  });

  it("stamps a single ISO timestamp", () => {
    const shaped = shapeResult(makeTask(), makeResult());
    expect(shaped.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => new Date(shaped.generatedAt)).not.toThrow();
  });

  it("passes the raw answer through without fallback copy", () => {
    const shaped = shapeResult(makeTask(), makeResult({ answer: "" }));
    expect(shaped.answer).toBe("");
  });

  it("keeps datasets at or below the limit untruncated", () => {
    const shaped = shapeResult(
      makeTask(),
      makeResult({ data: [{ columns: ["id"], rows: makeRows(MAX_DATA_ROWS) }] }),
    );
    expect(shaped.datasets[0]!.rows).toHaveLength(MAX_DATA_ROWS);
    expect(shaped.datasets[0]!.totalRows).toBe(MAX_DATA_ROWS);
    expect(shaped.datasets[0]!.truncated).toBe(false);
  });

  it("truncates datasets one row over the limit", () => {
    const shaped = shapeResult(
      makeTask(),
      makeResult({ data: [{ columns: ["id"], rows: makeRows(MAX_DATA_ROWS + 1) }] }),
    );
    expect(shaped.datasets[0]!.rows).toHaveLength(MAX_DATA_ROWS);
    expect(shaped.datasets[0]!.totalRows).toBe(MAX_DATA_ROWS + 1);
    expect(shaped.datasets[0]!.truncated).toBe(true);
  });

  it("keeps the first MAX_DATA_ROWS rows in order", () => {
    const shaped = shapeResult(
      makeTask(),
      makeResult({ data: [{ columns: ["id"], rows: makeRows(100) }] }),
    );
    const rows = shaped.datasets[0]!.rows;
    expect(rows[0]).toEqual({ id: 0 });
    expect(rows[MAX_DATA_ROWS - 1]).toEqual({ id: MAX_DATA_ROWS - 1 });
    expect(shaped.datasets[0]!.totalRows).toBe(100);
  });

  it("truncates each dataset independently and preserves dataset order", () => {
    const shaped = shapeResult(
      makeTask(),
      makeResult({
        data: [
          { columns: ["a"], rows: makeRows(100) },
          { columns: ["b"], rows: makeRows(2) },
        ],
      }),
    );
    expect(shaped.datasets).toHaveLength(2);
    expect(shaped.datasets[0]!.columns).toEqual(["a"]);
    expect(shaped.datasets[0]!.truncated).toBe(true);
    expect(shaped.datasets[1]!.columns).toEqual(["b"]);
    expect(shaped.datasets[1]!.rows).toHaveLength(2);
    expect(shaped.datasets[1]!.truncated).toBe(false);
  });

  it("preserves empty datasets for renderers that include them", () => {
    const shaped = shapeResult(
      makeTask(),
      makeResult({ data: [{ columns: [], rows: [] }] }),
    );
    expect(shaped.datasets).toHaveLength(1);
    expect(shaped.datasets[0]!.totalRows).toBe(0);
    expect(shaped.datasets[0]!.truncated).toBe(false);
  });

  it("does not mutate the source result rows", () => {
    const rows = makeRows(100);
    shapeResult(makeTask(), makeResult({ data: [{ columns: ["id"], rows }] }));
    expect(rows).toHaveLength(100);
  });
});

/**
 * Unit tests for the shared delivery shaping module — truncation,
 * metadata, and dataset ordering, asserted without rendering.
 */
import { describe, it, expect } from "bun:test";
import { shapeResult, DEFAULT_DELIVERY_MAX_ROWS } from "../shape-result";
import { makeTask, makeResult } from "./fixtures";

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
      makeResult({ data: [{ columns: ["id"], rows: makeRows(DEFAULT_DELIVERY_MAX_ROWS) }] }),
    );
    expect(shaped.datasets[0]!.rows).toHaveLength(DEFAULT_DELIVERY_MAX_ROWS);
    expect(shaped.datasets[0]!.totalRows).toBe(DEFAULT_DELIVERY_MAX_ROWS);
    expect(shaped.datasets[0]!.truncated).toBe(false);
  });

  it("truncates datasets one row over the limit", () => {
    const shaped = shapeResult(
      makeTask(),
      makeResult({ data: [{ columns: ["id"], rows: makeRows(DEFAULT_DELIVERY_MAX_ROWS + 1) }] }),
    );
    expect(shaped.datasets[0]!.rows).toHaveLength(DEFAULT_DELIVERY_MAX_ROWS);
    expect(shaped.datasets[0]!.totalRows).toBe(DEFAULT_DELIVERY_MAX_ROWS + 1);
    expect(shaped.datasets[0]!.truncated).toBe(true);
  });

  it("keeps the first maxRows rows in order", () => {
    const shaped = shapeResult(
      makeTask(),
      makeResult({ data: [{ columns: ["id"], rows: makeRows(100) }] }),
    );
    const rows = shaped.datasets[0]!.rows;
    expect(rows[0]).toEqual({ id: 0 });
    expect(rows[DEFAULT_DELIVERY_MAX_ROWS - 1]).toEqual({ id: DEFAULT_DELIVERY_MAX_ROWS - 1 });
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

  it("respects an ATLAS_DELIVERY_MAX_ROWS override", () => {
    const prev = process.env.ATLAS_DELIVERY_MAX_ROWS;
    process.env.ATLAS_DELIVERY_MAX_ROWS = "10";
    try {
      const shaped = shapeResult(
        makeTask(),
        makeResult({ data: [{ columns: ["id"], rows: makeRows(20) }] }),
      );
      expect(shaped.datasets[0]!.rows).toHaveLength(10);
      expect(shaped.datasets[0]!.totalRows).toBe(20);
      expect(shaped.datasets[0]!.truncated).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ATLAS_DELIVERY_MAX_ROWS;
      else process.env.ATLAS_DELIVERY_MAX_ROWS = prev;
    }
  });

  it("falls back to the default on an invalid override", () => {
    const prev = process.env.ATLAS_DELIVERY_MAX_ROWS;
    process.env.ATLAS_DELIVERY_MAX_ROWS = "not-a-number";
    try {
      const shaped = shapeResult(
        makeTask(),
        makeResult({ data: [{ columns: ["id"], rows: makeRows(DEFAULT_DELIVERY_MAX_ROWS + 1) }] }),
      );
      expect(shaped.datasets[0]!.rows).toHaveLength(DEFAULT_DELIVERY_MAX_ROWS);
      expect(shaped.datasets[0]!.truncated).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ATLAS_DELIVERY_MAX_ROWS;
      else process.env.ATLAS_DELIVERY_MAX_ROWS = prev;
    }
  });
});

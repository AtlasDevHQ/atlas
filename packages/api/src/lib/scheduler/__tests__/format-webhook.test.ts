/**
 * Unit tests for the webhook formatter.
 */
import { describe, it, expect } from "bun:test";
import { formatWebhookPayload } from "../format-webhook";
import { shapeResult } from "../shape-result";
import { makeTask, makeResult } from "./fixtures";

describe("formatWebhookPayload", () => {
  it("includes all required fields", () => {
    const payload = formatWebhookPayload(shapeResult(makeTask(), makeResult()));
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
    const payload = formatWebhookPayload(shapeResult(makeTask(), makeResult()));
    expect(() => new Date(payload.timestamp)).not.toThrow();
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles empty answer", () => {
    const payload = formatWebhookPayload(shapeResult(makeTask(), makeResult({ answer: "" })));
    expect(payload.answer).toBe("");
  });

  it("handles empty data", () => {
    const payload = formatWebhookPayload(shapeResult(makeTask(), makeResult({ data: [] })));
    expect(payload.data).toEqual([]);
  });

  it("caps datasets at the shared row limit and signals truncation", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const payload = formatWebhookPayload(shapeResult(makeTask(),
      makeResult({ data: [{ columns: ["id"], rows }] })));
    expect(payload.data[0].rows.length).toBe(50);
    expect(payload.data[0].totalRows).toBe(100);
    expect(payload.data[0].truncated).toBe(true);
  });

  it("does not flag untruncated datasets", () => {
    const payload = formatWebhookPayload(shapeResult(makeTask(), makeResult()));
    expect(payload.data[0].totalRows).toBe(1);
    expect(payload.data[0].truncated).toBe(false);
  });
});

/**
 * Unit tests for the three scheduled-delivery formatters — `format-email.ts`,
 * `format-slack.ts` and `format-webhook.ts` — each fed the same
 * `shapeResult(task, result)` shape from the shared fixtures.
 *
 * Formerly `format-email.test.ts`, `format-slack.test.ts` and
 * `format-webhook.test.ts`.
 */
import { describe, it, expect } from "bun:test";
import { formatEmailReport } from "../format-email";
import { formatSlackReport } from "../format-slack";
import { formatWebhookPayload } from "../format-webhook";
import { shapeResult } from "../shape-result";
import { makeTask, makeResult } from "./fixtures";

describe("formatEmailReport", () => {
  it("produces subject and body", () => {
    const { subject, body } = formatEmailReport(shapeResult(makeTask(), makeResult()));
    expect(subject).toBe("Atlas Report: Daily Revenue");
    expect(body).toContain("Daily Revenue");
    expect(body).toContain("Revenue was $1M");
  });

  it("includes data table", () => {
    const { body } = formatEmailReport(shapeResult(makeTask(), makeResult()));
    expect(body).toContain("<table");
    expect(body).toContain("total");
    expect(body).toContain("1000000");
  });

  it("includes SQL", () => {
    const { body } = formatEmailReport(shapeResult(makeTask(), makeResult()));
    expect(body).toContain("SELECT SUM(revenue)");
  });

  it("includes metadata footer", () => {
    const { body } = formatEmailReport(shapeResult(makeTask(), makeResult()));
    expect(body).toContain("3 steps");
    expect(body).toContain("1,500 tokens");
  });

  it("handles empty answer", () => {
    const { body } = formatEmailReport(shapeResult(makeTask(), makeResult({ answer: "" })));
    expect(body).toContain("No answer generated.");
  });

  it("handles empty data", () => {
    const { body } = formatEmailReport(shapeResult(makeTask(), makeResult({ data: [] })));
    expect(body).not.toContain("<table");
  });

  it("handles empty SQL", () => {
    const { body } = formatEmailReport(shapeResult(makeTask(), makeResult({ sql: [] })));
    expect(body).not.toContain("<pre");
  });

  it("escapes HTML in task name", () => {
    const task = makeTask({ name: "Test <script>alert(1)</script>" });
    const { body } = formatEmailReport(shapeResult(task, makeResult()));
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("truncates large data tables", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, value: `row-${i}` }));
    const { body } = formatEmailReport(shapeResult(makeTask(),
      makeResult({ data: [{ columns: ["id", "value"], rows }] })));
    expect(body).toContain("Showing first 50");
  });
});

describe("formatSlackReport", () => {
  it("produces text and blocks", () => {
    const { text, blocks } = formatSlackReport(shapeResult(makeTask(), makeResult()));
    expect(text).toContain("Daily Revenue");
    expect(blocks.length).toBeGreaterThan(1);
  });

  it("includes header block with task name", () => {
    const { blocks } = formatSlackReport(shapeResult(makeTask(), makeResult()));
    const header = blocks[0];
    expect(header.type).toBe("section");
    if ("text" in header) {
      expect(header.text.text).toContain("*Daily Revenue*");
    }
  });

  it("includes answer from formatQueryResponse", () => {
    const { blocks } = formatSlackReport(shapeResult(makeTask(), makeResult()));
    const answerBlock = blocks.find(
      (b) => b.type === "section" && "text" in b && b.text.text.includes("Revenue was $1M"),
    );
    expect(answerBlock).toBeDefined();
  });

  it("includes question in header", () => {
    const { blocks } = formatSlackReport(shapeResult(makeTask(), makeResult()));
    if ("text" in blocks[0]) {
      expect(blocks[0].text.text).toContain("yesterday's revenue");
    }
  });

  it("truncates long questions", () => {
    const longQuestion = "a".repeat(300);
    const { blocks } = formatSlackReport(shapeResult(makeTask({ question: longQuestion }), makeResult()));
    if ("text" in blocks[0]) {
      expect(blocks[0].text.text.length).toBeLessThan(350);
    }
  });
});

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

/**
 * Unit tests for the email formatter.
 */
import { describe, it, expect } from "bun:test";
import { formatEmailReport } from "../format-email";
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

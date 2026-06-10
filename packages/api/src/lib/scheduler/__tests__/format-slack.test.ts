/**
 * Unit tests for the Slack formatter.
 */
import { describe, it, expect } from "bun:test";
import { formatSlackReport } from "../format-slack";
import { shapeResult } from "../shape-result";
import { makeTask, makeResult } from "./fixtures";

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

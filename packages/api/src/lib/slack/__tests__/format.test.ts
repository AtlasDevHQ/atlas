/**
 * Tests for Slack Block Kit formatter.
 */

import { describe, it, expect } from "bun:test";
import {
  formatQueryResponse,
  formatErrorResponse,
  formatActionApproval,
  formatActionResult,
  type SlackQueryResult,
  type SlackBlock,
} from "../format";
import type { PendingAction } from "@atlas/api/lib/agent-query";

/** Helper: extract text from a section block */
function blockText(block: SlackBlock): string {
  if (block.type === "section") return block.text.text;
  return "";
}

/** Helper: extract context element texts */
function contextTexts(block: SlackBlock): string[] {
  if (block.type === "context") return block.elements.map((e) => e.text);
  return [];
}

function makeResult(overrides: Partial<SlackQueryResult> = {}): SlackQueryResult {
  return {
    answer: "There were 1,234 active users last month.",
    sql: ["SELECT COUNT(*) FROM users WHERE active = true"],
    data: [
      {
        columns: ["count"],
        rows: [{ count: 1234 }],
      },
    ],
    steps: 3,
    usage: { totalTokens: 5000 },
    ...overrides,
  };
}

describe("formatQueryResponse", () => {
  it("formats a complete query response with answer, SQL, and data", () => {
    const blocks = formatQueryResponse(makeResult());

    expect(blocks.length).toBeGreaterThanOrEqual(3); // answer + SQL + data + context
    expect(blocks[0].type).toBe("section");
    expect(blockText(blocks[0])).toContain("1,234 active users");

    // SQL block
    expect(blockText(blocks[1])).toContain("```");
    expect(blockText(blocks[1])).toContain("SELECT COUNT(*)");

    // Context block (last)
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe("context");
    expect(contextTexts(last)[0]).toContain("3 steps");
    expect(contextTexts(last)[0]).toContain("5,000 tokens");
  });

  it("handles missing SQL gracefully", () => {
    const blocks = formatQueryResponse(makeResult({ sql: [] }));
    const sqlBlocks = blocks.filter(
      (b) => blockText(b).includes("```") && blockText(b).includes("SQL"),
    );
    expect(sqlBlocks.length).toBe(0);
  });

  it("handles empty data gracefully", () => {
    const blocks = formatQueryResponse(makeResult({ data: [] }));
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blockText(blocks[0])).toContain("active users");
  });

  it("handles missing answer with default text", () => {
    const blocks = formatQueryResponse(makeResult({ answer: "" }));
    expect(blockText(blocks[0])).toContain("No answer generated");
  });

  it("truncates large data tables", () => {
    const manyRows = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: `User ${i}`,
      email: `user${i}@example.com`,
    }));

    const blocks = formatQueryResponse(
      makeResult({
        data: [
          {
            columns: ["id", "name", "email"],
            rows: manyRows as Record<string, unknown>[],
          },
        ],
      }),
    );

    const dataBlock = blocks.find(
      (b) => blockText(b).includes("```") && !blockText(b).includes("SQL"),
    );
    expect(dataBlock).toBeDefined();
    expect(blockText(dataBlock!)).toContain("Showing first");
  });

  it("stays within 50 block limit", () => {
    const manyDatasets = Array.from({ length: 60 }, () => ({
      columns: ["col"],
      rows: [{ col: "value" }],
    }));

    const blocks = formatQueryResponse(makeResult({ data: manyDatasets }));
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it("truncates long answer text to 3000 chars", () => {
    const longAnswer = "A".repeat(4000);
    const blocks = formatQueryResponse(makeResult({ answer: longAnswer }));
    expect(blockText(blocks[0]).length).toBeLessThanOrEqual(3000);
    expect(blockText(blocks[0])).toEndWith("...");
  });
});

describe("formatErrorResponse", () => {
  it("formats an error message", () => {
    const blocks = formatErrorResponse("Something went wrong");
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("section");
    expect(blockText(blocks[0])).toContain("Something went wrong");
    expect(blockText(blocks[0])).toContain(":warning:");
  });

  it("truncates long error messages", () => {
    const longError = "E".repeat(500);
    const blocks = formatErrorResponse(longError);
    expect(blockText(blocks[0]).length).toBeLessThan(300);
  });
});

/** Helper: build a PendingAction for tests */
function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: "act_123",
    type: "executeSQL",
    target: "SELECT 1",
    summary: "Run a test query",
    ...overrides,
  };
}

describe("formatActionApproval", () => {
  it("returns a section block and an actions block with two buttons", () => {
    const blocks = formatActionApproval(makeAction());
    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe("section");
    expect(blocks[1].type).toBe("actions");
    if (blocks[1].type === "actions") {
      expect(blocks[1].elements.length).toBe(2);
    }
  });

  it("approve button has correct action_id and value", () => {
    const action = makeAction({ id: "act_abc" });
    const blocks = formatActionApproval(action);
    const actionsBlock = blocks[1];
    if (actionsBlock.type === "actions") {
      const approve = actionsBlock.elements[0];
      expect(approve.action_id).toBe("atlas_action_approve");
      expect(approve.value).toBe("act_abc");
      expect(approve.style).toBe("primary");
    }
  });

  it("deny button has correct action_id and value", () => {
    const action = makeAction({ id: "act_xyz" });
    const blocks = formatActionApproval(action);
    const actionsBlock = blocks[1];
    if (actionsBlock.type === "actions") {
      const deny = actionsBlock.elements[1];
      expect(deny.action_id).toBe("atlas_action_deny");
      expect(deny.value).toBe("act_xyz");
      expect(deny.style).toBe("danger");
    }
  });

  it("falls back to action.type when summary is empty", () => {
    const blocks = formatActionApproval(makeAction({ summary: "", type: "executeSQL" }));
    expect(blockText(blocks[0])).toContain("executeSQL");
    expect(blockText(blocks[0])).not.toContain("\n\n");
  });

  it("truncates very long summaries", () => {
    const longSummary = "S".repeat(4000);
    const blocks = formatActionApproval(makeAction({ summary: longSummary }));
    expect(blockText(blocks[0]).length).toBeLessThanOrEqual(3000);
  });
});

describe("formatActionResult", () => {
  it("executed status produces check mark emoji", () => {
    const blocks = formatActionResult(makeAction(), "executed");
    expect(blockText(blocks[0])).toContain(":white_check_mark:");
    expect(blockText(blocks[0])).toContain("executed");
  });

  it("denied status produces no_entry_sign emoji", () => {
    const blocks = formatActionResult(makeAction(), "denied");
    expect(blockText(blocks[0])).toContain(":no_entry_sign:");
    expect(blockText(blocks[0])).toContain("denied");
  });

  it("failed status produces x emoji", () => {
    const blocks = formatActionResult(makeAction(), "failed");
    expect(blockText(blocks[0])).toContain(":x:");
    expect(blockText(blocks[0])).toContain("failed");
  });

  it("appends error text when provided", () => {
    const blocks = formatActionResult(makeAction(), "failed", "Connection timed out");
    expect(blockText(blocks[0])).toContain("Connection timed out");
  });

  it("truncates very long error text", () => {
    const longError = "E".repeat(500);
    const blocks = formatActionResult(makeAction(), "failed", longError);
    const text = blockText(blocks[0]);
    // Error portion truncated to 200 chars (plus "..." = 203 max)
    expect(text.length).toBeLessThan(500);
    expect(text).toContain("...");
  });

  it("falls back to action.type when summary is empty", () => {
    const blocks = formatActionResult(makeAction({ summary: "", type: "executeSQL" }), "executed");
    expect(blockText(blocks[0])).toContain("executeSQL");
  });
});

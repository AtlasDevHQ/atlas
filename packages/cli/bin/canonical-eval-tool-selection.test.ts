/**
 * Tool-selection grader contract for the MCP tool-description audit
 * (#2075). Pure-function tests on `gradeToolSelection` and
 * `loadToolSelectionFixture` — the dispatch loop is exercised live in
 * the `eval-mcp-llm` CI job behind the same key gate as
 * `canonical-eval-mcp-llm.evalspec.ts`.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, afterEach } from "bun:test";

import {
  gradeToolSelection,
  loadToolSelectionFixture,
  type ToolSelectionFixture,
  type ToolSelectionFixtureItem,
} from "./canonical-eval-tool-selection";

const tmpFiles: string[] = [];

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.unlinkSync(f);
    } catch (err) {
      // intentionally ignored: cleanup best-effort, the OS reclaims tmpdirs.
      void err;
    }
  }
});

function tmp(name: string, body: string): string {
  const p = path.join(os.tmpdir(), `atlas-tool-selection-${Date.now()}-${name}`);
  fs.writeFileSync(p, body, "utf-8");
  tmpFiles.push(p);
  return p;
}

const ITEM: ToolSelectionFixtureItem = {
  id: "list-tables",
  prompt: "Show me what tables exist.",
  expected_tool: "listEntities",
};

describe("gradeToolSelection", () => {
  it("passes when the first tool call equals expected_tool", () => {
    const out = gradeToolSelection(ITEM, ["listEntities"], 123);
    expect(out.passed).toBe(true);
    expect(out.firstTool).toBe("listEntities");
    expect(out.expected).toEqual(["listEntities"]);
    expect(out.latencyMs).toBe(123);
  });

  it("passes when the first tool call is in expected_alternates", () => {
    const item: ToolSelectionFixtureItem = {
      ...ITEM,
      id: "metric-or-sql",
      expected_tool: "runMetric",
      expected_alternates: ["executeSQL"],
    };
    const out = gradeToolSelection(item, ["executeSQL"], 50);
    expect(out.passed).toBe(true);
    expect(out.expected).toEqual(["runMetric", "executeSQL"]);
  });

  it("fails when the LLM picks a different tool first", () => {
    const out = gradeToolSelection(ITEM, ["explore"], 88);
    expect(out.passed).toBe(false);
    expect(out.firstTool).toBe("explore");
    expect(out.toolSequence).toEqual(["explore"]);
  });

  it("fails when the LLM never called any tool", () => {
    const out = gradeToolSelection(ITEM, [], 12);
    expect(out.passed).toBe(false);
    expect(out.firstTool).toBeNull();
  });

  it("only looks at the first tool, even when later tools are correct", () => {
    // The audit's whole point is that the FIRST decision is what
    // tool-description quality drives — recovery to the right tool
    // after a wrong first dispatch is a different signal.
    const out = gradeToolSelection(ITEM, ["explore", "listEntities"], 200);
    expect(out.passed).toBe(false);
    expect(out.firstTool).toBe("explore");
  });
});

describe("loadToolSelectionFixture", () => {
  it("loads a well-formed fixture", () => {
    const fixture: ToolSelectionFixture = {
      description: "test",
      rubric: { acceptance_floor: 0.9 },
      items: [ITEM],
    };
    const p = tmp("ok.json", JSON.stringify(fixture));
    const loaded = loadToolSelectionFixture(p);
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0]?.expected_tool).toBe("listEntities");
    expect(loaded.rubric?.acceptance_floor).toBe(0.9);
  });

  it("throws when the file is missing", () => {
    expect(() => loadToolSelectionFixture("/nonexistent/path.json")).toThrow(
      /not found/,
    );
  });

  it("throws when the file is not valid JSON", () => {
    const p = tmp("bad.json", "not-json");
    expect(() => loadToolSelectionFixture(p)).toThrow(/Failed to parse/);
  });

  it("throws when items[] is missing or empty", () => {
    const p = tmp("empty.json", JSON.stringify({ items: [] }));
    expect(() => loadToolSelectionFixture(p)).toThrow(/no `items`/);
  });

  it("throws when an item is missing required fields", () => {
    const p = tmp(
      "missing.json",
      JSON.stringify({ items: [{ id: "x", prompt: "y" }] }),
    );
    expect(() => loadToolSelectionFixture(p)).toThrow(/expected_tool/);
  });

  it("throws on malformed expected_alternates", () => {
    const p = tmp(
      "bad-alts.json",
      JSON.stringify({
        items: [
          {
            id: "x",
            prompt: "y",
            expected_tool: "listEntities",
            expected_alternates: "not-an-array",
          },
        ],
      }),
    );
    expect(() => loadToolSelectionFixture(p)).toThrow(/expected_alternates/);
  });

  it("loads the production fixture without error", () => {
    const productionPath = path.resolve(
      __dirname,
      "../../..",
      "eval",
      "canonical-questions",
      "tool-selection.json",
    );
    const loaded = loadToolSelectionFixture(productionPath);
    expect(loaded.items.length).toBeGreaterThanOrEqual(4);
    for (const item of loaded.items) {
      expect(item.id).toBeTruthy();
      expect(item.prompt).toBeTruthy();
      expect(item.expected_tool).toBeTruthy();
    }
  });
});

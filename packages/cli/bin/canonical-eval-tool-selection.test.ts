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

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "ai";

import {
  __forTesting__,
  gradeToolSelection,
  loadToolSelectionFixture,
  type ToolSelectionFixture,
  type ToolSelectionFixtureItem,
} from "./canonical-eval-tool-selection";

const tmpFiles: string[] = [];

afterEach(() => {
  // `force: true` swallows ENOENT (test removed it) and ENOTDIR — every
  // other error is the kind of cleanup failure we'd rather see in CI
  // output than silently mask.
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
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

// ── bindToolsForRecording contract ────────────────────────────────────

describe("bindToolsForRecording", () => {
  // The grader walks the recorder array — this binder's invariants are:
  //   1. Tool name lands in the recorder BEFORE the dispatch awaits, so
  //      a transport throw still leaves the name visible (the audit's
  //      whole point is what the LLM PICKED, not whether dispatch
  //      succeeded).
  //   2. MCP error envelopes flow back to the model as data (so it can
  //      recover via `code`/`hint`), not thrown.
  //   3. Unparseable MCP results surface as `{ error: "unparseable", raw }`
  //      rather than crashing the binder.

  function fakeResult(text: string, isError = false): CallToolResult {
    return {
      content: [{ type: "text" as const, text }],
      isError,
    };
  }

  function getRunner(set: Record<string, Tool>, name: string) {
    const tool = set[name];
    if (!tool || typeof tool.execute !== "function") {
      throw new Error(`tool ${name} not bound or has no execute`);
    }
    return tool.execute;
  }

  it("records the tool name and returns ok data when callTool succeeds", async () => {
    const recorder: string[] = [];
    const fakeClient = {
      callTool: async () =>
        fakeResult(JSON.stringify({ count: 3, entities: [] })),
    };
    const tools = __forTesting__.bindToolsForRecording(
      fakeClient,
      [{ name: "listEntities", description: "List entities." }],
      recorder,
    );
    const runner = getRunner(tools as Record<string, Tool>, "listEntities");
    const result = (await runner({}, { toolCallId: "t1", messages: [] })) as {
      count?: number;
    };
    expect(result.count).toBe(3);
    expect(recorder).toEqual(["listEntities"]);
  });

  it("returns the error envelope (does NOT throw) when callTool returns an MCP error", async () => {
    const recorder: string[] = [];
    const fakeClient = {
      callTool: async () =>
        fakeResult(
          JSON.stringify({ code: "unknown_metric", message: "no such metric" }),
          true,
        ),
    };
    const tools = __forTesting__.bindToolsForRecording(
      fakeClient,
      [{ name: "runMetric", description: "Run a metric." }],
      recorder,
    );
    const runner = getRunner(tools as Record<string, Tool>, "runMetric");
    const result = (await runner({ id: "x" }, { toolCallId: "t1", messages: [] })) as {
      code?: string;
    };
    expect(result.code).toBe("unknown_metric");
    expect(recorder).toEqual(["runMetric"]);
  });

  it("returns an unparseable shape when MCP content isn't JSON", async () => {
    const recorder: string[] = [];
    const fakeClient = {
      callTool: async () => fakeResult("not-json", false),
    };
    const tools = __forTesting__.bindToolsForRecording(
      fakeClient,
      [{ name: "explore", description: "Explore." }],
      recorder,
    );
    const runner = getRunner(tools as Record<string, Tool>, "explore");
    const result = (await runner(
      { command: "ls" },
      { toolCallId: "t1", messages: [] },
    )) as { error?: string; raw?: string };
    expect(result.error).toBe("unparseable");
    expect(result.raw).toBe("not-json");
    expect(recorder).toEqual(["explore"]);
  });

  it("records the tool name BEFORE awaiting dispatch (transport throw still leaves name visible)", async () => {
    // This is the load-bearing contract: the grader scores by FIRST
    // tool selected, regardless of whether the dispatch resolved. If a
    // future refactor moved `recorder.push` after `await client.callTool`,
    // a transport throw would silently drop the name from the recorder
    // and the grader would mis-score the item as `firstTool: null`.
    const recorder: string[] = [];
    const fakeClient = {
      callTool: async () => {
        throw new Error("socket hang up");
      },
    };
    const tools = __forTesting__.bindToolsForRecording(
      fakeClient,
      [{ name: "describeEntity", description: "Describe." }],
      recorder,
    );
    const runner = getRunner(tools as Record<string, Tool>, "describeEntity");
    let threw = false;
    try {
      await runner({ name: "orders" }, { toolCallId: "t1", messages: [] });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(recorder).toEqual(["describeEntity"]);
  });
});

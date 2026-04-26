import { describe, test, expect, spyOn } from "bun:test";
import type { SharedConversation, SharedMessage } from "../../app/shared/lib";
import { resolveCells, toUIMessage } from "../../app/report/[token]/report-cells";

// ---------------------------------------------------------------------------
// toUIMessage
// ---------------------------------------------------------------------------

describe("toUIMessage", () => {
  test("converts string content to a text part", () => {
    const msg: SharedMessage = { role: "user", content: "hello", createdAt: "2026-01-01" };
    const result = toUIMessage(msg, "msg-1");
    expect(result.id).toBe("msg-1");
    expect(result.role).toBe("user");
    expect(result.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  test("converts array content with text parts", () => {
    const msg: SharedMessage = {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      createdAt: "2026-01-01",
    };
    const result = toUIMessage(msg, "msg-2");
    expect(result.parts).toEqual([{ type: "text", text: "answer" }]);
  });

  test("converts array content with tool-invocation parts", () => {
    const msg: SharedMessage = {
      role: "assistant",
      content: [
        {
          type: "tool-invocation",
          toolCallId: "tc-1",
          toolName: "executeSQL",
          args: { sql: "SELECT 1" },
          result: { success: true, columns: ["?column?"], rows: [{ "?column?": 1 }] },
        },
      ],
      createdAt: "2026-01-01",
    };
    const result = toUIMessage(msg, "msg-3");
    expect(result.parts).toHaveLength(1);
    const part = result.parts[0] as Record<string, unknown>;
    expect(part.type).toBe("tool-invocation");
    expect(part.toolName).toBe("executeSQL");
    expect(part.toolCallId).toBe("tc-1");
    expect(part.state).toBe("output-available");
  });

  test("generates fallback toolCallId when missing", () => {
    const msg: SharedMessage = {
      role: "assistant",
      content: [{ type: "tool-invocation", toolName: "explore", args: {} }],
      createdAt: "2026-01-01",
    };
    const result = toUIMessage(msg, "msg-4");
    const part = result.parts[0] as Record<string, unknown>;
    expect(part.toolCallId).toBe("tool-msg-4-0");
  });

  test("filters out unrecognized part types", () => {
    const msg: SharedMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "reasoning", reasoning: "thinking..." },
        { type: "step-start" },
      ],
      createdAt: "2026-01-01",
    };
    const result = toUIMessage(msg, "msg-5");
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toEqual({ type: "text", text: "hi" });
  });

  test("returns empty parts for non-string non-array content with warning", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const msg: SharedMessage = { role: "user", content: 42, createdAt: "2026-01-01" };
    const result = toUIMessage(msg, "msg-6");
    expect(result.parts).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  test("returns empty parts for null content without warning", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const msg: SharedMessage = { role: "user", content: null, createdAt: "2026-01-01" };
    const result = toUIMessage(msg, "msg-7");
    expect(result.parts).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// resolveCells
// ---------------------------------------------------------------------------

function makeConvo(
  messages: SharedMessage[],
  notebookState: SharedConversation["notebookState"] = null,
): SharedConversation {
  return {
    title: "Test",
    surface: "notebook",
    createdAt: "2026-01-01",
    messages,
    notebookState,
  };
}

function userMsg(text: string): SharedMessage {
  return { role: "user", content: text, createdAt: "2026-01-01" };
}

function assistantMsg(text: string): SharedMessage {
  return { role: "assistant", content: text, createdAt: "2026-01-01" };
}

describe("resolveCells", () => {
  test("returns empty array for no messages", () => {
    const cells = resolveCells(makeConvo([]));
    expect(cells).toEqual([]);
  });

  test("builds query cells from user-assistant pairs", () => {
    const cells = resolveCells(makeConvo([userMsg("q1"), assistantMsg("a1"), userMsg("q2"), assistantMsg("a2")]));
    expect(cells).toHaveLength(2);
    expect(cells[0].type).toBe("query");
    expect(cells[0].number).toBe(1);
    expect(cells[1].number).toBe(2);
    const c1 = cells[0] as { type: "query"; assistantMessage: { parts: { text: string }[] } };
    expect(c1.assistantMessage.parts[0].text).toBe("a1");
  });

  test("handles consecutive user messages (no assistant response)", () => {
    const cells = resolveCells(makeConvo([userMsg("q1"), userMsg("q2"), assistantMsg("a2")]));
    expect(cells).toHaveLength(2);
    const c0 = cells[0] as { type: "query"; assistantMessage: unknown };
    const c1 = cells[1] as { type: "query"; assistantMessage: { parts: { text: string }[] } };
    expect(c0.assistantMessage).toBeNull();
    expect(c1.assistantMessage.parts[0].text).toBe("a2");
  });

  test("respects cellOrder from notebookState", () => {
    const cells = resolveCells(
      makeConvo([userMsg("q1"), assistantMsg("a1"), userMsg("q2"), assistantMsg("a2")], {
        version: 3,
        cellOrder: ["cell-2", "cell-1"],
      }),
    );
    expect(cells).toHaveLength(2);
    expect(cells[0].id).toBe("cell-2");
    expect(cells[0].number).toBe(1);
    expect(cells[1].id).toBe("cell-1");
    expect(cells[1].number).toBe(2);
  });

  test("respects collapsed state from cellProps", () => {
    const cells = resolveCells(
      makeConvo([userMsg("q1"), assistantMsg("a1")], {
        version: 3,
        cellProps: { "cell-1": { collapsed: true } },
      }),
    );
    expect(cells[0].collapsed).toBe(true);
  });

  test("includes text cells when cellOrder is present", () => {
    const cells = resolveCells(
      makeConvo([userMsg("q1"), assistantMsg("a1")], {
        version: 3,
        cellOrder: ["text-1", "cell-1"],
        textCells: { "text-1": { content: "# Introduction" } },
      }),
    );
    expect(cells).toHaveLength(2);
    expect(cells[0].type).toBe("text");
    expect(cells[0].id).toBe("text-1");
    const textCell = cells[0] as { type: "text"; content: string };
    expect(textCell.content).toBe("# Introduction");
    expect(cells[1].type).toBe("query");
  });

  test("drops text cells with warning when cellOrder is missing", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const cells = resolveCells(
      makeConvo([userMsg("q1"), assistantMsg("a1")], {
        version: 3,
        textCells: { "text-1": { content: "some text" } },
      }),
    );
    expect(cells).toHaveLength(1);
    expect(cells[0].type).toBe("query");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  test("appends cells not in cellOrder", () => {
    const cells = resolveCells(
      makeConvo([userMsg("q1"), assistantMsg("a1"), userMsg("q2"), assistantMsg("a2")], {
        version: 3,
        cellOrder: ["cell-1"],
      }),
    );
    expect(cells).toHaveLength(2);
    expect(cells[0].id).toBe("cell-1");
    expect(cells[1].id).toBe("cell-2");
  });

  test("skips cellOrder entries that reference non-existent cells", () => {
    const cells = resolveCells(
      makeConvo([userMsg("q1"), assistantMsg("a1")], {
        version: 3,
        cellOrder: ["cell-999", "cell-1"],
      }),
    );
    expect(cells).toHaveLength(1);
    expect(cells[0].id).toBe("cell-1");
    expect(cells[0].number).toBe(1);
  });

  test("filters out system and tool messages", () => {
    const cells = resolveCells(
      makeConvo([
        { role: "system", content: "You are Atlas", createdAt: "2026-01-01" },
        userMsg("q1"),
        { role: "tool", content: { toolCallId: "t1" }, createdAt: "2026-01-01" },
        assistantMsg("a1"),
      ]),
    );
    expect(cells).toHaveLength(1);
  });

  test("renumbers cells sequentially from 1", () => {
    const cells = resolveCells(
      makeConvo([userMsg("q1"), assistantMsg("a1"), userMsg("q2"), assistantMsg("a2"), userMsg("q3"), assistantMsg("a3")]),
    );
    expect(cells.map((c) => c.number)).toEqual([1, 2, 3]);
  });

  test("numbers query cells densely even with interleaved text cells", () => {
    // Without dense numbering, text cells consume sequence indices and the
    // visible query-cell numbers go [2], [4], [5] — looks like a bug.
    const cells = resolveCells(
      makeConvo(
        [userMsg("q1"), assistantMsg("a1"), userMsg("q2"), assistantMsg("a2"), userMsg("q3"), assistantMsg("a3")],
        {
          version: 3,
          cellOrder: ["text-intro", "cell-1", "text-mid", "cell-2", "cell-3", "text-close"],
          textCells: {
            "text-intro": { content: "# Intro" },
            "text-mid": { content: "## Section break" },
            "text-close": { content: "## Closing" },
          },
        },
      ),
    );
    expect(cells).toHaveLength(6);
    const queryNumbers = cells
      .filter((c): c is Extract<typeof c, { type: "query" }> => c.type === "query")
      .map((c) => c.number);
    expect(queryNumbers).toEqual([1, 2, 3]);
  });
});

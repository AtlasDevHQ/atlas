import { describe, expect, test } from "bun:test";
import { extractTextContent, buildCellsFromMessages } from "../use-notebook";
import type { UIMessage } from "@ai-sdk/react";
import type { ResolvedCell } from "../types";

function makeMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],

  };
}

function makeResolvedCell(overrides: Partial<ResolvedCell> = {}): ResolvedCell {
  const userMsg = makeMessage("u1", "user", "test question");
  return {
    id: "cell-u1",
    messageId: "u1",
    number: 1,
    collapsed: false,
    editing: false,
    status: "idle",
    userMessage: userMsg,
    assistantMessage: makeMessage("a1", "assistant", "test answer"),
    ...overrides,
  };
}

describe("extractTextContent", () => {
  test("extracts text from text parts", () => {
    const msg = makeMessage("1", "user", "hello world");
    expect(extractTextContent(msg)).toBe("hello world");
  });

  test("joins multiple text parts with newline", () => {
    const msg: UIMessage = {
      id: "1",
      role: "assistant",
      parts: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
  
    };
    expect(extractTextContent(msg)).toBe("line one\nline two");
  });

  test("returns empty string when message has no text parts", () => {
    const msg: UIMessage = {
      id: "1",
      role: "assistant",
      parts: [],
  
    };
    expect(extractTextContent(msg)).toBe("");
  });

  test("skips non-text parts", () => {
    const msg: UIMessage = {
      id: "1",
      role: "assistant",
      parts: [
        { type: "text", text: "visible" },
        { type: "tool-invocation", toolInvocationId: "t1", toolName: "test", state: "call", args: {} } as unknown as UIMessage["parts"][number],
      ],
  
    };
    expect(extractTextContent(msg)).toBe("visible");
  });
});

describe("ResolvedCell construction", () => {
  test("default cell has correct shape", () => {
    const cell = makeResolvedCell();
    expect(cell.number).toBe(1);
    expect(cell.editing).toBe(false);
    expect(cell.collapsed).toBe(false);
    expect(cell.status).toBe("idle");
    expect(cell.userMessage.role).toBe("user");
    expect(cell.assistantMessage?.role).toBe("assistant");
  });

  test("cell without assistant response", () => {
    const cell = makeResolvedCell({ assistantMessage: null });
    expect(cell.assistantMessage).toBeNull();
  });
});

describe("cell numbering consistency", () => {
  test("numbers are sequential starting at 1", () => {
    const messages: UIMessage[] = [
      makeMessage("u1", "user", "q1"),
      makeMessage("a1", "assistant", "a1"),
      makeMessage("u2", "user", "q2"),
      makeMessage("a2", "assistant", "a2"),
      makeMessage("u3", "user", "q3"),
      makeMessage("a3", "assistant", "a3"),
    ];
    const cells = buildCellsFromMessages(messages);
    expect(cells.map((c) => c.number)).toEqual([1, 2, 3]);
  });
});

import { describe, expect, test } from "bun:test";
import { transformMessages } from "../hooks/use-conversations";
import type { Message } from "../lib/types";

/* ------------------------------------------------------------------ */
/*  transformMessages                                                   */
/* ------------------------------------------------------------------ */

function msg(overrides: Partial<Message> & Pick<Message, "id" | "role">): Message {
  return {
    conversationId: "conv-1",
    content: "",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("transformMessages", () => {
  test("filters out system and tool messages, keeps user and assistant", () => {
    const messages: Message[] = [
      msg({ id: "1", role: "user", content: "hello" }),
      msg({ id: "2", role: "system", content: "you are an analyst" }),
      msg({ id: "3", role: "assistant", content: "hi there" }),
      msg({ id: "4", role: "tool", content: "tool output" }),
      msg({ id: "5", role: "user", content: "question" }),
    ];

    const result = transformMessages(messages);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("preserves message order", () => {
    const messages: Message[] = [
      msg({ id: "a", role: "user", content: "first" }),
      msg({ id: "b", role: "assistant", content: "second" }),
      msg({ id: "c", role: "user", content: "third" }),
    ];

    const result = transformMessages(messages);
    expect(result.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(result.map((m) => (m.parts[0] as { type: "text"; text: string }).text)).toEqual(["first", "second", "third"]);
  });

  test("extracts text from content parts array", () => {
    const messages: Message[] = [
      msg({ id: "1", role: "user", content: [{ type: "text", text: "hello world" }] }),
    ];

    const result = transformMessages(messages);
    expect(result[0].parts).toEqual([{ type: "text", text: "hello world" }]);
  });

  test("extracts multiple text parts from content array", () => {
    const messages: Message[] = [
      msg({ id: "1", role: "assistant", content: [
        { type: "text", text: "first paragraph" },
        { type: "text", text: "second paragraph" },
      ] }),
    ];

    const result = transformMessages(messages);
    expect(result[0].parts).toEqual([
      { type: "text", text: "first paragraph" },
      { type: "text", text: "second paragraph" },
    ]);
  });

  test("filters out non-text parts from content array", () => {
    const messages: Message[] = [
      msg({ id: "1", role: "assistant", content: [
        { type: "text", text: "answer" },
        { type: "tool-invocation", toolName: "executeSQL" },
      ] }),
    ];

    const result = transformMessages(messages);
    expect(result[0].parts).toEqual([{ type: "text", text: "answer" }]);
  });

  test("preserves string content as-is", () => {
    const messages: Message[] = [
      msg({ id: "1", role: "assistant", content: "plain text" }),
    ];

    const result = transformMessages(messages);
    expect((result[0].parts[0] as { type: "text"; text: string }).text).toBe("plain text");
  });

  test("handles empty array", () => {
    const result = transformMessages([]);
    expect(result).toEqual([]);
  });

  test("generates correct parts array with text type", () => {
    const messages: Message[] = [
      msg({ id: "1", role: "user", content: "hello world" }),
    ];

    const result = transformMessages(messages);
    expect(result[0].parts).toEqual([{ type: "text", text: "hello world" }]);
  });
});

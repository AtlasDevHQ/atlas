import { describe, expect, test, spyOn, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import {
  buildCellsFromMessages,
  extractTextContent,
  loadNotebookState,
  migrateNotebookStateKey,
  saveNotebookState,
  truncateMessagesForRerun,
  useNotebook,
  type UseNotebookOptions,
} from "../use-notebook";
import type { UIMessage } from "@ai-sdk/react";
import type { NotebookState } from "../types";

function makeMessage(id: string, role: "user" | "assistant"): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text: `${role} message ${id}` }],

  };
}

describe("buildCellsFromMessages", () => {
  test("pairs user+assistant messages into cells", () => {
    const messages: UIMessage[] = [
      makeMessage("u1", "user"),
      makeMessage("a1", "assistant"),
      makeMessage("u2", "user"),
      makeMessage("a2", "assistant"),
    ];
    const cells = buildCellsFromMessages(messages);
    expect(cells).toHaveLength(2);
    expect(cells[0].number).toBe(1);
    expect(cells[0].messageId).toBe("u1");
    expect(cells[1].number).toBe(2);
    expect(cells[1].messageId).toBe("u2");
  });

  test("handles trailing user message without assistant response", () => {
    const messages: UIMessage[] = [
      makeMessage("u1", "user"),
      makeMessage("a1", "assistant"),
      makeMessage("u2", "user"),
    ];
    const cells = buildCellsFromMessages(messages);
    expect(cells).toHaveLength(2);
    expect(cells[1].messageId).toBe("u2");
  });

  test("returns empty array for no messages", () => {
    const cells = buildCellsFromMessages([]);
    expect(cells).toHaveLength(0);
  });

  test("generates stable position-based cell IDs", () => {
    const messages: UIMessage[] = [
      makeMessage("u1", "user"),
      makeMessage("a1", "assistant"),
      makeMessage("u2", "user"),
    ];
    const cells = buildCellsFromMessages(messages);
    expect(cells.map((c) => c.id)).toEqual(["cell-1", "cell-2"]);
  });

  test("skips non-user/assistant messages", () => {
    const messages = [
      makeMessage("s1", "user"),
      { id: "sys", role: "system" as const, parts: [{ type: "text" as const, text: "system" }] },
      makeMessage("a1", "assistant"),
    ];
    const cells = buildCellsFromMessages(messages as UIMessage[]);
    expect(cells).toHaveLength(1);
    expect(cells[0].messageId).toBe("s1");
  });
});

describe("truncateMessagesForRerun", () => {
  test("truncates at target message ID", () => {
    const messages: UIMessage[] = [
      makeMessage("u1", "user"),
      makeMessage("a1", "assistant"),
      makeMessage("u2", "user"),
      makeMessage("a2", "assistant"),
      makeMessage("u3", "user"),
      makeMessage("a3", "assistant"),
    ];
    const result = truncateMessagesForRerun(messages, "u2");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("u1");
    expect(result[1].id).toBe("a1");
  });

  test("returns empty array when truncating at first message", () => {
    const messages: UIMessage[] = [
      makeMessage("u1", "user"),
      makeMessage("a1", "assistant"),
    ];
    const result = truncateMessagesForRerun(messages, "u1");
    expect(result).toHaveLength(0);
  });

  test("returns all messages when messageId not found", () => {
    const messages: UIMessage[] = [
      makeMessage("u1", "user"),
      makeMessage("a1", "assistant"),
    ];
    const result = truncateMessagesForRerun(messages, "nonexistent");
    expect(result).toHaveLength(2);
  });
});

describe("localStorage persistence", () => {
  test("saveNotebookState and loadNotebookState round-trip", () => {
    const state: NotebookState = {
      conversationId: "test-conv",
      cells: [
        { id: "c1", messageId: "u1", number: 1, collapsed: false, editing: false, status: "idle" },
      ],
      version: 1,
    };

    const store: Record<string, string> = {};
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    } as Storage;

    saveNotebookState(state, mockStorage);
    const loaded = loadNotebookState("test-conv", mockStorage);
    expect(loaded).toEqual(state);
  });

  test("loadNotebookState returns null for missing key", () => {
    const mockStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;

    const loaded = loadNotebookState("missing", mockStorage);
    expect(loaded).toBeNull();
  });

  test("loadNotebookState returns null and warns for corrupt JSON", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const mockStorage = {
      getItem: () => "not valid json{{{",
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;

    const loaded = loadNotebookState("corrupt", mockStorage);
    expect(loaded).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("migrateNotebookStateKey", () => {
  test("migrates state from temp key to real key", () => {
    const state: NotebookState = {
      conversationId: "temp:123",
      cells: [
        { id: "c1", messageId: "u1", number: 1, collapsed: false, editing: false, status: "idle" },
      ],
      version: 1,
    };

    const store: Record<string, string> = {};
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    } as Storage;

    // Save under temp key
    saveNotebookState(state, mockStorage);

    // Migrate
    migrateNotebookStateKey("temp:123", "real-uuid", mockStorage);

    // Old key should be gone
    expect(loadNotebookState("temp:123", mockStorage)).toBeNull();

    // New key should have updated conversationId
    const migrated = loadNotebookState("real-uuid", mockStorage);
    expect(migrated).not.toBeNull();
    expect(migrated!.conversationId).toBe("real-uuid");
    expect(migrated!.cells).toHaveLength(1);
  });

  test("does nothing when temp key does not exist", () => {
    const store: Record<string, string> = {};
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    } as Storage;

    // Should not throw
    migrateNotebookStateKey("temp:missing", "real-uuid", mockStorage);

    // Real key should not exist
    expect(loadNotebookState("real-uuid", mockStorage)).toBeNull();
  });

  test("handles corrupt JSON gracefully and warns", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const store: Record<string, string> = { "atlas:notebook:temp:bad": "not{json" };
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    } as Storage;

    // Should not throw
    migrateNotebookStateKey("temp:bad", "real-uuid", mockStorage);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// buildCellsFromMessages — additional edge cases
// ---------------------------------------------------------------------------

describe("buildCellsFromMessages edge cases", () => {
  test("consecutive user messages without assistant responses", () => {
    const messages: UIMessage[] = [
      makeMessage("u1", "user"),
      makeMessage("u2", "user"),
      makeMessage("u3", "user"),
    ];
    const cells = buildCellsFromMessages(messages);
    expect(cells).toHaveLength(3);
    expect(cells[0].number).toBe(1);
    expect(cells[1].number).toBe(2);
    expect(cells[2].number).toBe(3);
  });

  test("cells default to collapsed=false, editing=false, status=idle", () => {
    const messages: UIMessage[] = [makeMessage("u1", "user")];
    const cells = buildCellsFromMessages(messages);
    expect(cells[0].collapsed).toBe(false);
    expect(cells[0].editing).toBe(false);
    expect(cells[0].status).toBe("idle");
  });

  test("cell IDs use position-based numbering", () => {
    const messages: UIMessage[] = [makeMessage("u1", "user")];
    const cells = buildCellsFromMessages(messages);
    expect(cells[0].id).toBe("cell-1");
  });

  test("only user messages generate cells (assistant-only array)", () => {
    const messages: UIMessage[] = [
      makeMessage("a1", "assistant"),
      makeMessage("a2", "assistant"),
    ];
    const cells = buildCellsFromMessages(messages);
    expect(cells).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// truncateMessagesForRerun — additional edge cases
// ---------------------------------------------------------------------------

describe("truncateMessagesForRerun edge cases", () => {
  test("truncating at assistant message works", () => {
    const messages: UIMessage[] = [
      makeMessage("u1", "user"),
      makeMessage("a1", "assistant"),
      makeMessage("u2", "user"),
    ];
    const result = truncateMessagesForRerun(messages, "a1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("u1");
  });

  test("empty messages array returns empty", () => {
    const result = truncateMessagesForRerun([], "any");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadNotebookState — validation edge cases
// ---------------------------------------------------------------------------

describe("loadNotebookState validation", () => {
  function storageWith(value: string): Storage {
    return {
      getItem: () => value,
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;
  }

  test("accepts version 2", () => {
    const v2 = JSON.stringify({
      conversationId: "c1",
      cells: [],
      version: 2,
    });
    expect(loadNotebookState("c1", storageWith(v2))).not.toBeNull();
  });

  test("returns null when version is unsupported", () => {
    const badVersion = JSON.stringify({
      conversationId: "c1",
      cells: [],
      version: 99,
    });
    expect(loadNotebookState("c1", storageWith(badVersion))).toBeNull();
  });

  test("returns null when version is missing", () => {
    const noVersion = JSON.stringify({
      conversationId: "c1",
      cells: [],
    });
    expect(loadNotebookState("c1", storageWith(noVersion))).toBeNull();
  });

  test("returns null when cells is not an array", () => {
    const badCells = JSON.stringify({
      conversationId: "c1",
      cells: "not-array",
      version: 1,
    });
    expect(loadNotebookState("c1", storageWith(badCells))).toBeNull();
  });

  test("returns null when cells is missing", () => {
    const noCells = JSON.stringify({
      conversationId: "c1",
      version: 1,
    });
    expect(loadNotebookState("c1", storageWith(noCells))).toBeNull();
  });

  test("returns null for stored null literal", () => {
    expect(loadNotebookState("c1", storageWith("null"))).toBeNull();
  });

  test("returns null for stored number", () => {
    expect(loadNotebookState("c1", storageWith("42"))).toBeNull();
  });

  test("returns null for stored string", () => {
    expect(loadNotebookState("c1", storageWith('"just a string"'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// saveNotebookState — error handling
// ---------------------------------------------------------------------------

describe("saveNotebookState error handling", () => {
  test("logs warning when setItem throws", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const state: NotebookState = {
      conversationId: "c1",
      cells: [],
      version: 1,
    };

    const throwingStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => {},
    } as unknown as Storage;

    // Should not throw
    saveNotebookState(state, throwingStorage);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("does not throw when no storage is available", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const state: NotebookState = {
      conversationId: "c1",
      cells: [],
      version: 1,
    };

    // In a real SSR environment, window is undefined and the function exits early.
    // In the test environment (happy-dom), window exists so it falls back to
    // window.localStorage. We verify no error is thrown either way.
    saveNotebookState(state, undefined as unknown as Storage);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// extractTextContent
// ---------------------------------------------------------------------------

describe("extractTextContent", () => {
  test("extracts text from single text part", () => {
    const msg = makeMessage("1", "user");
    expect(extractTextContent(msg)).toBe("user message 1");
  });

  test("returns empty string for empty parts", () => {
    const msg: UIMessage = { id: "1", role: "user", parts: [] };
    expect(extractTextContent(msg)).toBe("");
  });

  test("joins multiple text parts with newline", () => {
    const msg: UIMessage = {
      id: "1",
      role: "user",
      parts: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    expect(extractTextContent(msg)).toBe("first\nsecond");
  });

  test("ignores non-text parts", () => {
    const msg: UIMessage = {
      id: "1",
      role: "assistant",
      parts: [
        { type: "text", text: "visible" },
        {
          type: "tool-invocation",
          toolInvocationId: "t1",
          toolName: "test",
          state: "call",
          args: {},
        } as unknown as UIMessage["parts"][number],
        { type: "text", text: "also visible" },
      ],
    };
    expect(extractTextContent(msg)).toBe("visible\nalso visible");
  });
});

// ---------------------------------------------------------------------------
// useNotebook hook — React hook tests
// ---------------------------------------------------------------------------

type MockChat = UseNotebookOptions["chat"];

function createMockChat(overrides: Partial<MockChat> = {}): MockChat {
  return {
    messages: [],
    status: "ready",
    error: null,
    sendMessage: mock(() => Promise.resolve()),
    setMessages: mock(() => {}),
    ...overrides,
  };
}

describe("useNotebook hook", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  // ---- Cell reconciliation ----

  describe("cell reconciliation", () => {
    test("builds cells from initial messages", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
      ];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells).toHaveLength(2);
      expect(result.current.cells[0].id).toBe("cell-1");
      expect(result.current.cells[1].id).toBe("cell-2");
    });

    test("preserves collapsed/editing state when messages change", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
      ];
      const chat = createMockChat({ messages });
      const { result, rerender } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.toggleCollapse("cell-1");
        result.current.toggleEdit("cell-1");
      });
      expect(result.current.cells[0].collapsed).toBe(true);
      expect(result.current.cells[0].editing).toBe(true);

      // Add a new message pair — cell-1 state should be preserved
      const updatedMessages = [
        ...messages,
        makeMessage("u2", "user"),
        makeMessage("a2", "assistant"),
      ];
      const updatedChat = createMockChat({ messages: updatedMessages });
      rerender({ chat: updatedChat, conversationId: "test" });

      expect(result.current.cells[0].collapsed).toBe(true);
      expect(result.current.cells[0].editing).toBe(true);
      expect(result.current.cells[1].collapsed).toBe(false);
      expect(result.current.cells[1].editing).toBe(false);
    });

    test("starts with empty cells for empty messages", () => {
      const chat = createMockChat();
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells).toHaveLength(0);
    });
  });

  // ---- ResolvedCell construction ----

  describe("ResolvedCell construction", () => {
    test("pairs user messages with following assistant messages", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
      ];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells[0].assistantMessage?.id).toBe("a1");
      expect(result.current.cells[1].assistantMessage).toBeNull();
    });

    test("marks last cell as running when status is not ready", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
      ];
      const chat = createMockChat({ messages, status: "streaming" });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells[0].status).toBe("idle");
      expect(result.current.cells[1].status).toBe("running");
    });

    test("does not mark cells as running when all have responses", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
      ];
      const chat = createMockChat({ messages, status: "streaming" });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells[0].status).toBe("idle");
    });

    test("status transitions from running to idle when response arrives", () => {
      const messages = [makeMessage("u1", "user")];
      const chat = createMockChat({ messages, status: "streaming" });
      const { result, rerender } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells[0].status).toBe("running");

      // Response message arrives and chat status returns to ready
      const updatedMessages = [makeMessage("u1", "user"), makeMessage("a1", "assistant")];
      const updatedChat = createMockChat({ messages: updatedMessages, status: "ready" });
      rerender({ chat: updatedChat, conversationId: "test" });

      expect(result.current.cells[0].status).toBe("idle");
      expect(result.current.cells[0].assistantMessage?.id).toBe("a1");
    });
  });

  // ---- appendCell ----

  describe("appendCell", () => {
    test("clears input and calls sendMessage", () => {
      const chat = createMockChat();
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.setInput("pre-existing text");
      });
      act(() => {
        result.current.appendCell("What is revenue?");
      });

      expect(result.current.input).toBe("");
      expect(chat.sendMessage).toHaveBeenCalledWith({ text: "What is revenue?" });
    });

    test("restores input on sendMessage failure", async () => {
      const chat = createMockChat({
        sendMessage: mock(() => Promise.reject(new Error("Network failure"))),
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.appendCell("What is revenue?");
      });

      await waitFor(() => {
        expect(result.current.input).toBe("What is revenue?");
      });

      errorSpy.mockRestore();
    });

    test("sets warning on sendMessage failure", async () => {
      const chat = createMockChat({
        sendMessage: mock(() => Promise.reject(new Error("API down"))),
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.appendCell("test");
      });

      await waitFor(() => {
        expect(result.current.warning).toBe("Failed to send message. Please try again.");
      });

      errorSpy.mockRestore();
    });
  });

  // ---- rerunCell ----

  describe("rerunCell", () => {
    test("truncates messages at target cell", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
        makeMessage("a2", "assistant"),
      ];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.rerunCell("cell-2", "Updated question");
      });

      expect(chat.setMessages).toHaveBeenCalledWith([messages[0], messages[1]]);
    });

    test("sends question after messages are truncated and status is ready", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
        makeMessage("a2", "assistant"),
      ];
      const sendMessage = mock(() => Promise.resolve());
      const chat = createMockChat({ messages, sendMessage });
      const { result, rerender } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.rerunCell("cell-2", "Updated question");
      });

      // Simulate truncated messages + ready status (triggers pendingRerun effect)
      const truncatedMessages = [messages[0], messages[1]];
      const updatedChat = createMockChat({
        messages: truncatedMessages,
        status: "ready",
        sendMessage,
      });
      rerender({ chat: updatedChat, conversationId: "test" });

      expect(sendMessage).toHaveBeenCalledWith({ text: "Updated question" });
    });

    test("preserves collapsed state through rerun reconciliation", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
        makeMessage("a2", "assistant"),
      ];
      const sendMessage = mock(() => Promise.resolve());
      const chat = createMockChat({ messages, sendMessage });
      const { result, rerender } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      // Collapse cell-1 before rerun
      act(() => {
        result.current.toggleCollapse("cell-1");
      });
      expect(result.current.cells[0].collapsed).toBe(true);

      act(() => {
        result.current.rerunCell("cell-2", "retry");
      });

      // After truncation cell-1 survives reconciliation via preRerunCells fallback
      const truncatedMessages = [messages[0], messages[1]];
      const updatedChat = createMockChat({
        messages: truncatedMessages,
        status: "ready",
        sendMessage,
      });
      rerender({ chat: updatedChat, conversationId: "test" });

      expect(result.current.cells[0].collapsed).toBe(true);
    });

    test("warns when cell not found", () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const chat = createMockChat();
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.rerunCell("nonexistent", "question");
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent"));
      warnSpy.mockRestore();
    });
  });

  // ---- deleteCell ----

  describe("deleteCell", () => {
    test("removes cell and truncates messages", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
        makeMessage("a2", "assistant"),
      ];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells).toHaveLength(2);

      act(() => {
        result.current.deleteCell("cell-2");
      });

      expect(chat.setMessages).toHaveBeenCalledWith([messages[0], messages[1]]);
      expect(result.current.cells).toHaveLength(1);
      expect(result.current.cells[0].id).toBe("cell-1");
    });

    test("deleting middle cell keeps earlier cells and removes later ones", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
        makeMessage("a2", "assistant"),
        makeMessage("u3", "user"),
        makeMessage("a3", "assistant"),
      ];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells).toHaveLength(3);

      act(() => {
        result.current.deleteCell("cell-2");
      });

      expect(chat.setMessages).toHaveBeenCalledWith([messages[0], messages[1]]);
      expect(result.current.cells).toHaveLength(1);
      expect(result.current.cells[0].id).toBe("cell-1");
    });

    test("deleting first cell removes all cells", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
        makeMessage("a2", "assistant"),
      ];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.deleteCell("cell-1");
      });

      expect(chat.setMessages).toHaveBeenCalledWith([]);
      expect(result.current.cells).toHaveLength(0);
    });

    test("warns when cell not found", () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const chat = createMockChat();
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.deleteCell("nonexistent");
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent"));
      warnSpy.mockRestore();
    });
  });

  // ---- toggleEdit / toggleCollapse ----

  describe("toggleEdit / toggleCollapse", () => {
    test("toggles editing state on and off", () => {
      const messages = [makeMessage("u1", "user"), makeMessage("a1", "assistant")];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells[0].editing).toBe(false);
      act(() => { result.current.toggleEdit("cell-1"); });
      expect(result.current.cells[0].editing).toBe(true);
      act(() => { result.current.toggleEdit("cell-1"); });
      expect(result.current.cells[0].editing).toBe(false);
    });

    test("toggles collapsed state on and off", () => {
      const messages = [makeMessage("u1", "user"), makeMessage("a1", "assistant")];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells[0].collapsed).toBe(false);
      act(() => { result.current.toggleCollapse("cell-1"); });
      expect(result.current.cells[0].collapsed).toBe(true);
      act(() => { result.current.toggleCollapse("cell-1"); });
      expect(result.current.cells[0].collapsed).toBe(false);
    });

    test("toggles affect only the targeted cell", () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
        makeMessage("a2", "assistant"),
      ];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => { result.current.toggleCollapse("cell-1"); });
      expect(result.current.cells[0].collapsed).toBe(true);
      expect(result.current.cells[1].collapsed).toBe(false);
    });
  });

  // ---- copyCell ----

  describe("copyCell", () => {
    let originalClipboard: Clipboard;

    beforeEach(() => {
      originalClipboard = navigator.clipboard;
    });

    afterEach(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        writable: true,
        configurable: true,
      });
    });

    test("copies combined question and answer to clipboard", async () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
      ];
      const chat = createMockChat({ messages });
      const writeText = mock(() => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      await act(async () => {
        await result.current.copyCell("cell-1");
      });

      expect(writeText).toHaveBeenCalledWith("user message u1\n\nassistant message a1");
    });

    test("copies only question when no assistant message", async () => {
      const messages = [makeMessage("u1", "user")];
      const chat = createMockChat({ messages });
      const writeText = mock(() => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      await act(async () => {
        await result.current.copyCell("cell-1");
      });

      expect(writeText).toHaveBeenCalledWith("user message u1");
    });

    test("warns when clipboard write fails", async () => {
      const messages = [makeMessage("u1", "user")];
      const chat = createMockChat({ messages });
      const writeText = mock(() => Promise.reject(new Error("denied")));
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      await act(async () => {
        await result.current.copyCell("cell-1");
      });

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test("warns when cell not found", async () => {
      const chat = createMockChat();
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      await act(async () => {
        await result.current.copyCell("nonexistent");
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent"));
      warnSpy.mockRestore();
    });
  });

  // ---- Error handling ----

  describe("error handling", () => {
    test("passes through chat status and error", () => {
      const error = new Error("Connection lost");
      const chat = createMockChat({ status: "error", error });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe(error);
    });

    test("clearWarning removes active warning", async () => {
      const chat = createMockChat({
        sendMessage: mock(() => Promise.reject(new Error("fail"))),
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.appendCell("test");
      });

      await waitFor(() => {
        expect(result.current.warning).not.toBeNull();
      });

      act(() => {
        result.current.clearWarning();
      });
      expect(result.current.warning).toBeNull();

      errorSpy.mockRestore();
    });

    test("rerunCell error sets warning", async () => {
      const messages = [
        makeMessage("u1", "user"),
        makeMessage("a1", "assistant"),
        makeMessage("u2", "user"),
        makeMessage("a2", "assistant"),
      ];
      const sendMessage = mock(() => Promise.reject(new Error("Rerun failed")));
      const chat = createMockChat({ messages, sendMessage });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const { result, rerender } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.rerunCell("cell-2", "retry question");
      });

      // Simulate truncated messages arriving + ready status
      const truncatedMessages = [messages[0], messages[1]];
      const updatedChat = createMockChat({
        messages: truncatedMessages,
        status: "ready",
        sendMessage,
      });
      rerender({ chat: updatedChat, conversationId: "test" });

      await waitFor(() => {
        expect(result.current.warning).toBe("Failed to re-run cell. Please try again.");
      });

      errorSpy.mockRestore();
    });
  });

  // ---- Edge cases ----

  describe("edge cases", () => {
    test("rapid toggle operations apply correctly", () => {
      const messages = [makeMessage("u1", "user"), makeMessage("a1", "assistant")];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => {
        result.current.toggleCollapse("cell-1");
        result.current.toggleCollapse("cell-1");
        result.current.toggleCollapse("cell-1");
      });

      // Odd number of toggles → collapsed = true
      expect(result.current.cells[0].collapsed).toBe(true);
    });

    test("single cell with no response shows running", () => {
      const messages = [makeMessage("u1", "user")];
      const chat = createMockChat({ messages, status: "submitted" });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      expect(result.current.cells).toHaveLength(1);
      expect(result.current.cells[0].status).toBe("running");
      expect(result.current.cells[0].assistantMessage).toBeNull();
    });

    test("input state is independent from cell operations", () => {
      const chat = createMockChat();
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: "test" } },
      );

      act(() => { result.current.setInput("hello"); });
      expect(result.current.input).toBe("hello");

      act(() => { result.current.setInput(""); });
      expect(result.current.input).toBe("");
    });
  });

  // ---- localStorage integration ----

  describe("localStorage integration", () => {
    test("restores saved cell state from localStorage on mount", () => {
      const convId = "persist-init";
      const saved: NotebookState = {
        conversationId: convId,
        version: 2,
        cells: [
          { id: "cell-1", messageId: "u1", number: 1, collapsed: true, editing: true, status: "idle" },
        ],
      };
      window.localStorage.setItem(`atlas:notebook:${convId}`, JSON.stringify(saved));

      const messages = [makeMessage("u1", "user"), makeMessage("a1", "assistant")];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: convId } },
      );

      // Collapsed/editing should come from saved state, not defaults
      expect(result.current.cells[0].collapsed).toBe(true);
      expect(result.current.cells[0].editing).toBe(true);
    });

    test("persists cell state to localStorage when it changes", () => {
      const convId = "persist-write";
      const messages = [makeMessage("u1", "user"), makeMessage("a1", "assistant")];
      const chat = createMockChat({ messages });
      const { result } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: convId } },
      );

      act(() => {
        result.current.toggleCollapse("cell-1");
      });

      const raw = window.localStorage.getItem(`atlas:notebook:${convId}`);
      expect(raw).not.toBeNull();
      const stored = JSON.parse(raw!) as NotebookState;
      expect(stored.cells[0].collapsed).toBe(true);
      expect(stored.version).toBe(2);
    });

    test("migrates localStorage key from temp to real conversationId", () => {
      const tempId = "temp:abc123";
      const realId = "real-uuid-456";
      const saved: NotebookState = {
        conversationId: tempId,
        version: 2,
        cells: [
          { id: "cell-1", messageId: "u1", number: 1, collapsed: true, editing: false, status: "idle" },
        ],
      };
      window.localStorage.setItem(`atlas:notebook:${tempId}`, JSON.stringify(saved));

      const messages = [makeMessage("u1", "user"), makeMessage("a1", "assistant")];
      const chat = createMockChat({ messages });
      const { result, rerender } = renderHook(
        (props: UseNotebookOptions) => useNotebook(props),
        { initialProps: { chat, conversationId: tempId } },
      );

      expect(result.current.cells[0].collapsed).toBe(true);

      // Simulate conversation getting a real ID
      rerender({ chat, conversationId: realId });

      // Old key removed, new key exists
      expect(window.localStorage.getItem(`atlas:notebook:${tempId}`)).toBeNull();
      const migrated = window.localStorage.getItem(`atlas:notebook:${realId}`);
      expect(migrated).not.toBeNull();
      const parsed = JSON.parse(migrated!) as NotebookState;
      expect(parsed.conversationId).toBe(realId);
    });
  });
});

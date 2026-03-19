import { describe, expect, test, spyOn } from "bun:test";
import {
  buildCellsFromMessages,
  extractTextContent,
  loadNotebookState,
  migrateNotebookStateKey,
  saveNotebookState,
  truncateMessagesForRerun,
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

  test("cell IDs are prefixed with 'cell-'", () => {
    const messages: UIMessage[] = [makeMessage("u1", "user")];
    const cells = buildCellsFromMessages(messages);
    expect(cells[0].id).toBe("cell-u1");
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

  test("returns null when version is not 1", () => {
    const badVersion = JSON.stringify({
      conversationId: "c1",
      cells: [],
      version: 2,
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

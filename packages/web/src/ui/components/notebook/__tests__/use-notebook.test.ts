import { describe, expect, test } from "bun:test";
import {
  buildCellsFromMessages,
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
    createdAt: new Date(),
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

  test("skips non-user/assistant messages", () => {
    const messages = [
      makeMessage("s1", "user"),
      { id: "sys", role: "system" as const, parts: [{ type: "text" as const, text: "system" }], createdAt: new Date() },
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

  test("loadNotebookState returns null for corrupt JSON", () => {
    const mockStorage = {
      getItem: () => "not valid json{{{",
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;

    const loaded = loadNotebookState("corrupt", mockStorage);
    expect(loaded).toBeNull();
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

  test("handles corrupt JSON gracefully", () => {
    const store: Record<string, string> = { "atlas:notebook:temp:bad": "not{json" };
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    } as Storage;

    // Should not throw
    migrateNotebookStateKey("temp:bad", "real-uuid", mockStorage);
  });
});

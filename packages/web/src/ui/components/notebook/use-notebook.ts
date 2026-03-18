import type { UIMessage } from "@ai-sdk/react";
import type { NotebookCell, NotebookState } from "./types";

const STORAGE_PREFIX = "atlas:notebook:";

/**
 * Pairs sequential user + assistant messages into notebook cells.
 * Each user message starts a new cell; assistant messages are associated
 * with the preceding user message. Non-user/assistant messages are skipped.
 */
export function buildCellsFromMessages(messages: UIMessage[]): NotebookCell[] {
  const cells: NotebookCell[] = [];
  let cellNumber = 0;

  for (const message of messages) {
    if (message.role === "user") {
      cellNumber++;
      cells.push({
        id: `cell-${message.id}`,
        messageId: message.id,
        number: cellNumber,
        collapsed: false,
        editing: false,
        status: "idle",
      });
    }
    // Assistant and other roles (system, tool) are skipped for cell creation —
    // assistant messages are resolved later via ResolvedCell.
  }

  return cells;
}

/**
 * Returns all messages before the target message ID.
 * Used to prepare the message array for re-running a cell from that point.
 * If the target is not found, returns the full array unchanged.
 */
export function truncateMessagesForRerun(
  messages: UIMessage[],
  targetMessageId: string,
): UIMessage[] {
  const index = messages.findIndex((m) => m.id === targetMessageId);
  if (index === -1) return messages;
  return messages.slice(0, index);
}

/**
 * Persists notebook state to localStorage under a prefixed key.
 */
export function saveNotebookState(
  state: NotebookState,
  storage?: Storage,
): void {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;

  try {
    store.setItem(`${STORAGE_PREFIX}${state.conversationId}`, JSON.stringify(state));
  } catch (err: unknown) {
    console.debug(
      "Failed to save notebook state:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Loads notebook state from localStorage.
 * Returns null if the key is missing or the stored value is corrupt.
 */
export function loadNotebookState(
  conversationId: string,
  storage?: Storage,
): NotebookState | null {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return null;

  try {
    const raw = store.getItem(`${STORAGE_PREFIX}${conversationId}`);
    if (!raw) return null;
    return JSON.parse(raw) as NotebookState;
  } catch (err: unknown) {
    console.debug(
      "Failed to load notebook state:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Migrates a notebook state entry from a temporary conversation ID key
 * to the real conversation ID key. Removes the old key after migration.
 */
export function migrateNotebookStateKey(
  tempId: string,
  realId: string,
  storage?: Storage,
): void {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;

  try {
    const raw = store.getItem(`${STORAGE_PREFIX}${tempId}`);
    if (!raw) return;

    const state = JSON.parse(raw) as NotebookState;
    state.conversationId = realId;
    store.setItem(`${STORAGE_PREFIX}${realId}`, JSON.stringify(state));
    store.removeItem(`${STORAGE_PREFIX}${tempId}`);
  } catch (err: unknown) {
    console.debug(
      "Failed to migrate notebook state key:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Extracts all text content from a UIMessage's parts, joined by newlines.
 */
export function extractTextContent(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

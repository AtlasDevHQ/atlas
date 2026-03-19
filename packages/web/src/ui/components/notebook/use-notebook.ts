import { useState, useEffect, useCallback, useRef } from "react";
import type { UIMessage } from "@ai-sdk/react";
import type { NotebookStateWire, ForkBranchWire } from "@/ui/lib/types";
import type { NotebookCell, NotebookState, ResolvedCell, ForkInfo } from "./types";

const STORAGE_PREFIX = "atlas:notebook:";

/**
 * Creates notebook cells from user messages in a conversation.
 * Each user message becomes one cell; all other roles are ignored.
 * Assistant messages are resolved later when building ResolvedCell objects.
 */
export function buildCellsFromMessages(messages: UIMessage[]): NotebookCell[] {
  const cells: NotebookCell[] = [];
  let cellNumber = 0;

  for (const message of messages) {
    if (message.role === "user") {
      cellNumber++;
      cells.push({
        id: `cell-${cellNumber}`,
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
    console.warn(
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
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      ((parsed as { version: unknown }).version === 1 ||
        (parsed as { version: unknown }).version === 2 ||
        (parsed as { version: unknown }).version === 3) &&
      "cells" in parsed &&
      Array.isArray((parsed as { cells: unknown }).cells)
    ) {
      return parsed as NotebookState;
    }
    return null;
  } catch (err: unknown) {
    console.warn(
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
    console.warn(
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

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export interface UseNotebookOptions {
  chat: {
    messages: UIMessage[];
    setMessages: (messages: UIMessage[]) => void;
    sendMessage: (opts: { text: string }) => Promise<void>;
    status: "ready" | "streaming" | "submitted" | "error";
    error: Error | null;
  };
  conversationId: string;
  /** Server-side notebook state loaded from the conversation. */
  initialServerState?: NotebookStateWire | null;
  /** Debounced callback to persist notebook state to the server. */
  saveToServer?: (state: NotebookStateWire) => void;
  /** Fork a conversation at a specific message. */
  forkConversation?: (sourceId: string, forkPointMessageId: string, label?: string) => Promise<{ id: string; branches: ForkBranchWire[]; warning?: string }>;
  /** Navigate to a different branch conversation. */
  onNavigateToBranch?: (conversationId: string) => void;
  /** Fork info from server state (branches, root, etc.). */
  forkInfo?: ForkInfo | null;
}

export interface UseNotebookReturn {
  cells: ResolvedCell[];
  status: "ready" | "streaming" | "submitted" | "error";
  error: Error | null;
  warning: string | null;
  clearWarning: () => void;
  appendCell: (question: string) => void;
  rerunCell: (cellId: string, newQuestion: string) => void;
  deleteCell: (cellId: string) => void;
  toggleEdit: (cellId: string) => void;
  toggleCollapse: (cellId: string) => void;
  copyCell: (cellId: string) => Promise<void>;
  reorderCells: (orderedIds: string[]) => void;
  forkCell: (cellId: string) => Promise<void>;
  switchBranch: (conversationId: string) => void;
  forkInfo: ForkInfo | null;
  input: string;
  setInput: (value: string) => void;
}

export function useNotebook({
  chat,
  conversationId,
  initialServerState,
  saveToServer,
  forkConversation: forkConversationFn,
  onNavigateToBranch,
  forkInfo: forkInfoProp,
}: UseNotebookOptions): UseNotebookReturn {
  const [input, setInput] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const warningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showWarning(msg: string): void {
    if (warningTimer.current) clearTimeout(warningTimer.current);
    setWarning(msg);
    warningTimer.current = setTimeout(() => setWarning(null), 5000);
  }

  function clearWarning(): void {
    if (warningTimer.current) clearTimeout(warningTimer.current);
    setWarning(null);
  }

  // Clean up warning timer on unmount
  useEffect(() => {
    return () => {
      if (warningTimer.current) clearTimeout(warningTimer.current);
    };
  }, []);

  // Initialize cellState — prefer server state, then localStorage, then build from messages
  const [cellState, setCellState] = useState<NotebookCell[]>(() => {
    if (typeof window === "undefined") return [];

    // Build cells from messages first
    const freshCells = buildCellsFromMessages(chat.messages);

    // Apply server-side persisted props if available
    if (initialServerState?.cellProps) {
      for (const cell of freshCells) {
        const props = initialServerState.cellProps[cell.id];
        if (props?.collapsed) cell.collapsed = true;
      }
      return freshCells;
    }

    // Fallback to localStorage
    const saved = loadNotebookState(conversationId);
    if (saved?.cells) {
      // Merge saved cell state onto fresh cells
      return freshCells.map((fc) => {
        const existing = saved.cells.find((sc) => sc.id === fc.id);
        if (existing) {
          return { ...fc, collapsed: existing.collapsed, editing: existing.editing };
        }
        return fc;
      });
    }

    return freshCells;
  });

  // Cell display order — empty means natural message order
  const [cellOrder, setCellOrder] = useState<string[]>(() => {
    if (initialServerState?.cellOrder) return initialServerState.cellOrder;
    if (typeof window === "undefined") return [];
    const saved = loadNotebookState(conversationId);
    return saved?.cellOrder ?? [];
  });

  const pendingRerun = useRef<string | null>(null);
  // Snapshot of cell state taken before a rerun truncates messages. Used as
  // fallback during reconciliation so collapsed/editing state survives the
  // intermediate truncation step where the re-run cell is temporarily absent.
  const preRerunCells = useRef<NotebookCell[]>([]);

  // Reconcile cells when messages change
  useEffect(() => {
    const fresh = buildCellsFromMessages(chat.messages);
    setCellState((prev) => {
      let usedFallback = false;
      const result = fresh.map((fc) => {
        const existing = prev.find((pc) => pc.id === fc.id);
        if (existing) {
          return { ...fc, collapsed: existing.collapsed, editing: existing.editing };
        }
        const fallback = preRerunCells.current.find((pc) => pc.id === fc.id);
        if (fallback) {
          usedFallback = true;
          return { ...fc, collapsed: fallback.collapsed, editing: fallback.editing };
        }
        return fc;
      });
      if (usedFallback) {
        preRerunCells.current = [];
      }
      return result;
    });
  }, [chat.messages]);

  // Persist to localStorage (write-through cache)
  useEffect(() => {
    if (!conversationId) return;
    saveNotebookState({
      conversationId,
      cells: cellState,
      version: 3,
      cellOrder: cellOrder.length > 0 ? cellOrder : undefined,
    });
  }, [cellState, cellOrder, conversationId]);

  // Debounced server persistence (500ms)
  useEffect(() => {
    if (!conversationId || conversationId.startsWith("temp:") || !saveToServer) return;

    const timer = setTimeout(() => {
      const cellProps: Record<string, { collapsed?: boolean }> = {};
      for (const cell of cellState) {
        if (cell.collapsed) {
          cellProps[cell.id] = { collapsed: true };
        }
      }
      const wire: NotebookStateWire = {
        version: 3,
        cellOrder: cellOrder.length > 0 ? cellOrder : undefined,
        cellProps: Object.keys(cellProps).length > 0 ? cellProps : undefined,
      };
      saveToServer(wire);
    }, 500);

    return () => clearTimeout(timer);
  }, [cellState, cellOrder, conversationId, saveToServer]);

  // Migrate localStorage key when conversationId changes from temp to real
  const prevConversationId = useRef(conversationId);
  useEffect(() => {
    const prev = prevConversationId.current;
    if (prev.startsWith("temp:") && !conversationId.startsWith("temp:")) {
      migrateNotebookStateKey(prev, conversationId);
    }
    prevConversationId.current = conversationId;
  }, [conversationId]);

  // Two-phase rerun: setMessages is async (React batches state updates), so we
  // can't call sendMessage immediately after truncating — useChat would still see
  // the old messages. Instead, store the question in a ref and fire sendMessage
  // in a subsequent effect once the truncated messages are committed and status is ready.
  useEffect(() => {
    if (pendingRerun.current && chat.status === "ready") {
      const text = pendingRerun.current;
      pendingRerun.current = null;
      chat.sendMessage({ text }).catch((err: unknown) => {
        console.error(
          "Failed to re-run cell:",
          err instanceof Error ? err.message : String(err),
        );
        showWarning("Failed to re-run cell. Please try again.");
      });
    }
  }, [chat.messages, chat.status, chat]);

  // Resolve cells with their messages, applying display order
  const orderedCellState = cellOrder.length > 0
    ? cellOrder
        .map((id) => cellState.find((c) => c.id === id))
        .filter((c): c is NotebookCell => c !== undefined)
        // Append any cells not in the order (new cells added after reorder)
        .concat(cellState.filter((c) => !cellOrder.includes(c.id)))
    : cellState;

  const cells: ResolvedCell[] = orderedCellState.map((cell, displayIndex) => {
    const userMsg = chat.messages.find((m) => m.id === cell.messageId);
    const userIdx = chat.messages.findIndex((m) => m.id === cell.messageId);
    const nextMsg = userIdx !== -1 ? chat.messages[userIdx + 1] : undefined;
    const assistantMsg = nextMsg?.role === "assistant" ? nextMsg : null;

    const isLastCell = userIdx === chat.messages.length - 1 || (userIdx === chat.messages.length - 2 && !assistantMsg);
    const isRunning = chat.status !== "ready" && !assistantMsg && isLastCell;

    return {
      ...cell,
      number: displayIndex + 1,
      userMessage: userMsg ?? { id: cell.messageId, role: "user" as const, parts: [] },
      assistantMessage: assistantMsg ?? null,
      status: isRunning ? "running" : cell.status,
    };
  });

  const appendCell = useCallback(
    (question: string) => {
      setInput("");
      chat.sendMessage({ text: question }).catch((err: unknown) => {
        setInput(question);
        console.error(
          "Failed to send message:",
          err instanceof Error ? err.message : String(err),
        );
        showWarning("Failed to send message. Please try again.");
      });
    },
    [chat],
  );

  const rerunCell = useCallback(
    (cellId: string, newQuestion: string) => {
      const cell = cellState.find((c) => c.id === cellId);
      if (!cell) {
        console.warn(`rerunCell: cell ${cellId} not found`);
        return;
      }
      preRerunCells.current = [...cellState];
      const truncated = truncateMessagesForRerun(chat.messages, cell.messageId);
      chat.setMessages(truncated);
      pendingRerun.current = newQuestion;
    },
    [cellState, chat],
  );

  const deleteCell = useCallback(
    (cellId: string) => {
      const cell = cellState.find((c) => c.id === cellId);
      if (!cell) {
        console.warn(`deleteCell: cell ${cellId} not found`);
        return;
      }
      const truncated = truncateMessagesForRerun(chat.messages, cell.messageId);
      chat.setMessages(truncated);
      setCellState((prev) => prev.filter((c) => c.number < cell.number));
      // Remove from cellOrder if present
      setCellOrder((prev) => prev.filter((id) => id !== cellId));
    },
    [cellState, chat],
  );

  const toggleEdit = useCallback((cellId: string) => {
    setCellState((prev) =>
      prev.map((c) => (c.id === cellId ? { ...c, editing: !c.editing } : c)),
    );
  }, []);

  const toggleCollapse = useCallback((cellId: string) => {
    setCellState((prev) =>
      prev.map((c) => (c.id === cellId ? { ...c, collapsed: !c.collapsed } : c)),
    );
  }, []);

  const copyCell = useCallback(
    async (cellId: string) => {
      const resolved = cells.find((c) => c.id === cellId);
      if (!resolved) {
        console.warn(`copyCell: cell ${cellId} not found`);
        return;
      }
      const questionText = extractTextContent(resolved.userMessage);
      const answerText = resolved.assistantMessage
        ? extractTextContent(resolved.assistantMessage)
        : "";
      const combined = answerText ? `${questionText}\n\n${answerText}` : questionText;
      try {
        await navigator.clipboard.writeText(combined);
      } catch (err: unknown) {
        console.warn(
          "Failed to copy to clipboard:",
          err instanceof Error ? err.message : String(err),
        );
        showWarning("Failed to copy to clipboard. Your browser may require HTTPS or a user gesture.");
      }
    },
    [cells],
  );

  const reorderCells = useCallback((orderedIds: string[]) => {
    setCellOrder(orderedIds);
  }, []);

  const forkCell = useCallback(
    async (cellId: string) => {
      if (!forkConversationFn) {
        showWarning("Fork is not available without server-side persistence.");
        return;
      }

      const cell = cells.find((c) => c.id === cellId);
      if (!cell) {
        console.warn(`forkCell: cell ${cellId} not found`);
        return;
      }

      try {
        const result = await forkConversationFn(
          conversationId,
          cell.messageId,
          `Fork from cell ${cell.number}`,
        );
        if (result.warning) {
          showWarning(result.warning);
        }
        onNavigateToBranch?.(result.id);
      } catch (err: unknown) {
        console.warn(
          "Failed to fork conversation:",
          err instanceof Error ? err.message : String(err),
        );
        showWarning("Failed to fork. Please try again.");
      }
    },
    [cells, conversationId, forkConversationFn, onNavigateToBranch],
  );

  const switchBranch = useCallback(
    (targetConversationId: string) => {
      onNavigateToBranch?.(targetConversationId);
    },
    [onNavigateToBranch],
  );

  return {
    cells,
    status: chat.status,
    error: chat.error,
    warning,
    clearWarning,
    appendCell,
    rerunCell,
    deleteCell,
    toggleEdit,
    toggleCollapse,
    copyCell,
    reorderCells,
    forkCell,
    switchBranch,
    forkInfo: forkInfoProp ?? null,
    input,
    setInput,
  };
}

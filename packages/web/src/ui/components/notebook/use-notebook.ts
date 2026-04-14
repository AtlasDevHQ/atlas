import { useState, useEffect, useCallback, useRef } from "react";
import type { UIMessage } from "@ai-sdk/react";
import { isToolUIPart } from "ai";
import type { NotebookStateWire, ForkBranchWire } from "@/ui/lib/types";
import type { NotebookCell, NotebookState, ResolvedCell, ForkInfo, PreviousExecution } from "./types";
import type { DashboardCardEntry } from "./dashboard-bridge-context";

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
    console.warn(
      `Notebook state for ${conversationId} exists but has unexpected shape (version: ${
        (parsed as Record<string, unknown>).version ?? "missing"
      }). Discarding saved state.`,
    );
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

/**
 * Extracts executionMs and rowCount from the executeSQL tool result in a cell's
 * assistant response. Returns undefined if the cell has no SQL result.
 */
function extractExecutionMetadata(
  messages: UIMessage[],
  cellMessageId: string,
): PreviousExecution | undefined {
  const userIdx = messages.findIndex((m) => m.id === cellMessageId);
  if (userIdx === -1) return undefined;

  const nextMsg = messages[userIdx + 1];
  if (!nextMsg || nextMsg.role !== "assistant") return undefined;

  for (const part of nextMsg.parts) {
    if (!isToolUIPart(part)) continue;
    const p = part as Record<string, unknown>;
    if (p.toolName !== "executeSQL" || p.state !== "output-available") continue;

    const result = p.output as Record<string, unknown> | undefined;
    if (!result?.success) continue;

    return {
      executionMs: typeof result.executionMs === "number" ? result.executionMs : undefined,
      rowCount: Array.isArray(result.rows) ? result.rows.length : undefined,
    };
  }

  return undefined;
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
  /** Delete a branch conversation. */
  deleteBranch?: (rootId: string, branchId: string) => Promise<void>;
  /** Rename a branch label. */
  renameBranch?: (rootId: string, branchId: string, label: string) => Promise<void>;
  /** Called after a branch mutation (delete/rename) so the parent can refresh fork info. */
  onForkInfoChanged?: (updatedForkInfo: ForkInfo) => void;
}

export type { DashboardCardEntry } from "./dashboard-bridge-context";

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
  deleteBranch: (branchId: string) => Promise<void>;
  renameBranch: (branchId: string, label: string) => Promise<void>;
  forkInfo: ForkInfo | null;
  input: string;
  setInput: (value: string) => void;
  insertTextCell: (afterCellId?: string) => void;
  updateTextCell: (cellId: string, content: string) => void;
  /** Map of cellId → dashboard card info for cells added to a dashboard. */
  dashboardCards: Record<string, DashboardCardEntry>;
  /** Record that a cell was added to a dashboard. */
  addDashboardCard: (cellId: string, entry: DashboardCardEntry) => void;
}

export function useNotebook({
  chat,
  conversationId,
  initialServerState,
  saveToServer,
  forkConversation: forkConversationFn,
  onNavigateToBranch,
  forkInfo: forkInfoProp,
  deleteBranch: deleteBranchFn,
  renameBranch: renameBranchFn,
  onForkInfoChanged,
}: UseNotebookOptions): UseNotebookReturn {
  const [input, setInput] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const warningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timers for auto-clearing previousExecution comparison after 30s
  const comparisonTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  function showWarning(msg: string): void {
    if (warningTimer.current) clearTimeout(warningTimer.current);
    setWarning(msg);
    warningTimer.current = setTimeout(() => setWarning(null), 5000);
  }

  function clearWarning(): void {
    if (warningTimer.current) clearTimeout(warningTimer.current);
    setWarning(null);
  }

  // Clean up timers on unmount
  useEffect(() => {
    const timers = comparisonTimers.current;
    return () => {
      if (warningTimer.current) clearTimeout(warningTimer.current);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Initialize cellState — prefer server state, then localStorage, then build from messages
  const [cellState, setCellState] = useState<NotebookCell[]>(() => {
    if (typeof window === "undefined") return [];

    // Build query cells from messages first
    const freshCells = buildCellsFromMessages(chat.messages);

    // Apply server-side persisted props if available
    if (initialServerState?.cellProps) {
      for (const cell of freshCells) {
        const props = initialServerState.cellProps[cell.id];
        if (props?.collapsed) cell.collapsed = true;
      }
      // Restore text cells from server state
      if (initialServerState.textCells) {
        for (const [id, data] of Object.entries(initialServerState.textCells)) {
          freshCells.push({
            id,
            messageId: "",
            number: 0,
            collapsed: false,
            editing: false,
            status: "idle",
            type: "text",
            content: data.content,
          });
        }
      }
      return freshCells;
    }

    // Fallback to localStorage
    const saved = loadNotebookState(conversationId);
    if (saved?.cells) {
      // Merge saved cell state onto fresh query cells
      const queryCells = freshCells.map((fc) => {
        const existing = saved.cells.find((sc) => sc.id === fc.id);
        if (existing) {
          return { ...fc, collapsed: existing.collapsed, editing: existing.editing };
        }
        return fc;
      });
      // Restore text cells from saved state
      const textCells = saved.cells.filter((c) => c.type === "text");
      return [...queryCells, ...textCells];
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

  // Dashboard card mappings — which cells have been added to dashboards
  const [dashboardCards, setDashboardCards] = useState<Record<string, DashboardCardEntry>>(() => {
    if (initialServerState?.dashboardCards) return initialServerState.dashboardCards;
    return {};
  });

  const pendingRerun = useRef<string | null>(null);
  // Snapshot of cell state taken before a rerun truncates messages. Used as
  // fallback during reconciliation so collapsed/editing state survives the
  // intermediate truncation step where the re-run cell is temporarily absent.
  const preRerunCells = useRef<NotebookCell[]>([]);

  // Track which conversation's server state we last applied, so we can
  // detect when new server state arrives (after the async fetch completes).
  const appliedServerStateFor = useRef<string | null>(null);
  // Suppress server saves briefly after restoring from server state,
  // to avoid overwriting just-loaded data with a stale snapshot.
  // Uses a timestamp so multiple rapid state changes are all suppressed.
  const suppressSaveUntil = useRef(0);

  // Reconcile cells when messages change OR when switching conversations.
  useEffect(() => {
    const isNewConversation = appliedServerStateFor.current !== conversationId;

    if (isNewConversation && initialServerState !== undefined) {
      appliedServerStateFor.current = conversationId;
      const freshCells = buildCellsFromMessages(chat.messages);

      // Restore text cells from server state for the NEW conversation
      if (initialServerState?.textCells) {
        for (const [id, data] of Object.entries(initialServerState.textCells)) {
          freshCells.push({
            id,
            messageId: "",
            number: 0,
            collapsed: false,
            editing: false,
            status: "idle",
            type: "text",
            content: data.content,
          });
        }
      }

      // Restore persisted cell props from server
      if (initialServerState?.cellProps) {
        for (const cell of freshCells) {
          const props = initialServerState.cellProps[cell.id];
          if (props?.collapsed) cell.collapsed = true;
        }
      }

      // Suppress saves for 1s to let React settle after the reset
      suppressSaveUntil.current = Date.now() + 1000;
      setCellState(freshCells);
      setCellOrder(initialServerState?.cellOrder ?? []);
      setDashboardCards(initialServerState?.dashboardCards ?? {});
      return;
    }

    // Same conversation — reconcile cells when messages change
    const fresh = buildCellsFromMessages(chat.messages);
    setCellState((prev) => {
      // Preserve text cells — they belong to this conversation
      const textCells = prev.filter((c) => c.type === "text");

      let usedFallback = false;
      const queryCells = fresh.map((fc) => {
        const existing = prev.find((pc) => pc.id === fc.id && pc.type !== "text");
        if (existing) {
          return { ...fc, collapsed: existing.collapsed, editing: existing.editing, previousExecution: existing.previousExecution };
        }
        const fallback = preRerunCells.current.find((pc) => pc.id === fc.id);
        if (fallback) {
          usedFallback = true;
          return { ...fc, collapsed: fallback.collapsed, editing: fallback.editing, previousExecution: fallback.previousExecution };
        }
        return fc;
      });
      if (usedFallback) {
        preRerunCells.current = [];
      }
      return [...queryCells, ...textCells];
    });
  }, [chat.messages, conversationId, initialServerState]);

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
    if (Date.now() < suppressSaveUntil.current) return;

    const timer = setTimeout(() => {
      const cellProps: Record<string, { collapsed?: boolean }> = {};
      for (const cell of cellState) {
        if (cell.collapsed) {
          cellProps[cell.id] = { collapsed: true };
        }
      }

      // Persist text cell content
      const textCells: Record<string, { content: string }> = {};
      for (const cell of cellState) {
        if (cell.type === "text") {
          textCells[cell.id] = { content: cell.content ?? "" };
        }
      }

      const wire: NotebookStateWire = {
        version: 3,
        cellOrder: cellOrder.length > 0 ? cellOrder : undefined,
        cellProps: Object.keys(cellProps).length > 0 ? cellProps : undefined,
        textCells: Object.keys(textCells).length > 0 ? textCells : undefined,
        dashboardCards: Object.keys(dashboardCards).length > 0 ? dashboardCards : undefined,
      };
      saveToServer(wire);
    }, 500);

    return () => clearTimeout(timer);
  }, [cellState, cellOrder, dashboardCards, conversationId, saveToServer]);

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
    // Text cells have a synthetic user message for display purposes
    if (cell.type === "text") {
      return {
        ...cell,
        number: displayIndex + 1,
        userMessage: {
          id: cell.id,
          role: "user" as const,
          parts: [{ type: "text" as const, text: cell.content ?? "" }],
        },
        assistantMessage: null,
        status: "idle" as const,
      };
    }

    // Query cell — resolve from messages
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

      // Snapshot current execution metadata for comparison display
      const prevMeta = extractExecutionMetadata(chat.messages, cell.messageId);
      if (prevMeta) {
        setCellState((prev) =>
          prev.map((c) => (c.id === cellId ? { ...c, previousExecution: prevMeta } : c)),
        );

        // Auto-clear comparison after 30s
        const existing = comparisonTimers.current.get(cellId);
        if (existing) clearTimeout(existing);
        comparisonTimers.current.set(
          cellId,
          setTimeout(() => {
            comparisonTimers.current.delete(cellId);
            setCellState((prev) =>
              prev.map((c) => (c.id === cellId ? { ...c, previousExecution: undefined } : c)),
            );
          }, 30_000),
        );
      }

      preRerunCells.current = [...cellState.map((c) =>
        c.id === cellId && prevMeta ? { ...c, previousExecution: prevMeta } : c,
      )];
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

      if (cell.type === "text") {
        // Text cells: remove only this cell, no message truncation
        setCellState((prev) => prev.filter((c) => c.id !== cellId));
        setCellOrder((prev) => prev.filter((id) => id !== cellId));
        setDashboardCards((prev) => {
          if (!(cellId in prev)) return prev;
          const next = { ...prev };
          delete next[cellId];
          return next;
        });
        return;
      }

      // Query cell: truncate messages and remove subsequent query cells
      const truncated = truncateMessagesForRerun(chat.messages, cell.messageId);
      chat.setMessages(truncated);
      // Remove this and subsequent query cells; preserve text cells
      setCellState((prev) => prev.filter((c) => c.type === "text" || c.number < cell.number));
      // Clean up cellOrder: remove deleted query cell IDs
      const deletedIds = new Set(
        cellState
          .filter((c) => c.type !== "text" && c.number >= cell.number)
          .map((c) => c.id),
      );
      setCellOrder((prev) => prev.filter((id) => !deletedIds.has(id)));
      // Clean up dashboard card associations for deleted cells
      setDashboardCards((prev) => {
        let changed = false;
        for (const id of deletedIds) {
          if (id in prev) { changed = true; break; }
        }
        if (!changed) return prev;
        const next = { ...prev };
        for (const id of deletedIds) delete next[id];
        return next;
      });
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

  const deleteBranch = useCallback(
    async (branchId: string) => {
      if (!deleteBranchFn || !forkInfoProp) {
        showWarning("Branch deletion is not available.");
        return;
      }
      try {
        await deleteBranchFn(forkInfoProp.rootId, branchId);
        // If we're viewing the deleted branch, navigate to root
        if (forkInfoProp.currentId === branchId) {
          onNavigateToBranch?.(forkInfoProp.rootId);
        } else {
          // Update forkInfo optimistically so the UI reflects the removal
          onForkInfoChanged?.({
            ...forkInfoProp,
            branches: forkInfoProp.branches.filter((b) => b.conversationId !== branchId),
          });
        }
      } catch (err: unknown) {
        console.warn(
          "Failed to delete branch:",
          err instanceof Error ? err.message : String(err),
        );
        showWarning("Failed to delete branch. Please try again.");
      }
    },
    [deleteBranchFn, forkInfoProp, onNavigateToBranch, onForkInfoChanged],
  );

  const renameBranch = useCallback(
    async (branchId: string, label: string) => {
      if (!renameBranchFn || !forkInfoProp) {
        showWarning("Branch renaming is not available.");
        return;
      }
      try {
        await renameBranchFn(forkInfoProp.rootId, branchId, label);
        // Update forkInfo optimistically so the UI reflects the new label
        onForkInfoChanged?.({
          ...forkInfoProp,
          branches: forkInfoProp.branches.map((b) =>
            b.conversationId === branchId ? { ...b, label } : b,
          ),
        });
      } catch (err: unknown) {
        console.warn(
          "Failed to rename branch:",
          err instanceof Error ? err.message : String(err),
        );
        showWarning("Failed to rename branch. Please try again.");
        throw err; // Re-throw so callers (e.g. inline edit UI) can keep their state
      }
    },
    [renameBranchFn, forkInfoProp, onForkInfoChanged],
  );

  /** Insert a new text cell. If afterCellId is provided, inserts after that cell; otherwise appends to the end. */
  const insertTextCell = useCallback(
    (afterCellId?: string) => {
      const id = `text-${crypto.randomUUID()}`;
      const newCell: NotebookCell = {
        id,
        messageId: "",
        number: 0,
        collapsed: false,
        editing: true,
        status: "idle",
        type: "text",
        content: "",
      };

      setCellState((prev) => [...prev, newCell]);

      setCellOrder((prev) => {
        // Initialize order from current cells if empty
        const currentOrder =
          prev.length > 0 ? [...prev] : cellState.map((c) => c.id);
        if (afterCellId) {
          const idx = currentOrder.indexOf(afterCellId);
          if (idx !== -1) {
            return currentOrder.toSpliced(idx + 1, 0, id);
          }
        }
        return [...currentOrder, id];
      });
    },
    [cellState],
  );

  /** Update the markdown content of a text cell. */
  const updateTextCell = useCallback((cellId: string, content: string) => {
    setCellState((prev) =>
      prev.map((c) => (c.id === cellId && c.type === "text" ? { ...c, content } : c)),
    );
  }, []);

  /** Record that a cell was added to a dashboard. */
  const addDashboardCard = useCallback((cellId: string, entry: DashboardCardEntry) => {
    setDashboardCards((prev) => ({ ...prev, [cellId]: entry }));
  }, []);

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
    deleteBranch,
    renameBranch,
    forkInfo: forkInfoProp ?? null,
    input,
    setInput,
    insertTextCell,
    updateTextCell,
    dashboardCards,
    addDashboardCard,
  };
}

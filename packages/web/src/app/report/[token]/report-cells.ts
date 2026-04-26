/**
 * Pure cell resolution logic for the report view.
 * Extracted to a separate module for testability (no React/DOM dependencies).
 */

import type { UIMessage } from "@ai-sdk/react";
import type {
  SharedMessage,
  SharedConversation,
} from "../../shared/lib";

// ---------------------------------------------------------------------------
// Cell types — discriminated union so illegal states are unrepresentable
// ---------------------------------------------------------------------------

interface ReportCellBase {
  id: string;
  number: number;
  collapsed: boolean;
}

export interface TextReportCell extends ReportCellBase {
  type: "text";
  content: string;
}

export interface QueryReportCell extends ReportCellBase {
  type: "query";
  userMessage: UIMessage;
  assistantMessage: UIMessage | null;
}

export type ReportCell = TextReportCell | QueryReportCell;

// ---------------------------------------------------------------------------
// Message transformation
// ---------------------------------------------------------------------------

/** Convert raw message content to a UIMessage for rendering. */
export function toUIMessage(msg: SharedMessage, id: string): UIMessage {
  const content = msg.content;
  if (typeof content === "string") {
    return {
      id,
      role: msg.role as UIMessage["role"],
      parts: [{ type: "text", text: content }],
    };
  }
  if (Array.isArray(content)) {
    const parts: UIMessage["parts"] = (content as Record<string, unknown>[])
      .filter((p) => p.type === "text" || p.type === "tool-invocation")
      .map((p, idx) => {
        if (p.type === "tool-invocation") {
          const toolCallId =
            typeof p.toolCallId === "string" && p.toolCallId
              ? p.toolCallId
              : `tool-${id}-${idx}`;
          return {
            type: "tool-invocation" as const,
            toolCallId,
            toolName: String(p.toolName ?? "unknown"),
            state: "output-available" as const,
            input: p.args ?? {},
            output: p.result ?? null,
          };
        }
        return { type: "text" as const, text: String(p.text ?? "") };
      });
    return { id, role: msg.role as UIMessage["role"], parts };
  }
  if (content != null) {
    console.warn(
      `[report-view] Unrecognized message content shape for ${id}:`,
      typeof content,
    );
  }
  return { id, role: msg.role as UIMessage["role"], parts: [] };
}

// ---------------------------------------------------------------------------
// Cell resolution
// ---------------------------------------------------------------------------

/**
 * Reconstruct ordered report cells from flat messages and optional notebookState.
 * When cellOrder is present, it governs display order and allows text cells to be
 * positioned. Without cellOrder, only query cells are shown — text cells are omitted
 * because their position is undefined without an explicit ordering.
 */
export function resolveCells(conversation: SharedConversation): ReportCell[] {
  const { messages, notebookState } = conversation;
  const state = notebookState ?? null;

  // Build query cells from user/assistant message pairs
  const allMessages = messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  const queryCells: QueryReportCell[] = [];
  let cellNum = 0;

  for (let i = 0; i < allMessages.length; i++) {
    const msg = allMessages[i];
    if (msg.role !== "user") continue;

    cellNum++;
    const cellId = `cell-${cellNum}`;
    const collapsed = state?.cellProps?.[cellId]?.collapsed ?? false;

    const nextMsg = allMessages[i + 1];
    const assistantMsg =
      nextMsg?.role === "assistant" ? nextMsg : undefined;

    queryCells.push({
      id: cellId,
      number: cellNum,
      type: "query",
      collapsed,
      userMessage: toUIMessage(msg, `user-${cellNum}`),
      assistantMessage: assistantMsg
        ? toUIMessage(assistantMsg, `assistant-${cellNum}`)
        : null,
    });
  }

  // Build text cells from notebookState
  const textCells: TextReportCell[] = [];
  if (state?.textCells) {
    for (const [id, { content }] of Object.entries(state.textCells)) {
      const collapsed = state.cellProps?.[id]?.collapsed ?? false;
      textCells.push({
        id,
        number: 0, // will be renumbered
        type: "text",
        collapsed,
        content,
      });
    }
  }

  // Merge cells according to cellOrder (if present)
  const allCells: ReportCell[] = [...queryCells, ...textCells];
  const cellMap = new Map(allCells.map((c) => [c.id, c]));

  let ordered: ReportCell[];
  if (state?.cellOrder && state.cellOrder.length > 0) {
    ordered = state.cellOrder
      .map((id) => cellMap.get(id))
      .filter((c): c is ReportCell => c !== undefined);
    // Append any cells not in the order
    const inOrder = new Set(state.cellOrder);
    for (const cell of allCells) {
      if (!inOrder.has(cell.id)) ordered.push(cell);
    }
  } else {
    // No cellOrder — show query cells only. Text cells are omitted because
    // their position is undefined without an explicit ordering.
    if (textCells.length > 0) {
      console.warn(
        `[report-view] ${textCells.length} text cell(s) dropped: cellOrder is empty but textCells exist`,
      );
    }
    ordered = queryCells;
  }

  // Renumber query cells for display by their position among query cells only.
  // Text cells in `cellOrder` consume sequence indices but render no number;
  // counting all cells produces sparse numbering ([2], [4], [5]) that reads as
  // a bug. Numbering only query cells keeps the sequence dense and matches the
  // notebook editor's authoring numbering.
  let queryIndex = 0;
  return ordered.map((cell) => {
    if (cell.type === "query") {
      queryIndex += 1;
      return { ...cell, number: queryIndex };
    }
    return cell;
  });
}

/** Extract displayable text from a UIMessage. */
export function extractText(message: UIMessage): string {
  return message.parts
    .filter(
      (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
    )
    .map((p) => p.text)
    .join("\n");
}

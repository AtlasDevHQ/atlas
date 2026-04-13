"use client";

import { Printer } from "lucide-react";
import type { UIMessage } from "@ai-sdk/react";
import { isToolUIPart } from "ai";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/ui/components/chat/markdown";
import { ToolPart } from "@/ui/components/chat/tool-part";
import { parseSuggestions } from "@/ui/lib/helpers";

// ---------------------------------------------------------------------------
// Types — mirrors the SharedConversation shape from shared/lib.ts
// ---------------------------------------------------------------------------

interface SharedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  createdAt: string;
}

interface NotebookState {
  version: number;
  cellOrder?: string[];
  cellProps?: Record<string, { collapsed?: boolean }>;
  textCells?: Record<string, { content: string }>;
}

interface SharedConversation {
  title: string | null;
  surface: string;
  createdAt: string;
  messages: SharedMessage[];
  notebookState?: NotebookState | null;
}

// ---------------------------------------------------------------------------
// Cell resolution — transform flat messages + notebookState into ordered cells
// ---------------------------------------------------------------------------

interface ReportCell {
  id: string;
  number: number;
  type: "query" | "text";
  collapsed: boolean;
  /** For text cells: the markdown content. */
  content?: string;
  /** For query cells: the user message as a UIMessage. */
  userMessage?: UIMessage;
  /** For query cells: the assistant response as a UIMessage. */
  assistantMessage?: UIMessage | null;
}

/** Convert raw message content to a UIMessage for rendering. */
function toUIMessage(msg: SharedMessage, id: string): UIMessage {
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
            toolInvocationId: toolCallId,
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
  return { id, role: msg.role as UIMessage["role"], parts: [] };
}

function resolveCells(conversation: SharedConversation): ReportCell[] {
  const { messages, notebookState } = conversation;
  const state = notebookState ?? null;

  // Build query cells from user messages
  const allMessages = messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  const queryCells: ReportCell[] = [];
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
  const textCells: ReportCell[] = [];
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
  const allCells = [...queryCells, ...textCells];
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
    // No custom order — query cells only (text cells need cellOrder to position)
    ordered = queryCells;
  }

  // Renumber for display
  return ordered.map((cell, i) => ({ ...cell, number: i + 1 }));
}

// ---------------------------------------------------------------------------
// Extracted text from a UIMessage (for the question heading)
// ---------------------------------------------------------------------------

function extractText(message: UIMessage): string {
  return message.parts
    .filter(
      (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
    )
    .map((p) => p.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ReportViewProps {
  conversation: SharedConversation;
}

export function ReportView({ conversation }: ReportViewProps) {
  const cells = resolveCells(conversation);

  return (
    <div className="report-view mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="mb-8 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Atlas
              </span>
              <span aria-hidden="true">&middot;</span>
              <span>Report</span>
              <span aria-hidden="true">&middot;</span>
              <time dateTime={conversation.createdAt}>
                {new Date(conversation.createdAt).toLocaleDateString(
                  undefined,
                  {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  },
                )}
              </time>
            </div>
            {conversation.title && (
              <h1 className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100 sm:text-2xl">
                {conversation.title}
              </h1>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="hidden gap-1.5 print:hidden sm:flex"
            onClick={() => window.print()}
          >
            <Printer className="size-3.5" />
            Save as PDF
          </Button>
        </div>
      </header>

      {/* Cells */}
      <div className="space-y-6">
        {cells.map((cell) => {
          if (cell.type === "text") {
            return <TextCell key={cell.id} cell={cell} />;
          }
          return <QueryCell key={cell.id} cell={cell} />;
        })}
      </div>

      {/* Footer */}
      <footer className="mt-12 border-t border-zinc-200 pt-4 text-center text-xs text-zinc-400 print:mt-8 dark:border-zinc-800 dark:text-zinc-500">
        Generated with Atlas
      </footer>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          /* Reset page margins */
          @page {
            margin: 1.5cm 2cm;
            size: A4;
          }

          /* Hide non-content elements */
          body > *:not(.report-view),
          nav,
          .print\\:hidden,
          button,
          [role="navigation"],
          a[href="#main"] {
            display: none !important;
          }

          /* Remove dark mode for print */
          html {
            color-scheme: light !important;
          }
          html.dark {
            --tw-bg-opacity: 1;
          }
          body,
          .dark body {
            background: white !important;
            color: #18181b !important;
          }
          .dark * {
            color: inherit !important;
            background: inherit !important;
            border-color: #e4e4e7 !important;
          }

          /* Clean up the report container */
          .report-view {
            max-width: 100% !important;
            padding: 0 !important;
            margin: 0 !important;
          }

          /* Prevent page breaks inside cells */
          .report-cell {
            break-inside: avoid;
            page-break-inside: avoid;
          }

          /* Allow breaks between cells */
          .report-cell + .report-cell {
            break-before: auto;
          }

          /* Tables should be readable */
          table {
            font-size: 9pt !important;
          }
          th,
          td {
            padding: 4px 6px !important;
          }

          /* Charts render at fixed size for print */
          .recharts-wrapper {
            max-width: 100% !important;
          }

          /* Code blocks */
          pre {
            white-space: pre-wrap !important;
            word-break: break-word !important;
            font-size: 8pt !important;
          }

          /* Footer */
          footer {
            break-before: avoid;
          }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TextCell({ cell }: { cell: ReportCell }) {
  const content = cell.content ?? "";
  if (!content.trim()) return null;

  return (
    <div className="report-cell">
      <div className="prose prose-zinc max-w-none text-sm dark:prose-invert">
        <Markdown content={content} />
      </div>
    </div>
  );
}

function QueryCell({ cell }: { cell: ReportCell }) {
  if (!cell.userMessage) return null;
  const question = extractText(cell.userMessage);

  if (cell.collapsed) {
    return (
      <section className="report-cell rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="font-mono text-xs font-medium">[{cell.number}]</span>
          <span className="truncate">{question}</span>
          <span className="ml-auto text-xs italic">collapsed</span>
        </div>
      </section>
    );
  }

  return (
    <section className="report-cell space-y-3">
      <h2 className="flex items-baseline gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">
        <span className="font-mono text-sm font-normal text-zinc-400 dark:text-zinc-500">
          [{cell.number}]
        </span>
        {question}
      </h2>

      {cell.assistantMessage ? (
        <div className="space-y-2 text-sm">
          {cell.assistantMessage.parts.map((part, i) => {
            if (part.type === "text") {
              const displayText = parseSuggestions(part.text).text;
              if (!displayText.trim()) return null;
              return <Markdown key={i} content={displayText} />;
            }
            if (isToolUIPart(part)) {
              return <ToolPart key={i} part={part} />;
            }
            return null;
          })}
        </div>
      ) : (
        <p className="text-xs italic text-zinc-400 dark:text-zinc-500">
          No output
        </p>
      )}
    </section>
  );
}

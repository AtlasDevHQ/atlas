"use client";

import { Printer } from "lucide-react";
import { isToolUIPart } from "ai";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/ui/components/chat/markdown";
import { ToolPart } from "@/ui/components/chat/tool-part";
import { parseSuggestions } from "@/ui/lib/helpers";
import type { SharedConversation } from "../../shared/lib";
import {
  resolveCells,
  extractText,
  type TextReportCell,
  type QueryReportCell,
} from "./report-cells";

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

      {/* Print styles — targets specific elements to work with Next.js DOM structure */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
@media print {
  @page { margin: 1.5cm 2cm; size: A4; }
  nav, button, [role="navigation"], a[href="#main"] { display: none !important; }
  html { color-scheme: light !important; }
  body, .dark body { background: white !important; color: #18181b !important; }
  .dark * { color: inherit !important; background: inherit !important; border-color: #e4e4e7 !important; }
  .report-view { max-width: 100% !important; padding: 0 !important; margin: 0 !important; }
  .report-cell { break-inside: avoid; page-break-inside: avoid; }
  table { font-size: 9pt !important; }
  th, td { padding: 4px 6px !important; }
  .recharts-wrapper { max-width: 100% !important; }
  pre { white-space: pre-wrap !important; word-break: break-word !important; font-size: 8pt !important; }
  footer { break-before: avoid; }
}`,
        }}
      />
    </div>
  );
}

function TextCell({ cell }: { cell: TextReportCell }) {
  if (!cell.content.trim()) return null;

  return (
    <div className="report-cell">
      <div className="prose prose-zinc max-w-none text-sm dark:prose-invert">
        <Markdown content={cell.content} />
      </div>
    </div>
  );
}

function QueryCell({ cell }: { cell: QueryReportCell }) {
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

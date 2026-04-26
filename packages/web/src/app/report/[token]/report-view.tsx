// server-only — do not add "use client" to this file. The header `<time>` and
// any future Date.now()-derived strings (cf. shared/dashboard/[token]/view.tsx)
// must run once at request time. Interactive affordances (Print, Copy link)
// live in `report-actions.tsx` as a small client island.

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { isToolUIPart } from "ai";
import { Markdown } from "@/ui/components/chat/markdown";
import { ToolPart } from "@/ui/components/chat/tool-part";
import { parseSuggestions } from "@/ui/lib/helpers";
import type { SharedConversation } from "../../shared/lib";
import { extractTextContent } from "../../shared/lib";
import {
  resolveCells,
  extractText,
  type TextReportCell,
  type QueryReportCell,
} from "./report-cells";
import { ReportActions } from "./report-actions";

interface ReportViewProps {
  conversation: SharedConversation;
}

export function ReportView({ conversation }: ReportViewProps) {
  const cells = resolveCells(conversation);
  const headingTitle = resolveHeadingTitle(conversation);
  const capturedDate = new Date(conversation.createdAt).toLocaleDateString(
    undefined,
    { year: "numeric", month: "short", day: "numeric" },
  );

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950 print:bg-white print:text-black">
      <main
        id="main"
        tabIndex={-1}
        className="report-view mx-auto w-full max-w-4xl flex-1 px-4 py-8 focus:outline-none print:max-w-full print:p-0"
      >
        <header className="mb-8 border-b border-zinc-200 pb-4 dark:border-zinc-800 print:border-zinc-300">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                Atlas
              </span>
              <span aria-hidden="true">&middot;</span>
              <span
                className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 print:bg-transparent print:px-0"
                aria-label="This is a read-only snapshot"
              >
                Read-only
              </span>
              <span aria-hidden="true">&middot;</span>
              <time dateTime={conversation.createdAt}>
                Captured {capturedDate}
              </time>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href="/signup"
                className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 transition-colors hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200 print:hidden"
              >
                Try Atlas free
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
              <ReportActions />
            </div>
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {headingTitle}
          </h1>
        </header>

        <div className="space-y-8">
          {cells.map((cell) => {
            if (cell.type === "text") {
              return <TextCell key={cell.id} cell={cell} />;
            }
            return <QueryCell key={cell.id} cell={cell} />;
          })}
        </div>
      </main>

      <footer className="border-t border-zinc-200 px-4 py-4 text-center dark:border-zinc-800 print:hidden">
        <a
          href="https://www.useatlas.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-teal-700 transition-colors hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200"
        >
          Powered by Atlas
        </a>
      </footer>
    </div>
  );
}

/**
 * Always render an h1: title -> first user message -> generic fallback.
 * A document with no h1 fails Lighthouse `heading-order` and weakens the
 * SEO/OG signal for the page.
 */
function resolveHeadingTitle(conversation: SharedConversation): string {
  if (conversation.title?.trim()) return conversation.title;
  const firstUser = conversation.messages.find((m) => m.role === "user");
  const text = firstUser ? extractTextContent(firstUser.content).trim() : "";
  if (text) return text.length > 80 ? text.slice(0, 79) + "…" : text;
  return "Atlas Report";
}

function TextCell({ cell }: { cell: TextReportCell }) {
  if (!cell.content.trim()) return null;
  return (
    <div className="report-cell">
      <div className="prose prose-zinc max-w-none text-sm prose-headings:tracking-tight prose-h2:mt-0 prose-h2:text-lg prose-h3:text-base dark:prose-invert">
        <Markdown content={cell.content} />
      </div>
    </div>
  );
}

function QueryCell({ cell }: { cell: QueryReportCell }) {
  const question = extractText(cell.userMessage);

  if (cell.collapsed) {
    return (
      <section className="report-cell rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/50 print:bg-transparent">
        <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span className="truncate">{question}</span>
          <span className="ml-auto text-xs italic">collapsed</span>
        </div>
      </section>
    );
  }

  return (
    <section className="report-cell space-y-3">
      <h2 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
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
        <p className="text-xs italic text-zinc-600 dark:text-zinc-400">
          No output
        </p>
      )}
    </section>
  );
}

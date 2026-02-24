"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName } from "ai";
import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

const transport = new DefaultChatTransport({ api: "/api/chat" });

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Extract tool invocation input from a ToolUIPart. Returns empty object if unavailable. */
function getToolArgs(part: unknown): Record<string, unknown> {
  if (part == null || typeof part !== "object") return {};
  const input = (part as Record<string, unknown>).input;
  if (input == null || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

/** Extract tool output from a ToolUIPart. Returns null if not yet available. */
function getToolResult(part: unknown): unknown {
  if (part == null || typeof part !== "object") return null;
  return (part as Record<string, unknown>).output ?? null;
}

/** True when the tool invocation has finished successfully (state is "output-available"). */
function isToolComplete(part: unknown): boolean {
  if (part == null || typeof part !== "object") return false;
  return (part as Record<string, unknown>).state === "output-available";
}

/** Parse a CSV string into headers + rows. Handles basic quoting and escaped quotes (""). */
function parseCSV(csv: string): { headers: string[]; rows: string[][] } {
  if (!csv || !csv.trim()) return { headers: [], rows: [] };

  const lines = csv.trim().split("\n");
  if (lines.length === 0) return { headers: [], rows: [] };

  function parseLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let k = 0; k < line.length; k++) {
      const char = line[k];
      if (char === '"') {
        if (inQuotes && line[k + 1] === '"') {
          current += '"';
          k++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  return {
    headers: parseLine(lines[0]),
    rows: lines
      .slice(1)
      .filter((l) => l.trim())
      .map(parseLine),
  };
}

/** Trigger a CSV download in the browser. */
function downloadCSV(csv: string, filename = "atlas-results.csv") {
  let url: string | null = null;
  try {
    const blob = new Blob([csv], { type: "text/csv" });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } catch {
    // Download failed — no good way to surface this without a toast system
  } finally {
    if (url) {
      const blobUrl = url;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    }
  }
}

/** Format a cell value: null as em-dash, numbers with locale formatting, else stringified. */
function formatCell(value: unknown): string {
  if (value == null) return "\u2014";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(value);
}

/* ------------------------------------------------------------------ */
/*  Starter prompts — curated examples inspired by the demo dataset    */
/* ------------------------------------------------------------------ */

const STARTER_PROMPTS = [
  "What are the top 10 companies by revenue?",
  "Show me the distribution of account types",
  "What is the headcount breakdown by department?",
  "What is total MRR by plan type?",
];

/* ------------------------------------------------------------------ */
/*  Shared components                                                  */
/* ------------------------------------------------------------------ */

function LoadingCard({ label }: { label: string }) {
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-500">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
      {label}
    </div>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
          setTimeout(() => setState("idle"), 2000);
        } catch {
          setState("failed");
          setTimeout(() => setState("idle"), 2000);
        }
      }}
      className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
    >
      {state === "copied" ? "Copied!" : state === "failed" ? "Failed" : label}
    </button>
  );
}

/**
 * Renders a data table from columns + rows.
 * Rows can be Record<string, unknown>[] (from executeSQL) or string[][] (from CSV).
 * Truncates to maxRows (default 10) with a footer count.
 */
function DataTable({
  columns,
  rows,
  maxRows = 10,
}: {
  columns: string[];
  rows: (Record<string, unknown> | unknown[])[];
  maxRows?: number;
}) {
  const display = rows.slice(0, maxRows);
  const hasMore = rows.length > maxRows;

  const cell = (row: Record<string, unknown> | unknown[], colIdx: number): unknown => {
    if (Array.isArray(row)) return row[colIdx];
    return (row as Record<string, unknown>)[columns[colIdx]];
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-700">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-700 bg-zinc-800/80">
            {columns.map((col, i) => (
              <th
                key={i}
                className="whitespace-nowrap px-3 py-2 text-left font-medium text-zinc-400"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {display.map((row, i) => (
            <tr
              key={i}
              className={i % 2 === 0 ? "bg-zinc-900/60" : "bg-zinc-900/30"}
            >
              {columns.map((_, j) => (
                <td key={j} className="whitespace-nowrap px-3 py-1.5 text-zinc-300">
                  {formatCell(cell(row, j))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && (
        <div className="border-t border-zinc-700 px-3 py-1.5 text-xs text-zinc-500">
          Showing {maxRows} of {rows.length} rows
        </div>
      )}
    </div>
  );
}

/** SQL code block with syntax highlighting and a copy button. */
function SQLBlock({ sql }: { sql: string }) {
  return (
    <div className="relative">
      <SyntaxHighlighter
        language="sql"
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: "0.5rem",
          fontSize: "0.75rem",
          padding: "0.75rem 1rem",
        }}
      >
        {sql}
      </SyntaxHighlighter>
      <div className="absolute right-2 top-2">
        <CopyButton text={sql} label="Copy SQL" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Markdown renderer                                                  */
/* ------------------------------------------------------------------ */

function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => (
          <p className="mb-3 leading-relaxed last:mb-0">{children}</p>
        ),
        h1: ({ children }) => (
          <h1 className="mb-2 mt-4 text-lg font-bold first:mt-0">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-1 mt-2 font-semibold first:mt-0">{children}</h3>
        ),
        ul: ({ children }) => (
          <ul className="mb-3 list-disc space-y-1 pl-4">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-3 list-decimal space-y-1 pl-4">{children}</ol>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-zinc-50">{children}</strong>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-zinc-600 pl-3 text-zinc-400">
            {children}
          </blockquote>
        ),
        pre: ({ children }) => <>{children}</>,
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          if (match) {
            return (
              <SyntaxHighlighter
                language={match[1]}
                style={oneDark}
                customStyle={{
                  margin: "0.5rem 0",
                  borderRadius: "0.5rem",
                  fontSize: "0.75rem",
                }}
              >
                {String(children).replace(/\n$/, "")}
              </SyntaxHighlighter>
            );
          }
          return (
            <code
              className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-xs text-zinc-200"
              {...props}
            >
              {children}
            </code>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

/* ------------------------------------------------------------------ */
/*  Tool result cards                                                  */
/* ------------------------------------------------------------------ */

/** Explore tool — terminal-style card showing command + output. */
function ExploreCard({ part }: { part: unknown }) {
  const args = getToolArgs(part);
  const result = getToolResult(part);
  const done = isToolComplete(part);
  const [open, setOpen] = useState(false);

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
      <button
        onClick={() => done && setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-800/60"
      >
        <span className="font-mono text-green-400">$</span>
        <span className="flex-1 truncate font-mono text-zinc-300">
          {String(args.command ?? "")}
        </span>
        {done ? (
          <span className="text-zinc-600">{open ? "\u25BE" : "\u25B8"}</span>
        ) : (
          <span className="animate-pulse text-zinc-500">running...</span>
        )}
      </button>
      {open && done && (
        <div className="border-t border-zinc-800 bg-zinc-950 px-3 py-2">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-400">
            {result != null
              ? typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2)
              : "(no output received)"}
          </pre>
        </div>
      )}
    </div>
  );
}

/** ExecuteSQL tool — compact table card. */
function SQLResultCard({ part }: { part: unknown }) {
  const args = getToolArgs(part);
  const result = getToolResult(part) as Record<string, unknown> | null;
  const done = isToolComplete(part);
  const [open, setOpen] = useState(false);

  if (!done) return <LoadingCard label="Executing query..." />;

  if (!result) {
    return (
      <div className="my-2 rounded-lg border border-yellow-900/50 bg-yellow-950/20 px-3 py-2 text-xs text-yellow-400">
        Query completed but no result was returned.
      </div>
    );
  }

  if (!result.success) {
    return (
      <div className="my-2 rounded-lg border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-400">
        Query failed. Check the query and try again.
      </div>
    );
  }

  const columns = (result.columns as string[]) ?? [];
  const rows = (result.rows as Record<string, unknown>[]) ?? [];

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-800/60"
      >
        <span className="rounded bg-blue-600/20 px-1.5 py-0.5 font-medium text-blue-400">
          SQL
        </span>
        <span className="flex-1 truncate text-zinc-400">
          {String(args.explanation ?? "Query result")}
        </span>
        <span className="text-zinc-500">
          {rows.length} row{rows.length !== 1 ? "s" : ""}
          {result.truncated ? "+" : ""}
        </span>
        <span className="text-zinc-600">{open ? "\u25BE" : "\u25B8"}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800">
          <DataTable columns={columns} rows={rows} />
        </div>
      )}
    </div>
  );
}

/** FinalizeReport tool — full report with narrative, data table, SQL, and actions. */
function ReportCard({ part }: { part: unknown }) {
  const result = getToolResult(part) as Record<string, unknown> | null;
  const done = isToolComplete(part);
  const [sqlOpen, setSqlOpen] = useState(false);

  if (!done) return <LoadingCard label="Preparing report..." />;

  if (!result) {
    return (
      <div className="my-2 rounded-lg border border-yellow-900/50 bg-yellow-950/20 px-3 py-2 text-xs text-yellow-400">
        Report completed but no data was returned.
      </div>
    );
  }

  const narrative = String(result.narrative ?? "");
  const sql = String(result.sql ?? "");
  const csv = String(result.csvResults ?? "");
  const { headers, rows } = parseCSV(csv);

  if (!narrative && !csv) {
    return (
      <div className="my-2 rounded-lg border border-yellow-900/50 bg-yellow-950/20 px-3 py-2 text-xs text-yellow-400">
        Report was generated but contains no data.
      </div>
    );
  }

  return (
    <div className="my-3 space-y-3">
      {narrative && (
        <div className="text-sm leading-relaxed text-zinc-200">
          <Markdown content={narrative} />
        </div>
      )}

      {headers.length > 0 && rows.length > 0 && (
        <DataTable columns={headers} rows={rows} maxRows={20} />
      )}

      <div className="flex items-center gap-2">
        {sql && (
          <button
            onClick={() => setSqlOpen(!sqlOpen)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
          >
            {sqlOpen ? "Hide SQL" : "Show SQL"}
          </button>
        )}
        {csv && (
          <button
            onClick={() => downloadCSV(csv)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
          >
            Download CSV
          </button>
        )}
      </div>
      {sqlOpen && sql && <SQLBlock sql={sql} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Typing indicator                                                   */
/* ------------------------------------------------------------------ */

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1 rounded-xl bg-zinc-800 px-4 py-3">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500" />
        <span
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500"
          style={{ animationDelay: "150ms" }}
        />
        <span
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500"
          style={{ animationDelay: "300ms" }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tool part dispatcher                                               */
/* ------------------------------------------------------------------ */

function ToolPart({ part }: { part: unknown }) {
  let name: string;
  try {
    name = getToolName(part as Parameters<typeof getToolName>[0]);
  } catch {
    return null;
  }

  switch (name) {
    case "explore":
      return <ExploreCard part={part} />;
    case "executeSQL":
      return <SQLResultCard part={part} />;
    case "finalizeReport":
      return <ReportCard part={part} />;
    default:
      return (
        <div className="my-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-500">
          Tool: {name}
        </div>
      );
  }
}

/* ================================================================== */
/*  Main page                                                          */
/* ================================================================== */

export default function Home() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({ transport });
  const scrollRef = useRef<HTMLDivElement>(null);

  const isLoading = status === "streaming" || status === "submitted";

  // Auto-scroll only when user is already near the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  function handleSend(text: string) {
    if (!text.trim()) return;
    const saved = text;
    setInput("");
    sendMessage({ text: saved }).catch(() => {
      setInput(saved);
    });
  }

  return (
    <div className="mx-auto flex h-dvh max-w-4xl flex-col p-4">
      <header className="mb-4 flex-none border-b border-zinc-800 pb-3">
        <h1 className="text-xl font-semibold tracking-tight">Atlas</h1>
        <p className="text-sm text-zinc-500">Ask your data anything</p>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pb-4">
        {messages.length === 0 && !error && (
          <div className="flex h-full flex-col items-center justify-center gap-6">
            <div className="text-center">
              <p className="text-lg font-medium text-zinc-400">
                What would you like to know?
              </p>
              <p className="mt-1 text-sm text-zinc-600">
                Ask a question about your data to get started
              </p>
            </div>
            <div className="grid w-full max-w-lg grid-cols-2 gap-2">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handleSend(prompt)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-left text-sm text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-xl bg-blue-600 px-4 py-3 text-sm text-white">
                  {m.parts?.map((part, i) =>
                    part.type === "text" ? (
                      <p key={i} className="whitespace-pre-wrap">
                        {part.text}
                      </p>
                    ) : null,
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={m.id} className="space-y-2">
              {m.parts?.map((part, i) => {
                if (part.type === "text" && part.text.trim()) {
                  return (
                    <div key={i} className="max-w-[90%]">
                      <div className="rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-200">
                        <Markdown content={part.text} />
                      </div>
                    </div>
                  );
                }
                if (isToolUIPart(part)) {
                  return (
                    <div key={i} className="max-w-[95%]">
                      <ToolPart part={part} />
                    </div>
                  );
                }
                return null;
              })}
            </div>
          );
        })}

        {isLoading && messages.length > 0 && <TypingIndicator />}
      </div>

      {error && (
        <div className="mb-2 rounded-lg border border-red-900/50 bg-red-950/20 px-4 py-3 text-sm text-red-400">
          Failed to get a response. Please try again.
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend(input);
        }}
        className="flex flex-none gap-2 border-t border-zinc-800 pt-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about your data..."
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-blue-500"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="rounded-lg bg-blue-600 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </div>
  );
}

import type { UIMessage } from "@ai-sdk/react";
import type { ResolvedCell } from "./types";
import { extractTextContent } from "./use-notebook";
import { getToolArgs, getToolResult, isToolComplete } from "../../lib/helpers";

/** Escape &, <, >, ", and ' for safe embedding in HTML element content and attributes. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape pipe and newline characters for safe embedding in Markdown table cells. */
function escapeMarkdownTableCell(str: string): string {
  return str.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Format column/row data as a Markdown table. Caps output at 100 rows for readability. */
function toMarkdownTable(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  if (columns.length === 0) return "";
  const header = `| ${columns.map(escapeMarkdownTableCell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, 100) // Cap at 100 rows for readability
    .map((row) => `| ${columns.map((c) => escapeMarkdownTableCell(String(row[c] ?? ""))).join(" | ")} |`)
    .join("\n");
  const truncation =
    rows.length > 100 ? `\n\n*...and ${rows.length - 100} more rows*` : "";
  return `${header}\n${divider}\n${body}${truncation}`;
}

/** Format column/row data as an HTML table. Caps output at 100 rows for readability. */
function toHtmlTable(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  if (columns.length === 0) return "";
  const ths = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const trs = rows
    .slice(0, 100)
    .map(
      (row) =>
        `<tr>${columns.map((c) => `<td>${escapeHtml(String(row[c] ?? ""))}</td>`).join("")}</tr>`,
    )
    .join("\n      ");
  const truncation =
    rows.length > 100
      ? `<tr><td colspan="${columns.length}" style="text-align:center;font-style:italic">...and ${rows.length - 100} more rows</td></tr>`
      : "";
  return `<table>
    <thead><tr>${ths}</tr></thead>
    <tbody>
      ${trs}
      ${truncation}
    </tbody>
  </table>`;
}

/** Extract tool-specific data (SQL query/results, Python code/stdout) from a tool invocation part. */
function extractToolData(part: unknown): {
  toolName: string;
  sql?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  code?: string;
  stdout?: string;
} {
  const args = getToolArgs(part);
  const result = isToolComplete(part) ? getToolResult(part) : null;
  const p = part as Record<string, unknown> | null;
  const toolName = typeof p?.toolName === "string" ? p.toolName : "unknown";

  const data: ReturnType<typeof extractToolData> = { toolName };

  if (toolName === "executeSQL") {
    if (typeof args.sql === "string") data.sql = args.sql;
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r.columns)) data.columns = r.columns as string[];
      if (Array.isArray(r.rows))
        data.rows = r.rows as Record<string, unknown>[];
    }
  }

  if (toolName === "executePython") {
    if (typeof args.code === "string") data.code = args.code;
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (typeof r.stdout === "string") data.stdout = r.stdout;
    }
  }

  return data;
}

/** Serialize all parts of an assistant message (text and tool invocations) into Markdown sections. */
function serializeToolPartsMarkdown(message: UIMessage): string {
  const sections: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      sections.push(part.text);
    } else if (part.type === "tool-invocation") {
      const data = extractToolData(part);
      if (data.sql) sections.push(`\`\`\`sql\n${data.sql}\n\`\`\``);
      if (data.columns && data.rows) {
        sections.push(toMarkdownTable(data.columns, data.rows));
      }
      if (data.code) sections.push(`\`\`\`python\n${data.code}\n\`\`\``);
      if (data.stdout) sections.push(`\`\`\`\n${data.stdout}\n\`\`\``);
    }
  }
  return sections.join("\n\n");
}

/** Serialize all parts of an assistant message (text and tool invocations) into HTML sections. */
function serializeToolPartsHtml(message: UIMessage): string {
  const sections: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      const paragraphs = part.text
        .split("\n\n")
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join("\n");
      sections.push(paragraphs);
    } else if (part.type === "tool-invocation") {
      const data = extractToolData(part);
      if (data.sql) {
        sections.push(
          `<pre class="code sql"><code>${escapeHtml(data.sql)}</code></pre>`,
        );
      }
      if (data.columns && data.rows) {
        sections.push(toHtmlTable(data.columns, data.rows));
      }
      if (data.code) {
        sections.push(
          `<pre class="code python"><code>${escapeHtml(data.code)}</code></pre>`,
        );
      }
      if (data.stdout) {
        sections.push(
          `<pre class="stdout"><code>${escapeHtml(data.stdout)}</code></pre>`,
        );
      }
    }
  }
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Export notebook cells as a Markdown string. Starts with an H1 header; text cells render as-is, query cells as H2 with cell number. */
export function exportToMarkdown(cells: ResolvedCell[]): string {
  const sections: string[] = ["# Atlas Notebook Export\n"];

  for (const cell of cells) {
    try {
      if (cell.type === "text") {
        sections.push(cell.content ?? "");
        continue;
      }

      // Query cell
      const question = extractTextContent(cell.userMessage);
      sections.push(`## [${cell.number}] ${question}`);

      if (cell.assistantMessage) {
        sections.push(serializeToolPartsMarkdown(cell.assistantMessage));
      }
    } catch (err: unknown) {
      console.warn(
        `Export: skipped cell ${cell.number} due to error:`,
        err instanceof Error ? err.message : String(err),
      );
      sections.push(`## [${cell.number}] (export error — cell data could not be serialized)`);
    }
  }

  return sections.join("\n\n");
}

/** Export notebook cells as a self-contained HTML document with inline CSS. No external dependencies. */
export function exportToHTML(cells: ResolvedCell[]): string {
  const bodyParts: string[] = [];

  for (const cell of cells) {
    try {
      if (cell.type === "text") {
        const paragraphs = (cell.content ?? "")
          .split("\n\n")
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("\n");
        bodyParts.push(`<section class="text-cell">${paragraphs}</section>`);
        continue;
      }

      // Query cell
      const question = extractTextContent(cell.userMessage);
      let content = `<h2><span class="cell-num">[${cell.number}]</span> ${escapeHtml(question)}</h2>`;
      if (cell.assistantMessage) {
        content += `<div class="response">${serializeToolPartsHtml(cell.assistantMessage)}</div>`;
      }
      bodyParts.push(`<section class="cell">${content}</section>`);
    } catch (err: unknown) {
      console.warn(
        `Export: skipped cell ${cell.number} due to error:`,
        err instanceof Error ? err.message : String(err),
      );
      bodyParts.push(`<section class="cell"><h2>[${cell.number}]</h2><p><em>Export error — cell data could not be serialized.</em></p></section>`);
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Atlas Notebook Export</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #18181b;
      max-width: 860px;
      margin: 0 auto;
      padding: 2rem 1rem;
      background: #fff;
    }
    h1 { font-size: 1.5rem; border-bottom: 2px solid #e4e4e7; padding-bottom: 0.5rem; margin-bottom: 2rem; }
    h2 { font-size: 1.1rem; margin: 0 0 0.75rem; color: #27272a; }
    .cell-num { color: #71717a; font-weight: normal; }
    section { border: 1px solid #e4e4e7; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; }
    section.text-cell { border-style: dashed; background: #fafafa; }
    .response { margin-top: 0.5rem; }
    p { margin: 0 0 0.75rem; }
    p:last-child { margin-bottom: 0; }
    pre { background: #f4f4f5; border-radius: 6px; padding: 0.75rem 1rem; overflow-x: auto; font-size: 0.8rem; margin: 0.5rem 0; }
    pre.stdout { background: #fefce8; border: 1px solid #fef08a; }
    code { font-family: 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 0.5rem 0; }
    th, td { text-align: left; padding: 0.4rem 0.6rem; border: 1px solid #e4e4e7; }
    th { background: #f4f4f5; font-weight: 600; font-size: 0.8rem; color: #52525b; }
    footer { text-align: center; color: #a1a1aa; font-size: 0.75rem; margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e4e4e7; }
  </style>
</head>
<body>
  <h1>Atlas Notebook Export</h1>
  ${bodyParts.join("\n  ")}
  <footer>Exported from Atlas</footer>
</body>
</html>`;
}

/** Trigger a file download in the browser. */
export function downloadFile(
  content: string,
  filename: string,
  mimeType = "text/plain",
): void {
  let url: string | null = null;
  try {
    const blob = new Blob([content], { type: mimeType });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("Download failed:", detail);
    window.alert(`Download failed: ${detail}. Try again or copy the content manually.`);
  } finally {
    if (url) {
      const blobUrl = url;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    }
  }
}

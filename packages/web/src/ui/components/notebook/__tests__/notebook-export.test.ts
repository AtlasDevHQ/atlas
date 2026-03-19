import { describe, expect, test } from "bun:test";
import type { UIMessage } from "@ai-sdk/react";
import type { ResolvedCell } from "../types";
import { exportToMarkdown, exportToHTML } from "../notebook-export";

function makeQueryCell(
  number: number,
  question: string,
  assistantParts: UIMessage["parts"] = [],
): ResolvedCell {
  return {
    id: `cell-${number}`,
    messageId: `u${number}`,
    number,
    collapsed: false,
    editing: false,
    status: "idle",
    userMessage: {
      id: `u${number}`,
      role: "user",
      parts: [{ type: "text", text: question }],
    },
    assistantMessage: assistantParts.length > 0
      ? { id: `a${number}`, role: "assistant", parts: assistantParts }
      : null,
  };
}

function makeTextCell(number: number, content: string): ResolvedCell {
  return {
    id: `text-${number}`,
    messageId: "",
    number,
    collapsed: false,
    editing: false,
    status: "idle",
    type: "text",
    content,
    userMessage: {
      id: `text-${number}`,
      role: "user",
      parts: [{ type: "text", text: content }],
    },
    assistantMessage: null,
  };
}

describe("exportToMarkdown", () => {
  test("exports empty notebook", () => {
    const md = exportToMarkdown([]);
    expect(md).toContain("# Atlas Notebook Export");
  });

  test("exports query cell with text response", () => {
    const cells: ResolvedCell[] = [
      makeQueryCell(1, "How many users?", [
        { type: "text", text: "There are 42 users." },
      ]),
    ];
    const md = exportToMarkdown(cells);
    expect(md).toContain("## [1] How many users?");
    expect(md).toContain("There are 42 users.");
  });

  test("exports query cell with SQL tool invocation", () => {
    const cells: ResolvedCell[] = [
      makeQueryCell(1, "Count users", [
        { type: "text", text: "Here are the results:" },
        {
          type: "tool-invocation",
          toolInvocationId: "t1",
          toolName: "executeSQL",
          state: "output-available",
          input: { sql: "SELECT COUNT(*) as cnt FROM users" },
          output: {
            columns: ["cnt"],
            rows: [{ cnt: 42 }],
          },
        } as unknown as UIMessage["parts"][number],
      ]),
    ];
    const md = exportToMarkdown(cells);
    expect(md).toContain("```sql");
    expect(md).toContain("SELECT COUNT(*) as cnt FROM users");
    expect(md).toContain("| cnt |");
    expect(md).toContain("| 42 |");
  });

  test("exports text cells as raw markdown", () => {
    const cells: ResolvedCell[] = [
      makeQueryCell(1, "First query"),
      makeTextCell(2, "## Analysis Notes\n\nThis section documents key findings."),
      makeQueryCell(3, "Second query"),
    ];
    const md = exportToMarkdown(cells);
    expect(md).toContain("## [1] First query");
    expect(md).toContain("## Analysis Notes");
    expect(md).toContain("This section documents key findings.");
    expect(md).toContain("## [3] Second query");
  });

  test("exports mixed cell types in order", () => {
    const cells: ResolvedCell[] = [
      makeTextCell(1, "# Introduction"),
      makeQueryCell(2, "Get data", [{ type: "text", text: "Here is the data." }]),
      makeTextCell(3, "## Conclusion"),
    ];
    const md = exportToMarkdown(cells);

    const introIdx = md.indexOf("# Introduction");
    const dataIdx = md.indexOf("## [2] Get data");
    const conclusionIdx = md.indexOf("## Conclusion");

    expect(introIdx).toBeLessThan(dataIdx);
    expect(dataIdx).toBeLessThan(conclusionIdx);
  });

  test("handles query cell with no response", () => {
    const cells: ResolvedCell[] = [
      makeQueryCell(1, "Pending query"),
    ];
    const md = exportToMarkdown(cells);
    expect(md).toContain("## [1] Pending query");
    // Should not crash — just no response section
  });

  test("exports Python tool invocation", () => {
    const cells: ResolvedCell[] = [
      makeQueryCell(1, "Run analysis", [
        {
          type: "tool-invocation",
          toolInvocationId: "t1",
          toolName: "executePython",
          state: "output-available",
          input: { code: "print('hello')" },
          output: { stdout: "hello\n" },
        } as unknown as UIMessage["parts"][number],
      ]),
    ];
    const md = exportToMarkdown(cells);
    expect(md).toContain("```python");
    expect(md).toContain("print('hello')");
    expect(md).toContain("hello");
  });
});

describe("exportToHTML", () => {
  test("produces valid HTML document", () => {
    const html = exportToHTML([]);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("</html>");
    expect(html).toContain("<style>");
    expect(html).toContain("Exported from Atlas");
  });

  test("exports query cell as section", () => {
    const cells: ResolvedCell[] = [
      makeQueryCell(1, "How many users?", [
        { type: "text", text: "There are 42 users." },
      ]),
    ];
    const html = exportToHTML(cells);
    expect(html).toContain('<section class="cell">');
    expect(html).toContain("[1]");
    expect(html).toContain("How many users?");
    expect(html).toContain("There are 42 users.");
  });

  test("exports text cell with dashed border style", () => {
    const cells: ResolvedCell[] = [
      makeTextCell(1, "Some notes here"),
    ];
    const html = exportToHTML(cells);
    expect(html).toContain('<section class="text-cell">');
    expect(html).toContain("Some notes here");
  });

  test("exports SQL results as HTML table", () => {
    const cells: ResolvedCell[] = [
      makeQueryCell(1, "Count users", [
        {
          type: "tool-invocation",
          toolInvocationId: "t1",
          toolName: "executeSQL",
          state: "output-available",
          input: { sql: "SELECT name FROM users" },
          output: {
            columns: ["name"],
            rows: [{ name: "Alice" }, { name: "Bob" }],
          },
        } as unknown as UIMessage["parts"][number],
      ]),
    ];
    const html = exportToHTML(cells);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>name</th>");
    expect(html).toContain("<td>Alice</td>");
    expect(html).toContain("<td>Bob</td>");
  });

  test("escapes HTML entities in content", () => {
    const cells: ResolvedCell[] = [
      makeQueryCell(1, "Query with <script>alert('xss')</script>", [
        { type: "text", text: "Result: <b>bold</b> & 'quoted'" },
      ]),
    ];
    const html = exportToHTML(cells);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&amp;");
  });

  test("is self-contained — inline styles, no external deps", () => {
    const cells: ResolvedCell[] = [
      makeQueryCell(1, "Test"),
    ];
    const html = exportToHTML(cells);
    // Should have inline styles, not external stylesheet links
    expect(html).toContain("<style>");
    expect(html).not.toContain('<link rel="stylesheet"');
  });
});

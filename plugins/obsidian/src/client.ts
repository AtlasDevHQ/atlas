export interface TextEvent {
  type: "text";
  text: string;
}

export interface ResultEvent {
  type: "result";
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface ErrorEvent {
  type: "error";
  error: string;
}

export interface FinishEvent {
  type: "finish";
}

export type AtlasEvent = TextEvent | ResultEvent | ErrorEvent | FinishEvent;

/**
 * Stream a natural-language query to the Atlas chat endpoint.
 * Parses the Vercel AI SDK data stream protocol and yields typed events.
 */
export async function* queryAtlas(
  baseUrl: string,
  apiKey: string,
  question: string
): AsyncGenerator<AtlasEvent> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/chat`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: question }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "Unknown error");
    yield { type: "error", error: `HTTP ${response.status}: ${body}` };
    return;
  }

  if (!response.body) {
    yield { type: "error", error: "No response body" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.length === 0) continue;

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const prefix = line.substring(0, colonIdx);
      const payload = line.substring(colonIdx + 1);

      try {
        switch (prefix) {
          case "0": // text delta
            yield { type: "text", text: JSON.parse(payload) };
            break;
          case "b": { // tool result
            const parsed = JSON.parse(payload);
            const result = parsed.result;
            if (
              result &&
              Array.isArray(result.columns) &&
              Array.isArray(result.rows)
            ) {
              yield {
                type: "result",
                columns: result.columns,
                rows: result.rows,
              };
            }
            break;
          }
          case "3": // error
            yield { type: "error", error: JSON.parse(payload) };
            break;
          case "d": // finish
            yield { type: "finish" };
            break;
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }
}

/** Convert a query result to a Markdown table. */
export function resultToMarkdown(
  columns: string[],
  rows: Record<string, unknown>[]
): string {
  if (columns.length === 0) return "*No results*";

  const escape = (v: unknown) =>
    String(v ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ");

  const header = `| ${columns.map(escape).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((row) => `| ${columns.map((col) => escape(row[col])).join(" | ")} |`)
    .join("\n");

  return `${header}\n${separator}\n${body}`;
}

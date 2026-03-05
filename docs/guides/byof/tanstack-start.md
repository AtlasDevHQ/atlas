# BYOF: TanStack Start

Integrate Atlas into a TanStack Start app using plain `fetch` or TanStack Query.

TanStack Start is a full-stack React framework. Unlike the other BYOF guides, this one does **not** use `@ai-sdk/react` -- it shows how to consume the Atlas API directly, which works with any HTTP client.

> **Prerequisites:** A running Atlas API server. See [byof-overview.md](./byof-overview.md) for architecture and common setup.

---

## 1. Install dependencies

For the streaming approach:

```bash
bun add @tanstack/react-query
```

No AI SDK packages are required. If you prefer the `useChat` hook, you can install `@ai-sdk/react` and follow the [React Vite guide](./byof-react-vite.md) -- it works the same in TanStack Start.

## 2. Configure the API URL

### Option A: Same-origin proxy (recommended)

TanStack Start uses Vinxi (Vite-based). Configure the proxy in `app.config.ts`:

```typescript
// app.config.ts
import { defineConfig } from "@tanstack/react-start/config";

export default defineConfig({
  vite: {
    server: {
      proxy: {
        "/api": {
          target: "http://localhost:3001",
          changeOrigin: true,
        },
      },
    },
  },
});
```

### Option B: Cross-origin

```bash
# .env
VITE_ATLAS_API_URL=http://localhost:3001
```

```bash
# Atlas API .env
ATLAS_CORS_ORIGIN=http://localhost:3000
```

## 3. Synchronous queries with TanStack Query

The simplest integration uses the JSON query endpoint (`POST /api/v1/query`). No streaming protocol to parse.

```typescript
// src/lib/atlas.ts
const API_URL = import.meta.env.VITE_ATLAS_API_URL ?? "";

export interface AtlasQueryResult {
  answer: string;
  sql: string[];
  data: Array<{ columns: string[]; rows: Record<string, unknown>[] }>;
  steps: number;
  usage: { totalTokens: number };
}

export async function queryAtlas(
  question: string,
  opts?: { apiKey?: string; signal?: AbortSignal }
): Promise<AtlasQueryResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts?.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

  const res = await fetch(`${API_URL}/api/v1/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ question }),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Atlas query failed: ${res.status}`);
  }

  return res.json();
}
```

### Query hook

```typescript
// src/hooks/use-atlas-query.ts
import { useMutation } from "@tanstack/react-query";
import { queryAtlas, type AtlasQueryResult } from "../lib/atlas";

export function useAtlasQuery(apiKey?: string) {
  return useMutation<AtlasQueryResult, Error, string>({
    mutationFn: (question) => queryAtlas(question, { apiKey }),
  });
}
```

### Query page

```tsx
// src/routes/index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAtlasQuery } from "../hooks/use-atlas-query";

export const Route = createFileRoute("/")({
  component: AtlasPage,
});

function AtlasPage() {
  const [input, setInput] = useState("");
  const [apiKey, setApiKey] = useState("");
  const query = useAtlasQuery(apiKey);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    query.mutate(input);
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      <h1 className="mb-4 text-xl font-bold">Atlas</h1>

      <div className="mb-4">
        <input
          type="password"
          placeholder="API key (if required)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="w-full rounded border px-3 py-2 text-sm"
        />
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about your data..."
          className="flex-1 rounded border px-4 py-2 text-sm"
          disabled={query.isPending}
        />
        <button
          type="submit"
          disabled={query.isPending || !input.trim()}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          Ask
        </button>
      </form>

      {query.isPending && (
        <div className="mt-4 animate-pulse text-sm text-zinc-500">Thinking...</div>
      )}

      {query.error && (
        <div className="mt-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {query.error.message}
        </div>
      )}

      {query.data && (
        <div className="mt-4 space-y-4">
          <div className="rounded-lg bg-zinc-100 px-4 py-3 text-sm dark:bg-zinc-800">
            {query.data.answer}
          </div>

          {query.data.data.map((d, idx) =>
            d.columns.length > 0 ? (
              <div key={idx} className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b bg-zinc-50 dark:bg-zinc-900">
                      {d.columns.map((col) => (
                        <th key={col} className="px-3 py-1.5 font-medium text-zinc-500">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.slice(0, 50).map((row, i) => (
                      <tr key={i} className="border-b last:border-0">
                        {d.columns.map((col) => (
                          <td key={col} className="px-3 py-1.5">
                            {row[col] != null ? String(row[col]) : "\u2014"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null
          )}

          {query.data.sql.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-zinc-500">Show SQL</summary>
              {query.data.sql.map((s, i) => (
                <pre key={i} className="mt-2 overflow-x-auto rounded bg-zinc-900 p-3 font-mono text-zinc-300">
                  {s}
                </pre>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
```

## 4. Streaming with plain fetch

For a streaming experience without `@ai-sdk/react`, consume the Data Stream Protocol directly. The chat endpoint returns a stream of text chunks prefixed with type markers.

```typescript
// src/lib/atlas-stream.ts
const API_URL = import.meta.env.VITE_ATLAS_API_URL ?? "";

export interface StreamMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Stream a chat response from Atlas.
 * Calls onChunk for each text delta, onDone when the stream ends.
 */
export async function streamChat(opts: {
  messages: Array<{ role: string; content: string }>;
  apiKey?: string;
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
  signal?: AbortSignal;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

  const res = await fetch(`${API_URL}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: opts.messages }),
    signal: opts.signal,
  });

  if (!res.ok) {
    opts.onError(new Error(`Atlas chat failed: ${res.status}`));
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    opts.onError(new Error("No response body"));
    return;
  }

  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    // The Data Stream Protocol prefixes text chunks with "0:"
    for (const line of chunk.split("\n")) {
      if (line.startsWith("0:")) {
        // Text delta — the value after "0:" is a JSON-encoded string
        try {
          const text = JSON.parse(line.slice(2));
          if (typeof text === "string") opts.onChunk(text);
        } catch {
          // Not a text chunk, skip
        }
      }
      // Other prefixes (e.g., "9:" for tool calls) can be parsed similarly.
      // See: https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol#data-stream-protocol
    }
  }

  opts.onDone();
}
```

> **Tip:** For full tool call support in the streaming path, consider using `@ai-sdk/react`'s `useChat` instead -- it handles the entire Data Stream Protocol including tool calls, message parts, and conversation state. See the [React Vite guide](./byof-react-vite.md).

## 5. Dark mode

Same approach as any Vite + React app. Toggle the `dark` class on `<html>`:

```typescript
// src/hooks/use-dark-mode.ts
import { useState, useEffect } from "react";

export function useDarkMode() {
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return { dark, setDark };
}
```

## 6. Which approach to choose

| Approach | Streaming | Tool cards | Complexity |
|----------|-----------|------------|------------|
| TanStack Query + `/api/v1/query` | No | Table from `data` field | Simplest |
| Plain `fetch` stream | Text only | Manual parsing | Medium |
| `@ai-sdk/react` `useChat` | Full | Built-in message parts | Full featured |

For most TanStack Start apps, start with the TanStack Query approach. Add `@ai-sdk/react` later if you need real-time streaming with tool call visualization.

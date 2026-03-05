# BYOF: React (Vite)

Integrate Atlas into a plain React app (Vite, no Next.js) using `@ai-sdk/react`.

> **Prerequisites:** A running Atlas API server. See [byof-overview.md](./byof-overview.md) for architecture and common setup.

---

## 1. Install dependencies

```bash
bun add @ai-sdk/react ai
```

## 2. Configure the API URL

### Option A: Same-origin proxy (recommended)

Configure Vite's dev server to proxy `/api` to the Atlas API:

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
```

With this setup, leave `VITE_ATLAS_API_URL` unset. Your app fetches `/api/chat` which Vite proxies to the Atlas API.

For production, configure your reverse proxy or CDN (nginx, Caddy, Cloudflare Pages) to forward `/api/*` to the Atlas API server.

### Option B: Cross-origin

Point directly at the Atlas API:

```bash
# .env
VITE_ATLAS_API_URL=http://localhost:3001
```

Set CORS on the Atlas API side:

```bash
# Atlas API .env
ATLAS_CORS_ORIGIN=http://localhost:5173
```

## 3. Chat hook

Create a thin wrapper around `@ai-sdk/react`'s `useChat` -- this is the same hook that `@atlas/web` uses internally:

```typescript
// src/hooks/use-atlas-chat.ts
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useMemo } from "react";

const API_URL = import.meta.env.VITE_ATLAS_API_URL ?? "";

export function useAtlasChat() {
  const [apiKey, setApiKey] = useState(() => {
    try {
      return sessionStorage.getItem("atlas-api-key") ?? "";
    } catch {
      return "";
    }
  });

  const transport = useMemo(() => {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    return new DefaultChatTransport({
      api: `${API_URL}/api/chat`,
      headers,
    });
  }, [apiKey]);

  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({ transport });

  function saveApiKey(key: string) {
    setApiKey(key);
    try {
      sessionStorage.setItem("atlas-api-key", key);
    } catch {
      // sessionStorage unavailable
    }
  }

  return {
    messages,
    sendMessage,
    status,
    error,
    input,
    setInput,
    apiKey,
    saveApiKey,
    isLoading: status === "streaming" || status === "submitted",
  };
}
```

## 4. Chat component

```tsx
// src/App.tsx
import { useAtlasChat } from "./hooks/use-atlas-chat";
import { ToolPart } from "./components/ToolPart";

export default function App() {
  const { messages, input, setInput, sendMessage, isLoading, apiKey, saveApiKey } =
    useAtlasChat();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    const text = input;
    setInput("");
    sendMessage({ text });
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      <h1 className="mb-4 text-xl font-bold">Atlas</h1>

      {/* API key input (only needed for api-key auth mode) */}
      <div className="mb-4">
        <input
          type="password"
          placeholder="API key (if required)"
          value={apiKey}
          onChange={(e) => saveApiKey(e.target.value)}
          className="w-full rounded border px-3 py-2 text-sm"
        />
      </div>

      {/* Messages */}
      <div className="space-y-4">
        {messages.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="rounded-lg bg-blue-600 px-4 py-2 text-white">
                  {m.parts?.map((part, i) =>
                    part.type === "text" ? <p key={i}>{part.text}</p> : null
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
                    <div
                      key={i}
                      className="rounded-lg bg-zinc-100 px-4 py-2 text-sm dark:bg-zinc-800"
                    >
                      {part.text}
                    </div>
                  );
                }
                if (part.type.startsWith("tool-")) {
                  return <ToolPart key={i} part={part} />;
                }
                return null;
              })}
            </div>
          );
        })}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about your data..."
          className="flex-1 rounded border px-4 py-2 text-sm dark:bg-zinc-900"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </div>
  );
}
```

## 5. Tool call rendering

Atlas streams tool calls as structured parts in the message. The two main tools are `explore` (semantic layer filesystem reads) and `executeSQL` (query execution with tabular results).

```tsx
// src/components/ToolPart.tsx
import { useState } from "react";

interface ToolPartProps {
  part: unknown;
}

function getToolName(part: unknown): string {
  if (!part || typeof part !== "object") return "unknown";
  return String((part as Record<string, unknown>).toolName ?? "unknown");
}

function getArgs(part: unknown): Record<string, unknown> {
  if (!part || typeof part !== "object") return {};
  const input = (part as Record<string, unknown>).input;
  return (input as Record<string, unknown>) ?? {};
}

function getResult(part: unknown): unknown {
  if (!part || typeof part !== "object") return null;
  return (part as Record<string, unknown>).output ?? null;
}

function isDone(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  return (part as Record<string, unknown>).state === "output-available";
}

export function ToolPart({ part }: ToolPartProps) {
  const [open, setOpen] = useState(false);
  const name = getToolName(part);
  const args = getArgs(part);
  const result = getResult(part) as Record<string, unknown> | string | null;
  const done = isDone(part);

  if (name === "explore") {
    return (
      <div className="my-2 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
        <button
          onClick={() => done && setOpen(!open)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
        >
          <span className="font-mono text-green-400">$</span>
          <span className="flex-1 truncate font-mono">{String(args.command ?? "")}</span>
          {!done && <span className="animate-pulse text-zinc-500">running...</span>}
        </button>
        {open && done && (
          <pre className="max-h-60 overflow-auto border-t px-3 py-2 font-mono text-xs">
            {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  if (name === "executeSQL") {
    const success = typeof result === "object" && result !== null && result.success;
    const columns = success ? ((result as Record<string, unknown>).columns as string[]) ?? [] : [];
    const rows = success
      ? ((result as Record<string, unknown>).rows as Record<string, unknown>[]) ?? []
      : [];

    return (
      <div className="my-2 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
        >
          <span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-600/20 dark:text-blue-400">
            SQL
          </span>
          <span className="flex-1 truncate text-zinc-500">
            {String(args.explanation ?? "Query result")}
          </span>
          <span className="text-zinc-500">
            {rows.length} row{rows.length !== 1 ? "s" : ""}
          </span>
        </button>
        {open && done && columns.length > 0 && (
          <div className="overflow-x-auto border-t">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b bg-zinc-50 dark:bg-zinc-900">
                  {columns.map((col) => (
                    <th key={col} className="px-3 py-1.5 font-medium text-zinc-500">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {columns.map((col) => (
                      <td key={col} className="px-3 py-1.5">
                        {row[col] != null ? String(row[col]) : "\u2014"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 50 && (
              <div className="px-3 py-2 text-xs text-zinc-400">
                Showing 50 of {rows.length} rows
              </div>
            )}
          </div>
        )}
        {done && !success && (
          <div className="border-t px-3 py-2 text-xs text-red-600 dark:text-red-400">
            Query failed. Check the query and try again.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700">
      Tool: {name}
    </div>
  );
}
```

## 6. Dark mode

Use Tailwind's `darkMode: "class"` strategy and toggle the `dark` class on `<html>`:

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

All the tool components above use `dark:` Tailwind variants, so they respond automatically.

## 7. Synchronous queries (alternative)

For non-streaming use cases, call the JSON endpoint directly:

```typescript
// src/lib/atlas-query.ts
const API_URL = import.meta.env.VITE_ATLAS_API_URL ?? "";

export async function queryAtlas(question: string, apiKey?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${API_URL}/api/v1/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ question }),
  });

  if (!res.ok) throw new Error(`Atlas query failed: ${res.status}`);
  return res.json(); // { answer: string, sql: string[], data: Array<{columns, rows}>, steps: number, usage: {totalTokens} }
}
```

See [byof-overview.md](./byof-overview.md#what-atlasweb-adds) for what `@atlas/web` adds on top of `@ai-sdk/react` (conversation sidebar, chart detection, managed auth, etc.).

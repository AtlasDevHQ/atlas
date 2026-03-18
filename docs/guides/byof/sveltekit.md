# BYOF: SvelteKit

Integrate Atlas into a SvelteKit app using `@ai-sdk/svelte`.

> **Prerequisites:** A running Atlas API server. See [byof-overview.md](./byof-overview.md) for architecture and common setup.

---

## 1. Install dependencies

```bash
bun add @ai-sdk/svelte ai
```

## 2. Configure the API URL

### Option A: Same-origin proxy (recommended)

In `vite.config.ts`, proxy `/api` to the Atlas API during development:

```typescript
// vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
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

For production, configure your reverse proxy (nginx, Caddy, Cloudflare) to forward `/api/*` to the Atlas API.

### Option B: Cross-origin

Set the API URL in your environment and CORS on the API side:

```bash
# .env
PUBLIC_ATLAS_API_URL=http://localhost:3001
```

```bash
# Atlas API .env
ATLAS_CORS_ORIGIN=http://localhost:5173
```

## 3. Chat store

Create a reusable chat module using `@ai-sdk/svelte`'s `useChat`:

```typescript
// src/lib/atlas-chat.ts
import { useChat } from "@ai-sdk/svelte";
import { DefaultChatTransport } from "ai";
import { env } from "$env/dynamic/public";

const apiUrl = env.PUBLIC_ATLAS_API_URL ?? "";

export function createAtlasChat(apiKey: () => string) {
  const transport = new DefaultChatTransport({
    api: `${apiUrl}/api/v1/chat`,
    get headers() {
      const key = apiKey();
      const h: Record<string, string> = {};
      if (key) h["Authorization"] = `Bearer ${key}`;
      return h;
    },
  });

  const { messages, sendMessage, status, error } = useChat({ transport });

  return { messages, sendMessage, status, error };
}
```

## 4. Chat page

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { createAtlasChat } from "$lib/atlas-chat";
  import AtlasToolPart from "$lib/components/AtlasToolPart.svelte";

  let apiKey = $state("");
  let input = $state("");

  const { messages, sendMessage, status } = createAtlasChat(() => apiKey);
  const isLoading = $derived(status.value === "streaming" || status.value === "submitted");

  function isToolPart(part: { type: string }) {
    return part.type.startsWith("tool-");
  }

  function handleSend() {
    if (!input.trim()) return;
    const text = input;
    input = "";
    sendMessage({ text });
  }
</script>

<div class="mx-auto max-w-3xl p-4">
  <h1 class="mb-4 text-xl font-bold">Atlas</h1>

  <!-- API key input (only needed for api-key auth mode) -->
  <div class="mb-4">
    <input
      type="password"
      placeholder="API key (if required)"
      bind:value={apiKey}
      class="w-full rounded border px-3 py-2 text-sm"
    />
  </div>

  <!-- Messages -->
  <div class="space-y-4">
    {#each messages.value as m (m.id)}
      {#if m.role === "user"}
        <div class="flex justify-end">
          <div class="rounded-lg bg-blue-600 px-4 py-2 text-white">
            {#each m.parts ?? [] as part, i}
              {#if part.type === "text"}
                <p>{part.text}</p>
              {/if}
            {/each}
          </div>
        </div>
      {:else}
        <div class="space-y-2">
          {#each m.parts ?? [] as part, i}
            {#if part.type === "text" && part.text.trim()}
              <div class="rounded-lg bg-zinc-100 px-4 py-2 text-sm dark:bg-zinc-800">
                {part.text}
              </div>
            {:else if isToolPart(part)}
              <AtlasToolPart {part} />
            {/if}
          {/each}
        </div>
      {/if}
    {/each}
  </div>

  <!-- Input -->
  <form class="mt-4 flex gap-2" onsubmit={(e) => { e.preventDefault(); handleSend(); }}>
    <input
      bind:value={input}
      placeholder="Ask a question about your data..."
      class="flex-1 rounded border px-4 py-2 text-sm dark:bg-zinc-900"
      disabled={isLoading}
    />
    <button
      type="submit"
      disabled={isLoading || !input.trim()}
      class="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-40"
    >
      Ask
    </button>
  </form>
</div>
```

## 5. Tool call rendering

```svelte
<!-- src/lib/components/AtlasToolPart.svelte -->
<script lang="ts">
  let { part }: { part: unknown } = $props();
  let open = $state(false);

  const p = $derived(part as Record<string, unknown>);
  const toolName = $derived(String(p.toolName ?? "unknown"));
  const args = $derived((p.input as Record<string, unknown>) ?? {});
  const result = $derived(p.output ?? null);
  const done = $derived(p.state === "output-available");
  const success = $derived(typeof result === "object" && result !== null && (result as Record<string, unknown>).success);
  const columns = $derived(success ? ((result as Record<string, unknown>).columns as string[]) ?? [] : []);
  const rows = $derived(success ? ((result as Record<string, unknown>).rows as Record<string, unknown>[]) ?? [] : []);
</script>

{#if toolName === "explore"}
  <div class="my-2 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
    <button
      class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      onclick={() => done && (open = !open)}
    >
      <span class="font-mono text-green-400">$</span>
      <span class="flex-1 truncate font-mono">{args.command ?? ""}</span>
      {#if !done}
        <span class="animate-pulse text-zinc-500">running...</span>
      {/if}
    </button>
    {#if open && done}
      <pre class="max-h-60 overflow-auto border-t px-3 py-2 font-mono text-xs">{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre>
    {/if}
  </div>

{:else if toolName === "executeSQL"}
  <div class="my-2 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
    <button
      class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      onclick={() => (open = !open)}
    >
      <span class="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-600/20 dark:text-blue-400">
        SQL
      </span>
      <span class="flex-1 truncate text-zinc-500">{args.explanation ?? "Query result"}</span>
      <span class="text-zinc-500">{rows.length} row{rows.length !== 1 ? "s" : ""}</span>
    </button>

    {#if open && done && columns.length > 0}
      <div class="overflow-x-auto border-t">
        <table class="w-full text-left text-xs">
          <thead>
            <tr class="border-b bg-zinc-50 dark:bg-zinc-900">
              {#each columns as col}
                <th class="px-3 py-1.5 font-medium text-zinc-500">{col}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows.slice(0, 50) as row, i}
              <tr class="border-b last:border-0">
                {#each columns as col}
                  <td class="px-3 py-1.5">{row[col] ?? "—"}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        {#if rows.length > 50}
          <div class="px-3 py-2 text-xs text-zinc-400">
            Showing 50 of {rows.length} rows
          </div>
        {/if}
      </div>
    {/if}

    {#if done && !success}
      <div class="border-t px-3 py-2 text-xs text-red-600 dark:text-red-400">
        Query failed. Check the query and try again.
      </div>
    {/if}
  </div>

{:else}
  <div class="my-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700">
    Tool: {toolName}
  </div>
{/if}
```

## 6. Dark mode

SvelteKit doesn't have a built-in dark mode solution. Use the `dark` class on `<html>` and Tailwind's `dark:` variants:

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { browser } from "$app/environment";

  let { children } = $props();

  let dark = $state(
    browser && window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  $effect(() => {
    if (browser) {
      document.documentElement.classList.toggle("dark", dark);
    }
  });
</script>

{@render children()}
```

All the tool card components above use `dark:` prefixed Tailwind classes, so they adapt automatically.

## 7. Synchronous queries (alternative)

If streaming is not needed, use the JSON query endpoint:

```typescript
// src/lib/atlas-query.ts
import { env } from "$env/dynamic/public";

const apiUrl = env.PUBLIC_ATLAS_API_URL ?? "";

export async function queryAtlas(question: string, apiKey?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${apiUrl}/api/v1/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ question }),
  });

  if (!res.ok) throw new Error(`Atlas query failed: ${res.status}`);
  return res.json(); // { answer: string, sql: string[], data: Array<{columns, rows}>, steps: number, usage: {totalTokens} }
}
```

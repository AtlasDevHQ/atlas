# BYOF: Nuxt (Vue)

Integrate Atlas into a Nuxt 3 app using `@ai-sdk/vue`.

> **Prerequisites:** A running Atlas API server. See [byof-overview.md](./byof-overview.md) for architecture and common setup.

---

## 1. Install dependencies

```bash
bun add @ai-sdk/vue ai
```

## 2. Configure the API URL

### Option A: Same-origin proxy (recommended)

Add a Nitro route rule in `nuxt.config.ts` to proxy `/api/**` to the Atlas API:

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  nitro: {
    routeRules: {
      "/api/**": {
        proxy: "http://localhost:3001/api/**",
      },
    },
  },
  runtimeConfig: {
    public: {
      atlasApiUrl: "", // empty = same-origin
    },
  },
});
```

### Option B: Cross-origin

Point directly at the Atlas API and set CORS on the API side:

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      atlasApiUrl: "http://localhost:3001",
    },
  },
});
```

```bash
# Atlas API .env
ATLAS_CORS_ORIGIN=http://localhost:3000
```

## 3. Chat composable

Create a composable that wraps `@ai-sdk/vue`'s `useChat`:

```typescript
// composables/useAtlasChat.ts
import { useChat } from "@ai-sdk/vue";
import { DefaultChatTransport } from "ai";

export function useAtlasChat() {
  const config = useRuntimeConfig();
  const apiUrl = config.public.atlasApiUrl || "";
  const apiKey = useState<string>("atlas-api-key", () => "");
  const input = ref("");

  const transport = computed(() => {
    const headers: Record<string, string> = {};
    if (apiKey.value) {
      headers["Authorization"] = `Bearer ${apiKey.value}`;
    }
    return new DefaultChatTransport({
      api: `${apiUrl}/api/v1/chat`,
      headers,
    });
  });

  const { messages, sendMessage, status, error } = useChat({ transport });

  function handleSend() {
    if (!input.value.trim()) return;
    const text = input.value;
    input.value = "";
    sendMessage({ text });
  }

  return {
    messages,
    status,
    error,
    input,
    apiKey,
    apiUrl,
    handleSend,
  };
}
```

## 4. Chat page

```vue
<!-- pages/index.vue -->
<script setup lang="ts">
const { messages, input, handleSend, status, apiKey } = useAtlasChat();
const isLoading = computed(
  () => status.value === "streaming" || status.value === "submitted"
);

function isToolPart(part: { type: string }) {
  return part.type.startsWith("tool-");
}
</script>

<template>
  <div class="mx-auto max-w-3xl p-4">
    <h1 class="mb-4 text-xl font-bold">Atlas</h1>

    <!-- API key input (only needed for api-key auth mode) -->
    <div class="mb-4">
      <input
        v-model="apiKey"
        type="password"
        placeholder="API key (if required)"
        class="w-full rounded border px-3 py-2 text-sm"
      />
    </div>

    <!-- Messages -->
    <div class="space-y-4">
      <div v-for="m in messages" :key="m.id">
        <div v-if="m.role === 'user'" class="flex justify-end">
          <div class="rounded-lg bg-blue-600 px-4 py-2 text-white">
            <template v-for="(part, i) in m.parts" :key="i">
              <p v-if="part.type === 'text'">{{ part.text }}</p>
            </template>
          </div>
        </div>

        <div v-else class="space-y-2">
          <template v-for="(part, i) in m.parts" :key="i">
            <div
              v-if="part.type === 'text' && part.text.trim()"
              class="rounded-lg bg-zinc-100 px-4 py-2 text-sm dark:bg-zinc-800"
            >
              {{ part.text }}
            </div>
            <AtlasToolPart v-else-if="isToolPart(part)" :part="part" />
          </template>
        </div>
      </div>
    </div>

    <!-- Input -->
    <form class="mt-4 flex gap-2" @submit.prevent="handleSend">
      <input
        v-model="input"
        placeholder="Ask a question about your data..."
        class="flex-1 rounded border px-4 py-2 text-sm dark:bg-zinc-900"
        :disabled="isLoading"
      />
      <button
        type="submit"
        :disabled="isLoading || !input.trim()"
        class="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-40"
      >
        Ask
      </button>
    </form>
  </div>
</template>
```

## 5. Tool call rendering

Atlas streams two main tool types: `explore` (filesystem reads) and `executeSQL` (query results). Create a component to render them:

```vue
<!-- components/AtlasToolPart.vue -->
<script setup lang="ts">
const props = defineProps<{ part: unknown }>();
const open = ref(false);

const toolName = computed(() => {
  const p = props.part as Record<string, unknown>;
  return String(p.toolName ?? "unknown");
});

const args = computed(() => {
  const p = props.part as Record<string, unknown>;
  const input = p.input as Record<string, unknown> | undefined;
  return input ?? {};
});

const result = computed(() => {
  const p = props.part as Record<string, unknown>;
  return (p.output ?? null) as Record<string, unknown> | string | null;
});

const done = computed(() => {
  const p = props.part as Record<string, unknown>;
  return p.state === "output-available";
});

const columns = computed(() => {
  if (!done.value || typeof result.value !== "object" || !result.value?.success) return [];
  return (result.value.columns as string[]) ?? [];
});

const rows = computed(() => {
  if (!done.value || typeof result.value !== "object" || !result.value?.success) return [];
  return (result.value.rows as Record<string, unknown>[]) ?? [];
});
</script>

<template>
  <!-- Explore card -->
  <div
    v-if="toolName === 'explore'"
    class="my-2 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700"
  >
    <button
      class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      @click="done && (open = !open)"
    >
      <span class="font-mono text-green-400">$</span>
      <span class="flex-1 truncate font-mono">{{ args.command }}</span>
      <span v-if="!done" class="animate-pulse text-zinc-500">running...</span>
    </button>
    <pre
      v-if="open && done"
      class="max-h-60 overflow-auto border-t px-3 py-2 font-mono text-xs"
    >{{ typeof result === 'string' ? result : JSON.stringify(result, null, 2) }}</pre>
  </div>

  <!-- SQL result card -->
  <div
    v-else-if="toolName === 'executeSQL'"
    class="my-2 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700"
  >
    <button
      class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      @click="open = !open"
    >
      <span
        class="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-600/20 dark:text-blue-400"
      >
        SQL
      </span>
      <span class="flex-1 truncate text-zinc-500">{{ args.explanation ?? 'Query result' }}</span>
      <span class="text-zinc-500">{{ rows.length }} row{{ rows.length !== 1 ? 's' : '' }}</span>
    </button>

    <div v-if="open && done && columns.length > 0" class="border-t">
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead>
            <tr class="border-b bg-zinc-50 dark:bg-zinc-900">
              <th
                v-for="col in columns"
                :key="col"
                class="px-3 py-1.5 font-medium text-zinc-500"
              >
                {{ col }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, i) in rows.slice(0, 50)"
              :key="i"
              class="border-b last:border-0"
            >
              <td v-for="col in columns" :key="col" class="px-3 py-1.5">
                {{ row[col] ?? '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="rows.length > 50" class="px-3 py-2 text-xs text-zinc-400">
        Showing 50 of {{ rows.length }} rows
      </div>
    </div>

    <div
      v-if="done && !result?.success"
      class="border-t px-3 py-2 text-xs text-red-600 dark:text-red-400"
    >
      Query failed. Check the query and try again.
    </div>
  </div>

  <!-- Unknown tool -->
  <div
    v-else
    class="my-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700"
  >
    Tool: {{ toolName }}
  </div>
</template>
```

## 6. Dark mode

Use Nuxt's built-in `@nuxtjs/color-mode` module or apply a `.dark` class to `<html>`. Tailwind's `dark:` variants work the same as in the reference client. No Atlas-specific setup is needed -- just style your components with `dark:` prefixed utilities.

```bash
bun add @nuxtjs/color-mode
```

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@nuxtjs/color-mode"],
  colorMode: {
    classSuffix: "",
  },
});
```

## 7. Synchronous queries (alternative)

If you don't need streaming, use the JSON query endpoint instead:

```typescript
// composables/useAtlasQuery.ts
export async function queryAtlas(question: string) {
  const config = useRuntimeConfig();
  const apiUrl = config.public.atlasApiUrl || "";

  const res = await $fetch(`${apiUrl}/api/v1/query`, {
    method: "POST",
    body: { question },
    headers: {
      "Content-Type": "application/json",
      // Add Authorization header if needed
    },
  });

  return res; // { answer: string, sql: string[], data: Array<{columns, rows}>, steps: number, usage: {totalTokens} }
}
```

# Bring Your Own Frontend

Atlas is a headless API. The built-in `@atlas/web` package is a Next.js reference client, but any frontend that can make HTTP requests and consume a streaming response can replace it.

## Architecture

```
┌─────────────────────┐
│  Your Frontend      │     HTTP (same-origin or cross-origin)
│  (Nuxt, Svelte,     │ ──────────────────────────────────────►  Atlas Hono API
│   React/Vite,       │     POST /api/v1/chat  (streaming)          ├── /api/health
│   TanStack, etc.)   │     POST /api/v1/query  (JSON)           ├── /api/v1/query
│                     │     GET  /api/v1/conversations            └── /api/v1/conversations
└─────────────────────┘
```

The API server (`@atlas/api`) is a standalone Hono app that:

- Streams chat responses using the [Vercel AI SDK Data Stream Protocol](https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol#data-stream-protocol)
- Accepts `Authorization: Bearer <key>` headers for API key auth
- Returns CORS headers (configurable via `ATLAS_CORS_ORIGIN`)
- Exposes tool call parts (explore, executeSQL) as structured data in the stream

## Framework guides

| Framework | Guide | AI SDK adapter |
|-----------|-------|----------------|
| Nuxt (Vue) | [nuxt.md](./nuxt.md) | `@ai-sdk/vue` |
| SvelteKit | [sveltekit.md](./sveltekit.md) | `@ai-sdk/svelte` |
| React (Vite) | [react-vite.md](./react-vite.md) | `@ai-sdk/react` |
| TanStack Start | [tanstack-start.md](./tanstack-start.md) | plain `fetch` / TanStack Query |

## Common setup

### 1. API URL

Your frontend needs to reach the Atlas API. Two approaches:

**Same-origin proxy** (recommended) — configure your dev server or reverse proxy to forward `/api/*` to the Atlas API. No CORS issues, no extra env vars.

**Cross-origin** — point directly at the API server and set `ATLAS_CORS_ORIGIN` on the API side:

```bash
# Atlas API .env
ATLAS_CORS_ORIGIN=http://localhost:5173  # your frontend's origin
```

> **Managed auth (cookies):** When using cookie-based managed auth cross-origin, you must set `ATLAS_CORS_ORIGIN` to an explicit origin (not `*`, which is incompatible with credentialed requests) and set `credentials: "include"` on all fetch requests from your frontend.

### 2. Auth headers

Atlas supports multiple auth modes. Your frontend only needs to handle the one you configured:

| Auth mode | Header | Notes |
|-----------|--------|-------|
| `none` | (nothing) | No auth required |
| `api-key` (`simple-key` in health endpoint) | `Authorization: Bearer <key>` | Static API key from `ATLAS_API_KEY` |
| `managed` | Cookie-based (Better Auth) | Set `credentials: "include"` on fetch |
| `byot` | `Authorization: Bearer <jwt>` | JWT from your identity provider |

### 3. Streaming chat

The `POST /api/v1/chat` endpoint accepts a Vercel AI SDK-compatible request body and returns a Data Stream response. The AI SDK framework adapters (`@ai-sdk/react`, `@ai-sdk/vue`, `@ai-sdk/svelte`) provide a `useChat` hook/composable that handles the protocol automatically.

If you prefer not to use an adapter (e.g., TanStack Start), you can consume the stream directly with `fetch` and parse the Data Stream Protocol manually, or use the JSON endpoint (`POST /api/v1/query`) for synchronous responses.

### 4. Tool call rendering

Atlas streams tool calls as structured parts. The key tool names are:

- **`explore`** — filesystem exploration of the semantic layer. Args: `{ command: string }`. Result: string output.
- **`executeSQL`** — SQL query execution. Args: `{ sql: string, explanation: string }`. Result: `{ success: boolean, columns: string[], rows: Record<string, unknown>[], truncated?: boolean }`.

Tool parts have a `type` field prefixed with `tool-` (e.g., `tool-explore`, `tool-executeSQL`). To detect them generically, check `part.type.startsWith("tool-")` or import `isToolUIPart` from the `ai` package. The `toolName` property gives you the tool name for rendering.

Each framework guide shows how to detect and render these tool parts.

### 5. Conversation management

Atlas supports persistent conversations via:

- `POST /api/v1/chat` with `{ conversationId }` in the body to continue a conversation
- Response header `x-conversation-id` contains the conversation ID (new or existing)
- `GET /api/v1/conversations` to list conversations
- `GET /api/v1/conversations/:id` to load a conversation with messages
- `DELETE /api/v1/conversations/:id` to delete a conversation

Conversation support requires `DATABASE_URL` to be configured on the API.

## What @atlas/web adds

The built-in `@atlas/web` package adds these features on top of `@ai-sdk/react`. You can port any of them by reading the source in `packages/web/src/ui/`:

- **Conversation sidebar** with persistence (requires `DATABASE_URL`)
- **Managed auth** (Better Auth sign-in/sign-up UI)
- **Chart detection** and auto-visualization of SQL results
- **Markdown rendering** in assistant messages
- **Error banners** with auth-mode-aware messages

The core streaming and tool rendering works identically across all frameworks since they all use the same Data Stream Protocol.

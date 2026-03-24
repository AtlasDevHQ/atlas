# v0.6 Design: Hono API Extraction

> Extract the agent API from Next.js route handlers into a standalone Hono server. Decouple the frontend so users can bring their own.

## Status

**Shipped in v0.6.** All 8 phases complete.
**Issues:** ~~#33~~ ✓, ~~#34~~ ✓, ~~#35~~ ✓, ~~#36~~ ✓, ~~#37~~ ✓, ~~#38~~ ✓ (+ DX: ~~#31~~ ✓, ~~#32~~ ✓, monorepo: ~~#50~~ ✓)

---

## Why

Atlas today bakes the API into Next.js route handlers (`src/app/api/`). This couples:

1. **Deployment** — You must deploy Next.js even if you only want the API (Slack bot, headless CLI, SDK)
2. **Frontend** — You must use Next.js even if you prefer TanStack Start, Nuxt, or SvelteKit
3. **Runtime** — `serverExternalPackages` is a Next.js workaround for native bindings that wouldn't exist in a plain Bun server

Extracting to Hono gives us:

- **Any frontend** — useChat points at a URL, not a framework convention
- **Any runtime** — Bun, Node, Cloudflare Workers, Deno
- **Headless deploys** — Docker example is API-only, suitable for bots, CLIs, SDKs
- **Web Standards** — fetch/Request/Response everywhere, zero adapter code

## Why Hono

| Requirement | Hono | Express | Fastify |
|---|---|---|---|
| Web Standards (Request/Response) | Native | Adapter needed | Adapter needed |
| Multi-runtime (Bun, Node, Workers) | Yes | Node only | Node only |
| Streaming/SSE | Built-in | Manual | Plugin |
| Zod OpenAPI | `@hono/zod-openapi` | Extra work | `fastify-swagger` |
| AI SDK compatibility | `toUIMessageStreamResponse()` returns standard `Response` | Needs piping | Needs piping |
| Better Auth | `auth.handler` is fetch-native | `toNodeHandler` | `toNodeHandler` |
| Bundle size | ~14KB | ~200KB | ~400KB |

---

## Current API Surface

Three Next.js route handler files — this is the complete extraction target:

### `POST /api/chat` (`src/app/api/chat/route.ts`)

**Request:** `Content-Type: application/json`, body `{ messages: UIMessage[] }`
**Response:** AI SDK UI message stream via `result.toUIMessageStreamResponse()`

**Middleware stack (in order):**
```
authenticateRequest(req)          → 401/500 on failure
checkRateLimit(key)               → 429 on failure
withRequestContext({ id, user })  → AsyncLocalStorage binding
validateEnvironment()             → 400 on failure
ATLAS_DATASOURCE_URL guard        → 400 on failure
req.json() body parse             → 400 on failure
runAgent({ messages })            → StreamTextResult
result.toUIMessageStreamResponse()→ streaming Response
error boundary                    → 400/503/504/500
```

**Key detail:** `withRequestContext` uses `AsyncLocalStorage`. This propagates `requestId` and `user` through the entire async call chain, including into `logQueryAudit()` deep inside the `executeSQL` tool. In Hono, this must wrap the handler body — it cannot be replaced by Hono's `c.set()` context because tool code doesn't have access to the Hono context.

### `GET /api/health` (`src/app/api/health/route.ts`)

**Response:** JSON status blob. HTTP 200 (ok/degraded) or 503 (error).

No auth, no rate limiting. Probes:
- `validateEnvironment()` — cached startup diagnostics
- `getDB().query("SELECT 1", 5000)` — live datasource probe
- `getInternalDB().query("SELECT 1")` — live internal DB probe
- `getWhitelistedTables().size` — entity count
- `getExploreBackendType()` — sandbox backend
- `detectAuthMode()` — active auth mode

The frontend calls `/api/health` on mount to discover `auth.mode` and render the appropriate UI (API key bar, managed login, or nothing).

### `ALL /api/auth/*` (`src/app/api/auth/[...all]/route.ts`)

**Response:** Delegated to Better Auth.

- `detectAuthMode() !== "managed"` → 404 immediately
- In managed mode: `toNextJsHandler(getAuthInstance())` passes through

**For Hono:** Better Auth exposes a fetch-compatible `.handler` — no framework adapter needed. Route becomes `app.all('/api/auth/*', handler)`.

---

## Extraction Boundary

### What moves to Hono

The entire `src/lib/` tree. Zero Next.js coupling exists anywhere in it:

```
src/lib/agent.ts             ← runAgent (returns StreamTextResult)
src/lib/providers.ts         ← getModel, getProviderType
src/lib/startup.ts           ← validateEnvironment
src/lib/semantic.ts          ← getWhitelistedTables
src/lib/logger.ts            ← createLogger, withRequestContext (AsyncLocalStorage)
src/lib/security.ts          ← SENSITIVE_PATTERNS
src/lib/tracing.ts           ← withSpan (OTel)
src/lib/errors.ts            ← parseChatError

src/lib/auth/*               ← All auth modules (middleware, detect, validators, audit)
src/lib/db/*                 ← All DB modules (connection, internal)
src/lib/tools/*              ← All tools (explore, sql, report)
```

### What stays in Next.js

```
src/app/page.tsx             ← Chat UI (useChat hook)
src/app/layout.tsx           ← Next.js layout
src/lib/auth/client.ts       ← Better Auth React client
src/lib/errors.ts            ← parseChatError (shared — used by ErrorBanner)
next.config.ts               ← serverExternalPackages (no longer needed in Hono)
```

### Framework coupling points (5 total)

| Coupling | Current (Next.js) | Hono equivalent |
|---|---|---|
| Route handler signatures | `export async function POST(req)` | `app.post('/api/chat', (c) => ...)` |
| Better Auth adapter | `toNextJsHandler()` | `auth.handler` (fetch-native) |
| `maxDuration = 60` | Vercel serverless hint | Drop (irrelevant) |
| Frontend API URL | Hardcoded `"/api/v1/chat"` | Env-configurable `ATLAS_API_URL` |
| `serverExternalPackages` | Next.js bundler workaround | Disappears (no bundler) |

### What does NOT change

- `runAgent()` — takes `UIMessage[]`, returns `StreamTextResult`
- `toUIMessageStreamResponse()` — returns standard `Response` (works in Hono directly)
- `AsyncLocalStorage` (`withRequestContext`) — works identically in Bun
- All module-scope singletons (DB pools, rate limiter, cached env validation)
- OTel tracing — pure instrumentation, no framework dependency

---

## Implementation Plan

### Phase 1: Hono API Server (#33)

The core extraction. No other issue blocks this.

**1a. Create `src/api/` directory with Hono app**

```
src/api/
├── index.ts              # Hono app definition, route registration
├── routes/
│   ├── chat.ts           # POST /api/chat
│   ├── health.ts         # GET /api/health
│   └── auth.ts           # ALL /api/auth/*
├── middleware/
│   ├── auth.ts           # Hono middleware wrapping authenticateRequest()
│   ├── rate-limit.ts     # Hono middleware wrapping checkRateLimit()
│   ├── request-context.ts# Hono middleware wrapping withRequestContext()
│   └── cors.ts           # CORS middleware
└── server.ts             # Bun.serve() entry point (standalone mode)
```

**1b. Port route handlers**

Each route handler is a near-copy of the existing Next.js handler. The logic body is identical — only the function signature wrapper changes:

```typescript
// src/api/routes/chat.ts
import { Hono } from "hono";
import { runAgent } from "@/lib/agent";
// ... same imports as current route.ts

const chat = new Hono();

chat.post("/", async (c) => {
  // Same logic as current POST handler
  // c.req.raw gives the standard Request object
  const req = c.req.raw;
  // ... auth, rate limit, withRequestContext, runAgent ...
  const result = await runAgent({ messages });
  return result.toUIMessageStreamResponse();
});

export { chat };
```

**1c. Middleware as Hono middleware**

Auth and rate limiting can be Hono middleware, but `withRequestContext` must wrap the handler body (not use `c.set()`) because `AsyncLocalStorage` context must propagate into tool code that has no Hono context access:

```typescript
// Option A: Hono middleware that calls withRequestContext internally
app.use("/api/v1/chat", async (c, next) => {
  const authResult = await authenticateRequest(c.req.raw);
  if (!authResult.authenticated) return c.json(...);
  // Store for downstream middleware, but also bind to AsyncLocalStorage
  c.set("auth", authResult);
  return withRequestContext({ requestId, user: authResult.user }, () => next());
});
```

**1d. CORS**

```typescript
import { cors } from "hono/cors";
app.use("/api/*", cors({ origin: process.env.ATLAS_CORS_ORIGIN ?? "*" }));
```

**1e. Standalone server entry point**

```typescript
// src/api/server.ts
import { app } from "./index";

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};
```

Run with `bun run src/api/server.ts`. This enables headless API deployment without Next.js.

**1f. Next.js integration (transitional)**

During the transition, the Next.js app can proxy to the Hono app internally using a catch-all route, OR the Hono routes can be mounted as Next.js route handlers. The simplest approach:

```typescript
// src/app/api/[...route]/route.ts (catch-all proxy)
import { app } from "@/api";

export const GET = (req: Request) => app.fetch(req);
export const POST = (req: Request) => app.fetch(req);
```

This keeps the frontend working at the same origin while we decouple.

### Phase 2: Better Auth Migration Cleanup (#32)

Natural during the Hono middleware port. Extract Better Auth table migration from `validateEnvironment()` into a dedicated startup hook that Hono calls once on server boot, instead of checking on every request.

### Phase 3: Frontend Decoupling (#34)

Depends on #33 being complete.

**3a. Env-configurable API URL**

```typescript
// In the frontend
const API_URL = process.env.NEXT_PUBLIC_ATLAS_API_URL ?? "";
const transport = new DefaultChatTransport({
  api: `${API_URL}/api/chat`,
  headers,
});
// fetch(`${API_URL}/api/health`)
```

When `NEXT_PUBLIC_ATLAS_API_URL` is empty, the frontend uses same-origin (backward compatible). When set, it points to a standalone Hono server.

**3b. Remove Next.js API routes**

Delete `src/app/api/chat/route.ts`, `src/app/api/health/route.ts`, `src/app/api/auth/[...all]/route.ts`. The frontend is now a pure React app.

**3c. Document BYOF (bring-your-own-frontend)**

The Hono API speaks the AI SDK data stream protocol. Any frontend using `useChat` (React, Vue, Svelte) can connect:

```typescript
// React (Next.js, TanStack Start, Remix)
import { useChat } from "@ai-sdk/react";
useChat({ api: "https://atlas-api.example.com/api/chat" });

// Vue (Nuxt)
import { useChat } from "@ai-sdk/vue";
useChat({ api: "https://atlas-api.example.com/api/chat" });

// Svelte (SvelteKit)
import { useChat } from "@ai-sdk/svelte";
useChat({ api: "https://atlas-api.example.com/api/chat" });
```

### Phase 4: Connection Registry (#35)

Independent of the Hono work. Foundation for v0.7 multi-database.

Refactor `getDB()` singleton in `src/lib/db/connection.ts`:

```typescript
// Before
let _db: DBConnection | null = null;
export function getDB(): DBConnection { ... }

// After
class ConnectionRegistry {
  private connections = new Map<string, DBConnection>();

  register(id: string, config: ConnectionConfig): void { ... }
  get(id: string): DBConnection { ... }
  getDefault(): DBConnection { ... }  // backward compat — returns "default"
  list(): string[] { ... }
}

export const connections = new ConnectionRegistry();

// Backward compat — getDB() still works
export function getDB(): DBConnection {
  return connections.getDefault();
}
```

Per-connection table whitelists in `semantic.ts`:
```typescript
// Before
const _whitelistedTables: Set<string> = new Set();

// After
const _whitelists = new Map<string, Set<string>>();
export function getWhitelistedTables(connectionId?: string): Set<string> { ... }
```

### Phase 5: Tool Registry (#36)

Independent of Hono. Foundation for v0.7 pluggable data sources and v0.9 action tools.

Extract hardcoded tools from `agent.ts`:

```typescript
// Before (agent.ts)
tools: { explore, executeSQL }

// After
class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(name: string, tool: ToolDefinition): void { ... }
  get(name: string): ToolDefinition { ... }
  getAll(): Record<string, ToolDefinition> { ... }
  describe(): string { ... }  // for dynamic system prompt composition
}

export const tools = new ToolRegistry();
tools.register("explore", explore);
tools.register("executeSQL", executeSQL);

// In agent.ts
streamText({ tools: tools.getAll(), ... });
```

System prompt composition becomes dynamic — tools describe themselves instead of being hardcoded in `BASE_SYSTEM_PROMPT`.

### Phase 6: Declarative Configuration (#37)

Depends on #35 (ConnectionRegistry) and #36 (ToolRegistry).

```typescript
// atlas.config.ts
import { defineConfig } from "atlas";

export default defineConfig({
  datasources: {
    default: { url: process.env.ATLAS_DATASOURCE_URL! },
    // v0.7: additional sources
  },
  tools: ["explore", "executeSQL"],
  auth: "auto",  // auto-detect from env vars (current behavior)
  // v0.9: actions: ["slack:notify", "jira:create"]
});
```

Env vars still work for single-DB deployments — `atlas.config.ts` is optional. When present, it takes precedence.

### Phase 7: Example Projects + Monorepo (#38)

Depends on #33 and #34 being complete.

```
examples/
├── nextjs-standalone/        # Current topology: Next.js + embedded Hono API
│   ├── src/app/              # Chat UI + catch-all API proxy
│   ├── Dockerfile
│   └── railway.json
└── docker/                   # Self-hosted Hono API + optional nsjail
    ├── docker-compose.yml
    ├── Dockerfile
    └── scripts/
```

Root repo stops being directly deployable. Deploy configs move into examples. `bun run dev` still works for local hacking.

`create-atlas` scaffolds from example variants:
```bash
bun create @useatlas my-app --platform docker             # default
bun create @useatlas my-app --platform vercel
```

### Phase 8: DX — Interactive Enrichment (#31)

Independent, anytime. During `atlas init`, ask interactively whether to run LLM enrichment instead of requiring `--enrich` / `--no-enrich` flags. Auto-detect TTY (like the table picker already does).

---

## Issue Dependency Graph

```
                    ┌──────────┐
                    │ #33 Hono │ ✓ DONE
                    │   API    │
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
        ┌─────┴──┐ ┌────┴───┐ ┌───┴────┐
        │#32 DX: │ │#34 FE  │ │ #35    │
        │BA migr.│ │decouple│ │ConnReg │
        │ ✓ DONE │ │ ✓ DONE │ │ ✓ DONE │
        └────────┘ └────┬───┘ └───┬────┘
                        │         │
                   ┌────┴───┐ ┌───┴────┐
                   │#38 Ex. │ │ #36    │
                   │UNBLOCKD│ │ToolReg │
                   └────────┘ │ ✓ DONE │
                              └───┬────┘
                                  │
                             ┌────┴───┐
                             │ #37    │
                             │config  │
                             │ ✓ DONE │
                             └────────┘

Independent: #31 (DX enrichment) — ✓ DONE
Monorepo: #50/#51 — ✓ DONE
```

## Sequencing

| Order | Issue | Status | Blocks | Blocked by |
|---|---|---|---|---|
| 1 | **#33** Hono API server | ✓ Done | #32, #34, #38 | — |
| 2 | **#50** Bun workspace monorepo | ✓ Done | — | — |
| 3 | **#34** Frontend decoupling | ✓ Done | #38 | ~~#33~~ |
| 4 | **#35** Connection registry | ✓ Done | #37 | — |
| 5 | **#36** Tool registry | ✓ Done | #37 | — |
| 6 | **#32** DX: BA migration cleanup | ✓ Done | — | ~~#33~~ |
| 7 | **#37** atlas.config.ts | ✓ Done | — | ~~#35, #36~~ |
| 8 | **#38** Examples + monorepo | **Unblocked** | — | ~~#33, #34~~ |
| — | **#31** DX: enrichment choice | ✓ Done | — | — |

**All v0.6 issues are shipped.** See ROADMAP.md v0.6 section for details.

---

## Testing Strategy

### Unit tests
- Hono route handler tests (same patterns as current `route.test.ts`)
- Middleware tests (auth, rate limit, CORS)
- ConnectionRegistry and ToolRegistry tests

### Integration tests
- Standalone Hono server: `bun run src/api/server.ts` + curl
- Next.js proxy mode: existing tests should pass with no changes
- Cross-origin: frontend on :3000, API on :3001

### Migration validation
- All existing tests pass without modification (lib/ is unchanged)
- Health check response shape is identical
- Chat stream protocol is identical (same `toUIMessageStreamResponse()`)

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| `AsyncLocalStorage` doesn't propagate through Hono middleware | Low | Tested in exploration — works in Bun natively. Wrap handler body, not middleware chain |
| `toUIMessageStreamResponse()` incompatible with Hono | None | Returns standard `Response` — verified in AI SDK source |
| Better Auth `.handler` doesn't support all routes | Low | `.handler` is their primary fetch interface; `toNextJsHandler` is a wrapper around it |
| CORS misconfiguration blocks auth cookies | Medium | Cookie-based auth (managed mode) needs `credentials: include` + explicit `Access-Control-Allow-Credentials`. Document clearly |
| Rate limiter state not shared across replicas | Known | Already the case in Next.js. Document as known limitation, Redis upgrade path in backlog |

---

## Open Questions

1. **Package structure** — `src/api/` within the monorepo, or a separate `packages/api/` workspace? Starting with `src/api/` is simpler and can be extracted later.

2. **Next.js proxy or separate process?** — During transition, should Next.js proxy to Hono (single process) or run them as separate processes? Proxy is simpler for existing deploys; separate enables the decoupled architecture immediately.

3. **Versioned API path?** — Should chat be at `/api/chat` (current) or `/api/v1/chat` (for future breaking changes)? The v0.8 roadmap already plans `/api/v1/query` for the JSON API. Consider `/api/v1/` prefix now.

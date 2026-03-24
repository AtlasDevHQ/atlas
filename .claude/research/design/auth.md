# Authentication & Internal Database — Design Document

> Design reference for v0.5 authentication, the Atlas internal database, and the audit trail.
> This establishes the separation between Atlas's own state and the analytics databases users bring.

## Why

Atlas is currently public — no auth on any endpoint. Before handing it to a real team (v0.5 goal), we need:

- **Authentication** — control who can query
- **Audit trail** — know who queried what, when
- **Rate limiting** — prevent runaway usage
- **Internal state** — a place for Atlas's own data that isn't the user's analytics database

The auth system must be opt-in (zero breaking changes) and support three deployment patterns: single-user API key, self-managed team auth, and embedding in existing infrastructure.

## Key Architectural Decision: Two Databases

Atlas is a product that has its own database. Analytics databases are things you *connect* to it. This is the fundamental mental model.

| Concept | Env var | What it holds | Access mode | Engine |
|---------|---------|---------------|-------------|--------|
| **Atlas Internal DB** | `DATABASE_URL` | Auth tables, audit log, rate limits, future settings/integrations | Read-write | **PostgreSQL only** |
| **Analytics Datasource (BYODB)** | `ATLAS_DATASOURCE_URL` | User's business data that the agent queries | Read-only (SELECT) | PostgreSQL or MySQL |

### Why `DATABASE_URL` for the internal DB?

- **Standard convention** — every platform (Railway, Render, Heroku) auto-provisions `DATABASE_URL` as Postgres. Atlas "just works" when you deploy it.
- **Atlas-first** — Atlas is a server product. It needs a real database for its own state. Postgres is the standard.
- **Future-proof** — in v0.6 with the connection registry, analytics databases are registered via `atlas.config.ts`. `ATLAS_DATASOURCE_URL` is the v0.5 stopgap for "single analytics DB." The connection registry replaces it.

### Why Postgres-only for the internal DB?

- **One engine, one schema, one migration path** — no dual-engine internal DB code. The analytics side already handles two engines (Postgres/MySQL); the internal side doesn't need that complexity.
- **Server product** — Atlas is deployed on servers, not desktops. Every deployment target has Postgres available (Railway provisions it, Render has managed Postgres, Docker Compose gives you one locally).
- **Better Auth works best with Postgres** — one adapter config, no conditional schema.
- **Local dev already has Postgres** — `docker compose up` starts Postgres for local development. It now serves double duty: Atlas internal DB *and* the demo analytics datasource.

### Breaking change from pre-v0.5

Previously `DATABASE_URL` pointed at the analytics database. This flips it:

| Before (v0.4) | After (v0.5) |
|----------------|--------------|
| `DATABASE_URL` = analytics DB (required to start) | `DATABASE_URL` = Atlas internal Postgres (required) |
| (didn't exist) | `ATLAS_DATASOURCE_URL` = analytics BYODB (optional) |

We're pre-1.0 with ~zero external users. This is the right time to make this change.

### Migration for existing users

1. Rename `DATABASE_URL` → `ATLAS_DATASOURCE_URL` in your `.env`
2. Set `DATABASE_URL` to a Postgres connection for Atlas internals (can be the same Postgres instance, different database or schema)
3. That's it. All other config stays the same.

### Local development setup

```bash
bun run db:up
# Docker Compose starts Postgres with TWO databases:
# - atlas (Atlas internal — auth, audit, settings — permanent)
# - atlas_demo (demo analytics data — disposable, re-seedable)
```

```bash
# .env
DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
ATLAS_DATASOURCE_URL=postgresql://atlas:atlas@localhost:5432/atlas_demo
```

`atlas` is the product. `atlas_demo` is sample data you throw away when you connect real data.

### Production setup

Most platforms auto-provision `DATABASE_URL`. You just need to add the analytics datasource:

```bash
# Railway/Render auto-sets DATABASE_URL to their managed Postgres
ATLAS_DATASOURCE_URL=postgresql://user:pass@your-analytics-host:5432/mydb
```

### Why separate?

- **Security boundary** — the agent must never write to or read from auth/audit tables. The analytics connection is SELECT-only and table-whitelisted. The internal DB is read-write with no whitelist.
- **Lifecycle independence** — you can reset the analytics DB without losing auth state, and vice versa.
- **Deployment flexibility** — internal DB is always Postgres. Analytics datasource can be Postgres or MySQL. Different engines for different purposes.
- **Future-proofing** — saved queries, integration configs, scheduled reports, user preferences (v0.6+) all go in the internal DB without touching the user's data.

### What if they point at the same Postgres instance?

That's fine — use different databases or schemas within the same instance. Separate connection pools with different permissions. The analytics pool is read-only; the internal pool is read-write. The agent's table whitelist (from `semantic/entities/*.yml`) won't include internal tables.

## Auth Modes

Three deployment patterns — auto-detected from environment variables.

| Mode | Env trigger | User state | Use case |
|------|------------|------------|----------|
| **None** (default) | No auth vars set | Public access | Local dev, demos |
| **Simple API key** | `ATLAS_API_KEY` | None — just validates the key | Single-user self-hosted, CI/CD |
| **Managed** | `BETTER_AUTH_SECRET` | Internal DB (Postgres) | Standalone teams, Atlas is the primary tool |
| **BYOT** | `ATLAS_AUTH_JWKS_URL` | None — stateless JWT verification | Embedding Atlas in existing infrastructure |

### Detection priority

When multiple env vars are set, highest-specificity wins:

```
ATLAS_AUTH_JWKS_URL set  →  byot
BETTER_AUTH_SECRET set   →  managed
ATLAS_API_KEY set        →  simple-key
(nothing)                →  none
```

### Mode: None

Zero changes from today. No headers required, no login screen, no user identity in logs. This is the default for local dev and demos.

### Mode: Simple API Key

Set `ATLAS_API_KEY=your-secret-key` in `.env`. Every request must include:

```
Authorization: Bearer your-secret-key
```

Or:

```
X-API-Key: your-secret-key
```

No user model, no database needed for auth state. The user identity in audit logs is derived from a hash of the key (e.g., `api-key-a1b2`). Comparison uses `crypto.timingSafeEqual` to prevent timing attacks.

Note: Simple API key mode doesn't require the internal DB for auth itself, but the audit log still writes there.

Frontend: a small key input in the header that stores the value in `sessionStorage` (cleared on tab close to limit XSS exposure) and injects it as an Authorization header on every request.

### Mode: Managed (Better Auth)

Full user management via [Better Auth](https://www.better-auth.com/). Auth state lives in the Atlas internal Postgres — isolated from the analytics datasource.

**Why Better Auth:** Framework-agnostic (works with Next.js now, Hono in v0.6), self-hosted (no SaaS dependency), progressive plugin system, handles session/token/JWKS pitfalls. Chosen over Auth.js (React-centric), Lucia (deprecated), and hosted services (break "deploy anywhere").

Features enabled:
- Email + password login/signup
- `bearer()` plugin — token-based auth for API clients
- `apiKey()` plugin — API key management for programmatic access
- Session management with cookie cache (7-day expiry, daily refresh)
- Built-in rate limiting on auth endpoints

Frontend: login form (email + password) before the chat interface. Current user email + logout button in the header. Simple "Create account" flow for first-time setup. No OAuth, social login, or password reset in v0.5 — those are addable via Better Auth plugins later.

### Mode: BYOT (Bring Your Own Token)

Stateless JWT verification against an external JWKS endpoint. Atlas doesn't manage users — the parent system (Okta, Auth0, your app) handles login. Atlas just validates the token.

Required env vars:
- `ATLAS_AUTH_JWKS_URL` — JWKS endpoint URL (e.g., `https://your-idp.com/.well-known/jwks.json`)
- `ATLAS_AUTH_ISSUER` — expected JWT `iss` claim

Optional:
- `ATLAS_AUTH_AUDIENCE` — expected JWT `aud` claim

User identity: `sub` claim → user ID, `email` claim (optional) → label.

Uses `jose` library for JWKS fetching and JWT verification. JWKS keyset is cached automatically.

Frontend: no changes needed — the parent application handles login and passes the JWT. The chat UI forwards it via Authorization header (same mechanism as simple API key mode).

## Internal Database Schema

The Atlas internal database is **always PostgreSQL**. One engine, one schema dialect, one migration path.

### Atlas-owned tables

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT,                    -- from AtlasUser.id (null in mode "none")
  user_label TEXT,                 -- from AtlasUser.label
  auth_mode TEXT NOT NULL,         -- "simple-key" | "managed" | "byot" | "none"
  sql TEXT NOT NULL,               -- query text (truncated to 2000 chars)
  duration_ms INTEGER NOT NULL,
  row_count INTEGER,
  success BOOLEAN NOT NULL,
  error TEXT                       -- null on success
);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
```

### Better Auth tables (managed mode only)

Better Auth creates and migrates its own tables: `user`, `session`, `account`, `apikey`, etc. These live alongside the Atlas-owned tables in the same Postgres database. Better Auth's migration CLI handles their lifecycle.

### Migration strategy

- `migrateInternalDB()` — called from `startup.ts` after environment validation
- Idempotent `CREATE TABLE IF NOT EXISTS` for Atlas-owned tables
- Better Auth handles its own migrations separately (its adapter auto-migrates on startup)
- No ORM — raw SQL for Atlas tables (simple, no dependencies, Postgres-only)

## Core Types

```typescript
// src/lib/auth/types.ts

export const AUTH_MODES = ["none", "simple-key", "managed", "byot"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export interface AtlasUser {
  /** Stable identifier: API key hash, Better Auth user ID, or JWT sub claim */
  id: string;
  /** Which auth mode produced this user */
  mode: Exclude<AuthMode, "none">;
  /** Human label (email for managed, key prefix for simple, sub for BYOT) */
  label: string;
}

export type AuthResult =
  | { authenticated: true; mode: Exclude<AuthMode, "none">; user: AtlasUser }
  | { authenticated: true; mode: "none"; user: undefined }
  | { authenticated: false; mode: AuthMode; status: 401 | 500; error: string };
```

`AtlasUser` instances are created via `createAtlasUser(id, mode, label)` which validates non-empty strings and returns a frozen object.

## Request Flow

```
Request arrives at route handler
    ↓
authenticateRequest(req): AuthResult       ← src/lib/auth/middleware.ts
    ↓ (dispatches to mode-specific validator)
    ↓ (if mode === "none", passes through with no user)
    ↓ (if auth fails, route returns error immediately)
    ↓
checkRateLimit(user | ip): boolean         ← src/lib/auth/middleware.ts
    ↓ (if rate limited, returns 429)
    ↓
withRequestContext({ requestId, user })    ← extends existing AsyncLocalStorage
    ↓
runAgent({ messages })                     ← unchanged
    ↓
executeSQL → logQueryAudit()               ← writes to pino + internal DB
```

## Audit Trail

Every SQL query produces two audit records:

1. **Pino structured log** — real-time, streamed to log aggregators (Datadog, Grafana, etc.)
2. **Database row** — queryable history in the internal Postgres

The DB write is fire-and-forget (`void insert(...).catch(log.error)`). It must never slow down or fail a query. The pino log is the primary observability path. The DB table is for admin queries ("show me all queries by user X in the last 24 hours").

Fields logged: user ID, user label, auth mode, SQL (truncated to 2000 chars), duration (ms), row count, success/error, timestamp.

Sensitive SQL errors (connection strings, file paths — from the existing `sensitivePatterns` regex in `sql.ts`) are scrubbed before writing to the audit log.

## Rate Limiting

Per-user sliding window, applied after authentication:

- **Key**: user ID (from `AtlasUser.id`) or client IP (for mode "none", requires `ATLAS_TRUST_PROXY=true` for proxy header trust)
- **Default**: disabled (`ATLAS_RATE_LIMIT_RPM` unset or `0`)
- **Response**: HTTP 429 with `Retry-After` header
- **Storage**: in-memory sliding-window `Map<string, number[]>` with 60s cleanup interval

For managed mode, Better Auth's built-in rate limiting handles auth endpoints (`/api/auth/*`). This rate limiter covers the chat endpoint only.

The in-memory approach is fine for single-process deployments. Multi-process deployments should use Redis via Better Auth's `secondaryStorage` option (documented, not built in v0.5).

## File Structure

```
src/lib/
├── db/
│   ├── connection.ts          # Analytics datasource (BYODB) — read-only
│   │                          #   RENAMED: reads from ATLAS_DATASOURCE_URL (was DATABASE_URL)
│   └── internal.ts            # NEW: Atlas internal DB — read-write, Postgres only
│                              #   Reads from DATABASE_URL
├── auth/
│   ├── types.ts               # AtlasUser, AuthMode, AuthResult
│   ├── detect.ts              # detectAuthMode() from env vars
│   ├── middleware.ts           # authenticateRequest() + checkRateLimit()
│   ├── simple-key.ts          # API key validation
│   ├── managed.ts             # Better Auth config + server instance
│   ├── byot.ts                # JWKS/JWT verification
│   ├── audit.ts               # Query audit logger (pino + Postgres)
│   ├── types.ts               # AtlasUser, AuthMode, AuthResult, createAtlasUser
│   └── __tests__/
│       ├── simple-key.test.ts
│       ├── middleware.test.ts
│       ├── detect.test.ts
│       └── audit.test.ts
src/app/api/
├── auth/[...all]/route.ts     # NEW: Better Auth catch-all (managed mode only)
├── chat/route.ts              # MODIFIED: add auth guard at top
└── health/route.ts            # MODIFIED: add auth + datasource status to response (always public)
```

## Codebase Rename: `DATABASE_URL` → `ATLAS_DATASOURCE_URL`

This is a mechanical rename that touches many files but changes no logic. Do it first (Phase 0a) so all subsequent work uses the new names.

### Files that reference `DATABASE_URL` for analytics:

| File | What changes |
|------|-------------|
| `src/lib/db/connection.ts` | `process.env.DATABASE_URL` → `process.env.ATLAS_DATASOURCE_URL` |
| `src/lib/startup.ts` | Diagnostic checks reference new var name, new error code `MISSING_DATASOURCE_URL` |
| `bin/atlas.ts` | CLI profiler reads `ATLAS_DATASOURCE_URL` |
| `.env.example` | Rename + document both vars |
| `create-atlas/template/.env.example` | Same |
| `create-atlas/index.ts` | TUI writes `ATLAS_DATASOURCE_URL` |
| `docker-compose.yml` | Environment var name |
| `Dockerfile` | Any ENV references |
| `docs/guides/quick-start.md` | Instructions |
| `docs/guides/deploy.md` | Deploy guides |
| `docs/guides/bring-your-own-db.md` | BYODB guide |
| `CLAUDE.md` | All references |
| `ROADMAP.md` | References in descriptions |
| `README.md` (if exists) | References |
| Test files | Mocked env vars |

### What `DATABASE_URL` now means:

After the rename, `DATABASE_URL` is the Atlas internal Postgres. Platforms auto-provision it. Required for managed auth mode and audit logging. Simple API key and BYOT modes still need it for the audit log.

## Docker Compose Update

The local `docker-compose.yml` needs to provision two databases within the same Postgres instance:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: atlas
      POSTGRES_PASSWORD: atlas
      POSTGRES_DB: atlas           # Atlas internal DB (created by default)
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./data/init-demo-db.sql:/docker-entrypoint-initdb.d/00-init.sql
      - ./data/demo.sql:/data/demo.sql:ro
    ports:
      - "5432:5432"
```

New `data/init-demo-db.sql`:
```sql
-- Create the demo analytics database alongside the Atlas internal DB.
-- Runs as superuser during postgres container initialization (mounted as 00-init.sql).
-- demo.sql is mounted at /data/demo.sql (outside docker-entrypoint-initdb.d
-- to prevent Docker from also running it against the default 'atlas' database).
CREATE DATABASE atlas_demo;
GRANT ALL PRIVILEGES ON DATABASE atlas_demo TO atlas;
\connect atlas_demo;
\i /data/demo.sql
```

`demo.sql` seeds into `atlas_demo` (the analytics datasource). The `atlas` database stays clean for Atlas internal tables (auth, audit, etc.).

Local `.env`:
```
DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas
ATLAS_DATASOURCE_URL=postgresql://atlas:atlas@localhost:5432/atlas_demo
```

## Environment Variables

### Renamed

| Old | New | Purpose |
|-----|-----|---------|
| `DATABASE_URL` | `ATLAS_DATASOURCE_URL` | Analytics BYODB connection string |

### New

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DATABASE_URL` | — | Yes (for auth/audit) | Atlas internal Postgres |
| `ATLAS_API_KEY` | — | No | Enables simple API key auth mode |
| `BETTER_AUTH_SECRET` | — | No | Enables managed auth mode (min 32 chars) |
| `BETTER_AUTH_URL` | — | With managed | Base URL for Better Auth (e.g., `http://localhost:3000`) |
| `ATLAS_AUTH_JWKS_URL` | — | No | Enables BYOT auth mode |
| `ATLAS_AUTH_ISSUER` | — | With BYOT | Expected JWT issuer claim |
| `ATLAS_AUTH_AUDIENCE` | — | No | Expected JWT audience claim |
| `ATLAS_RATE_LIMIT_RPM` | disabled | No | Max requests per minute per user (0 or unset = disabled) |
| `ATLAS_TRUST_PROXY` | `false` | No | Trust `X-Forwarded-For` and `X-Real-IP` headers for client IP detection |

### Unchanged (but now scoped to analytics datasource)

| Variable | Note |
|----------|------|
| `ATLAS_TABLE_WHITELIST` | Still applies to analytics datasource queries |
| `ATLAS_ROW_LIMIT` | Still applies to analytics datasource queries |
| `ATLAS_QUERY_TIMEOUT` | Still applies to analytics datasource queries |
| `ATLAS_SCHEMA` | Still applies to analytics datasource (Postgres) |

### When is `DATABASE_URL` required?

| Auth mode | `DATABASE_URL` needed? | Why |
|-----------|----------------------|-----|
| None | No* | Audit log writes degrade gracefully (pino only, no DB) |
| Simple API key | Yes | Audit log writes |
| Managed | Yes | Better Auth tables + audit log |
| BYOT | Yes | Audit log writes |

*In "none" mode with no `DATABASE_URL`, Atlas skips DB audit writes and only logs to pino. This preserves the zero-dependency local dev experience.

## New Dependencies

| Package | Purpose | Phase |
|---------|---------|-------|
| `better-auth` | Auth framework (managed mode) | Phase 2 |
| `jose` | JWKS/JWT verification (BYOT mode) | Phase 3 |

## Implementation Phases

Build in order. Each phase must leave `bun run build && bun run test` passing.

### Phase 0a: Rename `DATABASE_URL` → `ATLAS_DATASOURCE_URL`

Mechanical rename across the codebase. Every file that reads `process.env.DATABASE_URL` for the analytics connection switches to `ATLAS_DATASOURCE_URL`. Update all docs, configs, templates, tests. No logic changes.

After this phase:
- `DATABASE_URL` is freed up for the internal DB
- `ATLAS_DATASOURCE_URL` is optional (Atlas starts without it)
- Existing analytics-DB functionality works identically under the new name

### Phase 0b: Atlas Internal Database

Establish `src/lib/db/internal.ts`:
- Read-write Postgres connection, singleton pattern
- Reads `DATABASE_URL` env var
- Uses `pg` Pool (same driver as analytics, but without `SET TRANSACTION READ ONLY` or `statement_timeout`)
- Export `getInternalDB()`, `migrateInternalDB()`, `closeInternalDB()`

When `DATABASE_URL` is not set:
- Audit log writes silently skip (pino-only logging, no DB insert)
- Managed auth mode fails startup validation ("managed auth requires DATABASE_URL")
- Simple API key and BYOT modes work (auth itself is stateless), just no DB audit trail
- Log a warning at startup: "DATABASE_URL not set — audit log will not persist to database"

Update docker-compose.yml:
- Postgres creates two databases: `atlas_internal` + `atlas` (demo analytics)
- Init script `data/init-datasource.sql` creates the second database

Update startup validation, health check, and docs.

### Phase 1: Auth types + middleware + simple API key mode

Create `src/lib/auth/` directory with types, detection, middleware abstraction, and the simple API key validator. Extend the logger's `RequestContext` with optional user identity. Integrate into `route.ts`. Update frontend for API key input. Write tests.

### Phase 2: Better Auth managed mode

Install `better-auth`. Create `src/lib/auth/managed.ts` pointing at the internal Postgres (from `DATABASE_URL`). Create the catch-all auth route. Add login/signup UI to the frontend. Wire into middleware.

### Phase 3: BYOT (bring-your-own-token)

Install `jose`. Create `src/lib/auth/byot.ts` with JWKS verification. Wire into middleware. No frontend changes needed.

### Phase 4: Auth mode detection polish

Add startup validation for auth config (secret length, JWKS URL format, issuer presence). Log detected auth mode at startup. Add auth mode to health check response.

### Phase 5: Query audit log

Create `src/lib/auth/audit.ts`. Dual-write to pino and internal Postgres. Integrate into `sql.ts` after query execution. Fire-and-forget DB writes. Graceful degradation when `DATABASE_URL` is not set (pino-only). Write tests.

### Phase 6: Rate limiting

In-memory sliding window in `middleware.ts`. Per-user keying (user ID or IP). `ATLAS_RATE_LIMIT_RPM` config. 429 responses with `Retry-After`. Wire into route handlers after auth check.

## Design Constraints

- **bun only** — `bun add` for packages, never npm/yarn
- **Postgres only for internal DB** — no MySQL. One engine, one migration path.
- **TypeScript strict** — all new files fully typed
- **Opt-in auth** — no auth env vars = identical behavior to today (except the env var rename)
- **No secrets in responses** — auth errors are generic ("invalid credentials"), never reveal user existence or field specifics
- **Framework-agnostic middleware** — `authenticateRequest(req: Request)` uses Web Standard Request. Works with Next.js today, Hono in v0.6.
- **No Next.js middleware.ts** — auth is a function called from route handlers, not Next.js edge middleware. This keeps it portable.
- **Internal DB is invisible to the agent** — internal tables never appear in the semantic layer or table whitelist
- **Audit is always on** — even in mode "none", queries get audit entries (pino always, DB when available)
- **Graceful degradation** — no `DATABASE_URL` = no DB audit trail, but Atlas still works for local dev
- **Atlas starts without a datasource** — when `ATLAS_DATASOURCE_URL` is unset, the chat endpoint returns a helpful error ("No datasource configured"), not a crash.

## Health Check Response (updated)

```json
{
  "status": "ok",
  "checks": {
    "datasource": { "status": "ok", "latencyMs": 3 },
    "provider": { "status": "ok", "provider": "anthropic", "model": "(default)" },
    "semanticLayer": { "status": "ok", "entityCount": 12 },
    "explore": { "backend": "nsjail", "isolated": true },
    "auth": { "mode": "simple-key", "enabled": true },
    "internalDb": { "status": "ok", "latencyMs": 1 }
  }
}
```

When no datasource is configured:

```json
{
  "status": "degraded",
  "checks": {
    "datasource": { "status": "not_configured" },
    "provider": { "status": "ok", "provider": "anthropic", "model": "(default)" },
    "semanticLayer": { "status": "error", "entityCount": 0, "error": "MISSING_SEMANTIC_LAYER" },
    "explore": { "backend": "just-bash", "isolated": false },
    "auth": { "mode": "none", "enabled": false },
    "internalDb": { "status": "ok", "latencyMs": 1 }
  }
}
```

## ROADMAP Items Addressed

```
- [ ] Simple API key mode                    → Phase 1
- [ ] Better Auth integration                → Phase 2
- [ ] BYOT (bring-your-own-token)            → Phase 3
- [ ] Auth mode detection                    → Phase 4
- [ ] Query audit log                        → Phase 5
- [ ] Rate limiting                          → Phase 6
```

## Future (Not In Scope)

These are natural follow-ons but NOT part of this work:

- OAuth / social login (Better Auth plugins — add when needed)
- Password reset / email verification flows
- Admin UI for audit log browsing
- Per-user/role table-level permissions (v0.9 action safety framework)
- Multi-process rate limiting via Redis
- Saved queries / user preferences in internal DB (v0.6+)
- Integration configs in internal DB (v0.8+)
- Connection registry replacing `ATLAS_DATASOURCE_URL` with multi-source config (v0.6)

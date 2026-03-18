# Learned Patterns Schema & CRUD API — Design Spec

**Issue:** #586
**Milestone:** 0.8.0 — Intelligence & Learning
**Date:** 2026-03-18
**Branch:** `586-learned-patterns-schema`

## Overview

Add a `learned_patterns` table to the internal DB and CRUD admin endpoints. This is the foundation for the 0.8.0 dynamic learning layer — all other learning features (#587 agent proposals, #588 context injection, #589 admin UI) build on this schema and API.

## Architecture Decision: Sub-Router

Learned pattern routes live in a new file `packages/api/src/api/routes/admin-learned-patterns.ts`, mounted in `admin.ts` via `admin.route("/learned-patterns", adminLearnedPatterns)`. This follows the `admin-orgs.ts` sub-router precedent and avoids growing `admin.ts` (already ~3600 lines).

## Architecture Decision: Org-Scoping (Option B — Semantic-Org-Style)

Learned patterns are org-specific domain knowledge. A cybersecurity org's query patterns are meaningless to an e-commerce org. Follows the same isolation pattern as semantic entities (#508):

- **Multi-tenant**: Require `activeOrganizationId` from session. Filter all queries by `org_id`.
- **Single-tenant**: Store `org_id` as NULL. Filter by `org_id IS NULL`.
- **No global admin view** — admins must be in an org's context to review patterns. Cross-org visibility is a 0.9.0 platform admin concern.

## 1. DB Schema

New table added to `migrateInternalDB()` in `packages/api/src/lib/db/internal.ts`:

```sql
CREATE TABLE IF NOT EXISTS learned_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT,
  pattern_sql TEXT NOT NULL,
  description TEXT,
  source_entity TEXT,
  source_queries JSONB,
  confidence REAL NOT NULL DEFAULT 0.1,
  repetition_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_by TEXT,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);
```

**Indexes:**
- `idx_learned_patterns_org_status ON learned_patterns(org_id, status)` — primary query path
- `idx_learned_patterns_org_entity ON learned_patterns(org_id, source_entity)` — entity filter

**No foreign keys** to `audit_log` — `source_queries` stores audit log IDs as a JSONB string array. Audit entries may be purged independently.

### Column details

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK, default `gen_random_uuid()` | Unique identifier |
| `org_id` | TEXT | nullable | NULL in single-tenant mode |
| `pattern_sql` | TEXT | NOT NULL | Normalized SQL pattern |
| `description` | TEXT | nullable | Human-readable explanation |
| `source_entity` | TEXT | nullable | Primary table involved |
| `source_queries` | JSONB | nullable | Array of audit log entry IDs |
| `confidence` | REAL | NOT NULL, default 0.1 | Score 0.0-1.0 |
| `repetition_count` | INTEGER | NOT NULL, default 1 | Times pattern was seen |
| `status` | TEXT | NOT NULL, default 'pending' | pending/approved/rejected |
| `proposed_by` | TEXT | nullable | 'agent' or 'atlas-learn' |
| `reviewed_by` | TEXT | nullable | Admin user ID who reviewed |
| `created_at` | TIMESTAMPTZ | NOT NULL, default now() | Creation timestamp |
| `updated_at` | TIMESTAMPTZ | NOT NULL, default now() | Last modification |
| `reviewed_at` | TIMESTAMPTZ | nullable | When status was changed by admin |

## 2. Types

New file `packages/types/src/learned-pattern.ts`, re-exported from `packages/types/src/index.ts`:

```typescript
export type LearnedPatternStatus = "pending" | "approved" | "rejected";
export type LearnedPatternSource = "agent" | "atlas-learn";

export interface LearnedPattern {
  id: string;
  orgId: string | null;
  patternSql: string;
  description: string | null;
  sourceEntity: string | null;
  sourceQueries: string[] | null;
  confidence: number;
  repetitionCount: number;
  status: LearnedPatternStatus;
  proposedBy: LearnedPatternSource | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}
```

Convention: DB columns are `snake_case`, wire types are `camelCase` (matches `Conversation`, `ActionLogEntry`). Union type over const array — no runtime iteration needed for status values.

## 3. Admin API Routes

File: `packages/api/src/api/routes/admin-learned-patterns.ts`

All endpoints use `adminAuthPreamble()` + `hasInternalDB()` guard + `withRequestContext()`. Org-scoping: grab `activeOrganizationId` from auth result, build WHERE clause with `org_id = $N` or `org_id IS NULL`.

A `toLearnedPattern(row)` helper converts snake_case DB rows to camelCase wire format.

### Endpoints

#### `GET /` — List patterns

Query params: `status`, `source_entity`, `min_confidence`, `max_confidence`, `limit` (default 50, max 200), `offset`.

Dynamically builds WHERE clause from provided filters. Always includes org_id filter. Orders by `created_at DESC`.

Returns: `{ patterns: LearnedPattern[], total: number, limit: number, offset: number }`

#### `GET /:id` — Single pattern

Returns the pattern if found and belongs to current org. 404 otherwise.

#### `PATCH /:id` — Update pattern

Body fields (all optional): `description`, `status`.

- `status` must be `pending`, `approved`, or `rejected`
- On status change: sets `reviewed_by` to current user ID, `reviewed_at` to now
- Always sets `updated_at` to now
- 404 if not found or wrong org

#### `DELETE /:id` — Delete pattern

Hard delete. 404 if not found or wrong org.

#### `POST /bulk` — Bulk status change

Body: `{ ids: string[], status: 'approved' | 'rejected' }`

Processes each ID individually. Skips IDs not found or belonging to a different org. Sets `reviewed_by`/`reviewed_at` on each updated row.

Returns: `{ updated: string[], notFound: string[] }`

### Error responses

All follow existing admin patterns:
- 400: `{ error: "invalid_request", message: "..." }`
- 401: `{ error: "auth_error" | "session_expired", message: "..." }`
- 403: `{ error: "forbidden_role", message: "Admin role required." }`
- 404: `{ error: "not_found" | "not_available", message: "..." }`
- 429: `{ error: "rate_limited", message: "...", retryAfterSeconds }`
- 500: `{ error: "internal_error", message: "...", requestId }`

## 4. Config

### Zod schema addition (`AtlasConfigSchema`):

```typescript
learn: z.object({
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
}).optional(),
```

### `ResolvedConfig` addition:

```typescript
learn?: { confidenceThreshold: number };
```

### Env var: `ATLAS_LEARN_CONFIDENCE_THRESHOLD`

Default 0.7, range 0.0-1.0. Parsed in `resolveFromEnv()` with `parseFloat()` + `Number.isFinite()` validation.

Config file: `learn.confidenceThreshold` in `atlas.config.ts`.

This threshold is **not consumed** by any code in this PR. It establishes the config surface for #588 (context injection) to use.

## 5. Tests

File: `packages/api/src/api/__tests__/admin-learned-patterns.test.ts`

Mock setup: `mock.module()` for auth middleware and internal DB. All named exports mocked per CLAUDE.md rules.

### Test groups

1. **Auth gating** — non-admin 403, unauthenticated 401
2. **No internal DB** — 404 with `not_available`
3. **CRUD operations:**
   - GET `/` — returns patterns, respects limit/offset, default ordering
   - GET `/:id` — returns single pattern, 404 for missing
   - PATCH `/:id` — updates description, updates status with reviewed_by/reviewed_at, 404 for missing
   - DELETE `/:id` — removes pattern, 404 for missing
4. **Org-scoping** — patterns from org A not visible to org B, queries include org_id filter
5. **Filters** — status, source_entity, confidence range (min/max), combined
6. **Bulk operations** — approve multiple, partial success (updated/notFound split), invalid status rejected

## Files Changed

| File | Change |
|------|--------|
| `packages/api/src/lib/db/internal.ts` | Add `learned_patterns` table + indexes to `migrateInternalDB()` |
| `packages/types/src/learned-pattern.ts` | New — `LearnedPattern`, `LearnedPatternStatus`, `LearnedPatternSource` |
| `packages/types/src/index.ts` | Re-export `./learned-pattern` |
| `packages/api/src/api/routes/admin-learned-patterns.ts` | New — sub-router with 5 endpoints |
| `packages/api/src/api/routes/admin.ts` | Import + mount sub-router |
| `packages/api/src/lib/config.ts` | Add `learn` schema, env var, resolved config field |
| `packages/api/src/api/__tests__/admin-learned-patterns.test.ts` | New — test suite |
| `.claude/research/ROADMAP.md` | Mark item `[x]` with PR number |

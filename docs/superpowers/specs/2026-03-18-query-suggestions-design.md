# Query Suggestion Engine — Design Spec

**Issue:** #591
**Milestone:** 0.8.0 — Intelligence & Learning
**Date:** 2026-03-18

## Overview

Mine the audit log to surface "people who queried this table also asked..." suggestions. Organizational query history becomes a discovery tool via ranked, deduplicated suggestions shown in the chat empty state and after query results.

## Key Decisions

1. **Separate `query_suggestions` table** — user-facing discovery, distinct from agent-facing `learned_patterns` (system prompt injection)
2. **Reuse `normalizeSQL`/`fingerprintSQL`/`extractPatternInfo`** from `pattern-analyzer.ts`
3. **Description auto-generated** from SQL structure via `extractPatternInfo()`, not from user messages
4. **30-day half-life scoring** — `frequency × 1/(1 + daysSinceLastSeen/30)`
5. **`atlas learn --suggestions`** CLI flag for batch generation (not a separate command)
6. **User-facing API** for reads + click tracking; admin routes for prune
7. **Dual query strategy** — `primary_table IN (...)` fast path, `tables_involved ?| array[...]` for multi-table overlap
8. **Post-query fetch gated** on message completion, not streaming chunks
9. **Silent failure on frontend** — suggestions never block chat

## Data Model

### Table: `query_suggestions`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `org_id` | TEXT | Org scoping (null = global) |
| `description` | TEXT NOT NULL | Auto-generated human-readable description (e.g. "Aggregation query joining orders and customers") |
| `pattern_sql` | TEXT NOT NULL | Normalized SQL template (literals replaced with placeholders) |
| `normalized_hash` | TEXT NOT NULL | SHA-256 fingerprint (16 chars) for dedup |
| `tables_involved` | JSONB NOT NULL | Array of table names extracted from the query |
| `primary_table` | TEXT | Main table for fast contextual filtering |
| `frequency` | INTEGER DEFAULT 1 | Number of audit log occurrences |
| `clicked_count` | INTEGER DEFAULT 0 | Engagement tracking — incremented on user click |
| `last_seen_at` | TIMESTAMPTZ | Most recent audit log occurrence |
| `created_at` | TIMESTAMPTZ | First generated |
| `updated_at` | TIMESTAMPTZ | Last batch refresh |

**Indexes:**
- `UNIQUE(org_id, normalized_hash)` — dedup constraint, supports upsert
- `(org_id, primary_table)` — contextual lookups by table
- `(org_id, frequency DESC)` — popular suggestions ordering

### Shared Type: `QuerySuggestion`

Location: `packages/types/src/query-suggestion.ts`

```typescript
export interface QuerySuggestion {
  id: string;
  orgId: string | null;
  description: string;
  patternSql: string;
  tablesInvolved: string[];
  primaryTable: string | null;
  frequency: number;
  clickedCount: number;
  lastSeenAt: string;
  createdAt: string;
}
```

## Analysis Engine

Location: `packages/api/src/lib/learn/suggestions.ts`

### Flow

1. **Fetch** — Query `audit_log` for successful queries (`success = true`), scoped by org
2. **Normalize & group** — For each query: `normalizeSQL()` → `fingerprintSQL()` → group by fingerprint, accumulate count + most recent timestamp
3. **Generate descriptions** — `extractPatternInfo()` auto-generates from SQL structure (e.g. "Aggregation query joining orders and customers with GROUP BY")
4. **Filter** — Drop patterns with `count < 2`. Drop patterns matching YAML `query_patterns` via `getYamlPatterns(semanticRoot)` when filesystem semantic layer exists; skip this filter in SaaS mode (dedup via `normalized_hash` still prevents exact duplicates)
5. **Score** — `score = frequency × 1/(1 + daysSinceLastSeen/30)` — 30-day half-life, recent queries rank higher
6. **Upsert** — `INSERT ... ON CONFLICT (org_id, normalized_hash) DO UPDATE SET frequency, last_seen_at, updated_at` — idempotent batch job

### Exported Functions

- `generateSuggestions(orgId: string | null): Promise<{ created: number; updated: number }>` — batch entry point
- `scoreSuggestion(frequency: number, lastSeenAt: Date): number` — exported for testing

## CLI Command

Extend `atlas learn` in `packages/cli/commands/learn.ts`:

```
atlas learn                    # existing: analyze + propose patterns
atlas learn --suggestions      # new: generate query suggestions from audit log
```

Calls `generateSuggestions(orgId)`, reports `{ created, updated }` counts.

## API Routes

### User-Facing: `packages/api/src/api/routes/suggestions.ts`

Registered on main app (not admin). Auth via `authenticateRequest`.

**`GET /api/v1/suggestions?table=orders&table=customers&limit=5`**
- Returns suggestions where `tables_involved` overlaps requested tables
- Fast path: `primary_table IN (...)` for single-table queries
- Multi-table: `tables_involved ?| array[...]` JSONB overlap
- Ordered by score (frequency × recency)
- Org-scoped, default limit 10, max 50

**`GET /api/v1/suggestions/popular?limit=5`**
- Top suggestions across all tables for the org
- Ordered by score
- For empty state / new conversation

**`POST /api/v1/suggestions/:id/click`**
- Increments `clicked_count`
- Fire-and-forget from frontend
- 204 No Content response
- Org-scoped (verify suggestion belongs to org)

**Response shape (both GETs):**
```typescript
{ suggestions: QuerySuggestion[]; total: number }
```

### Admin: registered under `/api/v1/admin/suggestions`

Uses `adminAuthPreamble`.

**`GET /api/v1/admin/suggestions`** — List all suggestions with filters (org, table, min frequency)
**`DELETE /api/v1/admin/suggestions/:id`** — Prune a suggestion

## Frontend Integration

### Empty State (`packages/web/src/ui/components/atlas-chat.tsx`)

1. Fetch `GET /api/v1/suggestions/popular?limit=6` on mount (new conversation, no messages)
2. Show as clickable chips below welcome text
3. Click: populate chat input with `description`, fire `POST /suggestions/:id/click`
4. Loading: 3 skeleton shimmer pills. Error/empty: silently show nothing

### Post-Query (`packages/web/src/ui/components/chat/follow-up-chips.tsx`)

1. Gate on message completion (not streaming) — avoid refetching during streaming chunks
2. Extract table names from the completed assistant message's SQL
3. Fetch `GET /api/v1/suggestions?table=X&table=Y&limit=3`
4. Render below agent-generated follow-up suggestions with "Related queries" label
5. Same click behavior: populate input + track click

### New Component: `SuggestionChips`

Location: `packages/web/src/ui/components/chat/suggestion-chips.tsx`

Props: `suggestions: QuerySuggestion[]`, `onSelect: (text: string, id: string) => void`, `loading: boolean`

Uses shadcn `Button` variant="outline" with `Sparkles` Lucide icon prefix. Reused by both empty state and post-query integration points.

### Data Fetching

Standard `fetch` calls — no SWR/React Query. Empty-state fetch fires once on mount. Post-query fetch fires when last message is complete and contains SQL results.

## Testing

### Unit Tests (`packages/api/src/lib/__tests__/suggestions.test.ts`)

- Normalize → fingerprint → dedup grouping produces correct results
- `scoreSuggestion`: high frequency + recent > low frequency + old
- Filter: count < 2 excluded, YAML duplicates excluded
- Upsert idempotency: running twice updates frequency, no duplicates

### API Tests (`packages/api/src/api/__tests__/suggestions.test.ts`)

- `GET /suggestions?table=X` returns matching suggestions, org-scoped
- `GET /suggestions/popular` returns top-N ordered by score
- `POST /suggestions/:id/click` increments count, returns 204
- Auth required (401 without token)
- Admin endpoints: require admin role, delete works

### Mock Strategy

- `_resetPool()` from `internal.ts` to inject mock pool
- Mock audit_log query results to control input data
- `createConnectionMock()` for connection-dependent tests

## Files Changed/Created

| File | Action |
|------|--------|
| `packages/types/src/query-suggestion.ts` | **Create** — `QuerySuggestion` type |
| `packages/types/src/index.ts` | **Edit** — re-export |
| `packages/api/src/lib/db/internal.ts` | **Edit** — add `query_suggestions` table + helpers |
| `packages/api/src/lib/learn/suggestions.ts` | **Create** — analysis engine |
| `packages/api/src/api/routes/suggestions.ts` | **Create** — user-facing API routes |
| `packages/api/src/api/routes/admin-suggestions.ts` | **Create** — admin routes |
| `packages/api/src/api/routes/admin.ts` | **Edit** — register admin suggestions route |
| `packages/api/src/api/index.ts` | **Edit** — register suggestions route |
| `packages/cli/commands/learn.ts` | **Edit** — add `--suggestions` flag |
| `packages/web/src/ui/components/chat/suggestion-chips.tsx` | **Create** — reusable chip component |
| `packages/web/src/ui/components/atlas-chat.tsx` | **Edit** — empty state integration |
| `packages/web/src/ui/components/chat/follow-up-chips.tsx` | **Edit** — post-query suggestions |
| `packages/web/src/ui/lib/types.ts` | **Edit** — re-export QuerySuggestion |
| `packages/api/src/lib/__tests__/suggestions.test.ts` | **Create** — unit tests |
| `packages/api/src/api/__tests__/suggestions.test.ts` | **Create** — API tests |
| `apps/docs/content/docs/reference/cli.mdx` | **Edit** — document `--suggestions` flag |
| `apps/docs/content/docs/guides/admin-console.mdx` | **Edit** — document admin suggestions |
| `.claude/research/ROADMAP.md` | **Edit** — mark #591 complete |

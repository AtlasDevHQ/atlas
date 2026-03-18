# Prompt Library + LRU Eviction Design Spec

**Issues:** #590 (Prompt Library), #601 (LRU Eviction)
**Milestone:** 0.8.0 — Intelligence & Learning
**Branch:** `feat/prompt-library`
**Date:** 2026-03-18

---

## Part 1: LRU Eviction (#601)

### Problem

The in-memory pattern cache in `packages/api/src/lib/learn/pattern-cache.ts` grows without bound — one entry per org, each holding up to 100 `ApprovedPatternRow` objects. TTL provides lazy expiration only when entries are accessed. Entries for orgs that stop making requests persist until server restart.

### Solution

Add bounded-size LRU eviction to the existing cache Map (~30 lines):

- `MAX_ENTRIES = 500` constant
- Add `lastAccessedAt: number` to `CacheEntry` interface
- On `cache.get()` hit: update `lastAccessedAt` to `Date.now()`
- On `cache.set()`: if `cache.size >= MAX_ENTRIES`, find the entry with the oldest `lastAccessedAt` and evict it before inserting
- No external LRU library — simple linear scan is fine for 500 entries

### Files Changed

| File | Change |
|------|--------|
| `packages/api/src/lib/learn/pattern-cache.ts` | Add MAX_ENTRIES, lastAccessedAt tracking, eviction logic |
| `packages/api/src/lib/__tests__/pattern-cache.test.ts` | New test file for cache behavior including eviction |

---

## Part 2: Prompt Library (#590)

Curated per-industry prompt collections that give users starting points for common analyses.

### Types

**File:** `packages/types/src/prompt.ts`

```typescript
export interface PromptCollection {
  id: string;
  orgId: string | null;
  name: string;
  industry: string;
  description: string;
  isBuiltin: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromptItem {
  id: string;
  collectionId: string;
  question: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
```

Export from `packages/types/src/index.ts`.

### Database Schema

**File:** `packages/api/src/lib/db/internal.ts`

Two new tables added to `migrateInternalDB()`:

```sql
CREATE TABLE IF NOT EXISTS prompt_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prompt_collections_org ON prompt_collections(org_id);
CREATE INDEX IF NOT EXISTS idx_prompt_collections_builtin ON prompt_collections(is_builtin) WHERE is_builtin = true;

CREATE TABLE IF NOT EXISTS prompt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES prompt_collections(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  description TEXT,
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prompt_items_collection ON prompt_items(collection_id);
```

### Seed Data

A `seedPromptLibrary()` function called from `migrateInternalDB()`. Idempotent per-collection: checks for each built-in collection by name and inserts only missing ones (not by global count). This handles partial-seed recovery correctly.

Three built-in collections:

1. **SaaS Metrics** (industry: "saas") — 12 prompts covering MRR, churn, LTV, CAC, ARPU, expansion revenue, etc.
2. **E-commerce KPIs** (industry: "ecommerce") — 12 prompts covering GMV, AOV, conversion rate, cart abandonment, top products, etc.
3. **Cybersecurity Compliance** (industry: "cybersecurity") — 12 prompts covering vulnerability counts, patch rates, incident response times, compliance scores, etc.

Built-in collections have `is_builtin = true` and `org_id = NULL`.

### API Routes

#### User-Facing Routes

**File:** `packages/api/src/api/routes/prompts.ts`

Auth via `authPreamble` (non-admin, any authenticated user). Both routes check `hasInternalDB()` — return `{ collections: [] }` / 404 when no internal DB is configured.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/prompts` | List collections (built-in + user's org). Returns `{ collections: PromptCollection[] }` |
| GET | `/api/v1/prompts/:id` | Collection detail with items. Returns `{ collection: PromptCollection, items: PromptItem[] }` |

Collections returned: `WHERE org_id IS NULL OR org_id = $userOrgId`, ordered by `sort_order ASC`.
The GET /:id endpoint applies the same org-scoping filter — a user cannot fetch collections belonging to other orgs by guessing UUIDs.
Items ordered by `sort_order ASC`.
All 500 responses include `requestId` for log correlation.

**Mounting:** `app.route("/api/v1/prompts", prompts)` in `packages/api/src/api/index.ts`.

#### Admin CRUD Routes

**File:** `packages/api/src/api/routes/admin-prompts.ts`

Auth via `adminAuthPreamble`. All mutations reject built-in collections (`is_builtin = true`). All item CRUD routes verify the parent collection belongs to the admin's org (`collection.org_id = activeOrganizationId`) before allowing mutations.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/prompts` | List all collections (admin view with full details) |
| POST | `/admin/prompts` | Create collection (org-scoped to admin's org) |
| PATCH | `/admin/prompts/:id` | Update collection (rejects built-in) |
| DELETE | `/admin/prompts/:id` | Delete collection + cascade items (rejects built-in) |
| POST | `/admin/prompts/:id/items` | Add item to collection |
| PATCH | `/admin/prompts/:collectionId/items/:itemId` | Update item |
| DELETE | `/admin/prompts/:collectionId/items/:itemId` | Delete item |
| PUT | `/admin/prompts/:id/reorder` | Reorder items. Body: `{ itemIds: string[] }` |

**Reorder validation:** The `itemIds` array must contain exactly the set of item IDs belonging to the collection (no extras, no missing). Sort order is set to array index (0-based). The operation runs in a transaction for consistency. Returns 400 if IDs don't match.

**Mounting:** `admin.route("/prompts", adminPrompts)` and `admin.route("/prompts/", adminPrompts)` (both with and without trailing slash) in `packages/api/src/api/routes/admin.ts`.

### Admin UI

**Files:**
- `packages/web/src/app/admin/prompts/page.tsx` — main page
- `packages/web/src/app/admin/prompts/columns.tsx` — DataTable column definitions
- `packages/web/src/app/admin/prompts/search-params.ts` — nuqs search params

**Patterns followed:** Matches learned-patterns page structure:
- DataTable listing collections with item count, industry badge, builtin badge
- Sheet detail panel on row click
- Dialog for create/edit collection
- Item management within collection detail (add, edit, delete, reorder)
- Built-in collections shown read-only (no edit/delete actions)
- Error handling: ErrorBanner, EmptyState, LoadingState, FeatureGate
- Optimistic updates on mutations

**Admin sidebar:** Add `{ href: "/admin/prompts", label: "Prompt Library", icon: BookOpen }` to `navItems` in `packages/web/src/ui/components/admin/admin-sidebar.tsx`.

### Chat Prompt Library

**File:** `packages/web/src/ui/components/chat/prompt-library.tsx`

A Sheet (drawer) component, triggered by a `BookOpen` icon button in the chat header bar (next to the schema explorer `TableProperties` button). This matches the existing schema explorer pattern rather than crowding the conversation sidebar.

**Behavior:**
- Lists collections as expandable accordion sections
- Each item shows question text + optional description
- Click on an item closes the Sheet and calls `handleSend(question)` — immediate submission, matching existing `STARTER_PROMPTS` behavior
- Simple keyword search/filter across all collections and items

**Props:** `open: boolean`, `onOpenChange: (open: boolean) => void`, `onSendPrompt: (text: string) => void`, `getHeaders: () => Record<string, string>`, `getCredentials: () => RequestCredentials`

Fetches collections on open, caches in component state for the session (re-fetches only on re-mount).

### Empty State Enhancement

In `packages/web/src/ui/components/atlas-chat.tsx`, when `messages.length === 0`:
- Below the existing `STARTER_PROMPTS` grid, add a subtle "Browse prompt library" link
- Clicking opens the prompt library Sheet

### Docs Updates

- `apps/docs/content/docs/guides/admin-console.mdx` — add Prompt Library admin section
- `.claude/research/ROADMAP.md` — mark #590 with `[x]` and PR number

### Tests

**File:** `packages/api/src/api/__tests__/prompts.test.ts`

- Seed data verification: 3 built-in collections exist after migration, each with correct item count
- User-facing GET: returns built-in + org collections, excludes other orgs
- GET /:id: returns collection with items, 404 for missing
- Admin CRUD: create, update, delete collections
- Admin item management: add, update, delete, reorder items
- Built-in protection: reject update/delete on built-in collections
- Org isolation: custom collections scoped to org

Mock pattern: follows existing test structure using `mock.module()` with full export coverage and `createConnectionMock()`.

---

## Acceptance Criteria

- [ ] LRU eviction caps pattern cache at 500 entries
- [ ] 3 built-in collections seeded on first boot
- [ ] Admin can create/edit/delete custom collections and items
- [ ] Users can browse collections in chat sidebar (Sheet)
- [ ] Click-to-ask populates chat input and submits
- [ ] Org-scoped: custom collections visible only to their org
- [ ] Built-in collections not editable (only custom ones)
- [ ] Tests for API CRUD, seed data, and LRU eviction
- [ ] Admin console docs updated
- [ ] ROADMAP updated

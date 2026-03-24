# ADR: Semantic Layer Editor

**Status:** Deferred
**Date:** 2026-03-05
**Scope:** Admin Console — Phase 2 write operations (extends #260)

## Context

The admin console ships with a read-only semantic layer browser (`/admin/semantic`) that displays entities, metrics, glossary, and catalog in a pretty-printed or raw YAML view. Today, editing the semantic layer requires:

1. Hand-editing YAML files on disk
2. Re-running `atlas init` (profiles from scratch)
3. SSH/shell access to the deployment

This is fine for developers but blocks data team leads and analysts who want to tune descriptions, add virtual dimensions, or define new metrics without touching files. The multi-source design doc (`byod-multi-source.md`, section 8.4) already calls out a v1.1+ UI editor — this ADR specifies the design.

## Decision: Deferred

**2026-03-05:** Shelved the write/edit UI. The current audience is developers who manage the semantic layer as code (`atlas init`, hand-edit YAML, commit, redeploy). Building an admin editor adds complexity without clear demand yet. Key blockers:

- **Storage model uncertainty** — file-based writes don't work on Vercel (read-only filesystem). A DB-backed semantic layer solves this but is a much larger architectural change (affects `atlas init`, `atlas diff`, explore tool, the agent's file-reading workflow)
- **Sidecar sync** — even with DB storage, the sidecar needs a mechanism to pick up changes
- **Audience mismatch** — current users are comfortable with YAML + git workflows

**Instead:** Update the admin semantic browser pages to clearly communicate that updates are made through code (`atlas init`, YAML editing, redeploy). Revisit this ADR when non-developer personas (data team leads, analysts) become a primary audience.

The design below is preserved for when we return to this.

## Decision

Add CRUD operations for semantic layer files to the admin console: a **form-based editor** for structured editing with a **raw YAML toggle** for power users. Writes go through new admin API endpoints with validation, path-traversal protection, and whitelist cache invalidation.

## Scope

### In scope (this ADR)
- Entity CRUD (create, read, update, delete)
- Metrics CRUD
- Glossary editing
- Catalog metadata editing
- YAML validation on save (Zod schema + `yaml` round-trip, comment-preserving)
- Whitelist cache invalidation after writes
- Optimistic locking (ETag / file mtime) to prevent concurrent edit conflicts

### Out of scope (future)
- Git-backed semantic layer (commit-on-save, PR workflow)
- Vercel read-only filesystem support (requires DB-backed or git-backed store)
- LLM-assisted editing (auto-generate descriptions, suggest virtual dimensions)
- Schema drift detection with auto-fix (existing `atlas diff` covers detection)
- Drag-and-drop reordering of dimensions/measures
- Bulk import/export

---

## Architecture

### API Layer

New admin routes in `packages/api/src/api/routes/admin.ts`. All require admin role via `adminAuthPreamble()`.

#### Entity Endpoints

| Method | Route | Body | Description |
|--------|-------|------|-------------|
| `PUT` | `/semantic/entities/:name` | `{ yaml: string }` | Update entity YAML |
| `POST` | `/semantic/entities` | `{ name: string, yaml: string }` | Create new entity |
| `DELETE` | `/semantic/entities/:name` | — | Delete entity file |

#### Metrics Endpoints

| Method | Route | Body | Description |
|--------|-------|------|-------------|
| `PUT` | `/semantic/metrics/:name` | `{ yaml: string }` | Update metrics YAML |
| `POST` | `/semantic/metrics` | `{ name: string, yaml: string }` | Create new metrics file |
| `DELETE` | `/semantic/metrics/:name` | — | Delete metrics file |

#### Glossary & Catalog

| Method | Route | Body | Description |
|--------|-------|------|-------------|
| `PUT` | `/semantic/glossary` | `{ yaml: string }` | Update glossary |
| `PUT` | `/semantic/catalog` | `{ yaml: string }` | Update catalog |

#### Multi-source Entities

| Method | Route | Body | Description |
|--------|-------|------|-------------|
| `PUT` | `/semantic/:source/entities/:name` | `{ yaml: string }` | Update source-scoped entity |
| `POST` | `/semantic/:source/entities` | `{ name: string, yaml: string }` | Create source-scoped entity |
| `DELETE` | `/semantic/:source/entities/:name` | — | Delete source-scoped entity |

### Validation Pipeline

Every write goes through a 4-step validation before touching disk:

```
Incoming YAML string
    │
    ├─ 1. YAML parse ──────── yaml.parseDocument() — reject malformed YAML (preserves comments)
    │
    ├─ 2. Schema validation ── Zod schema per file type — reject structurally invalid files
    │
    ├─ 3. Path validation ──── isValidEntityName() + resolved path must be under semantic root
    │
    ├─ 4. Semantic checks ──── Entity: table name required, dimensions must have name+type
    │                          Metrics: each metric needs id+sql
    │                          Glossary: each term needs status+definition
    │
    └─ 5. Write + invalidate ─ fs.writeFile() → _resetWhitelists() → respond 200
```

#### Zod Schemas (new, stricter than read-path)

The existing `EntityShape` is intentionally loose (`.passthrough()` with just `table: string`). For writes, we need stricter validation:

```typescript
// packages/api/src/lib/semantic-validation.ts (new file)

const DimensionSchema = z.object({
  name: z.string().min(1),
  sql: z.string().optional(),          // defaults to column name
  type: z.string().min(1),             // string, number, date, boolean, etc.
  description: z.string().optional(),
  primary_key: z.boolean().optional(),
  virtual: z.boolean().optional(),
  sample_values: z.array(z.union([z.string(), z.number()])).optional(),
});

const MeasureSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
  type: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]),
  description: z.string().optional(),
});

const JoinSchema = z.object({
  to: z.string().optional(),
  description: z.string().min(1),
  type: z.enum(["many_to_one", "one_to_many", "one_to_one", "many_to_many"]).optional(),
});

const QueryPatternSchema = z.object({
  description: z.string().min(1),
  sql: z.string().min(1),
});

const VirtualDimensionSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
  type: z.string().min(1),
  description: z.string().optional(),
  virtual: z.literal(true).optional(),
  sample_values: z.array(z.union([z.string(), z.number()])).optional(),
});

export const EntityWriteSchema = z.object({
  name: z.string().optional(),
  table: z.string().min(1),
  type: z.enum(["dimension_table", "view"]).optional(),
  grain: z.string().optional(),
  description: z.string().optional(),
  connection: z.string().optional(),
  dimensions: z.array(DimensionSchema).min(1),
  measures: z.array(MeasureSchema).optional(),
  joins: z.union([z.array(JoinSchema), z.record(JoinSchema)]).optional(),
  virtual_dimensions: z.array(VirtualDimensionSchema).optional(),
  query_patterns: z.array(QueryPatternSchema).optional(),
  use_cases: z.array(z.string()).optional(),
});

const MetricSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["atomic", "breakdown", "derived"]),
  sql: z.string().min(1),
  unit: z.string().optional(),
  aggregation: z.string().optional(),
  objective: z.enum(["maximize", "minimize", "maintain"]).optional(),
  source: z.object({ entity: z.string(), measure: z.string().optional() }).optional(),
});

export const MetricsWriteSchema = z.object({
  metrics: z.array(MetricSchema).min(1),
});

const GlossaryTermSchema = z.object({
  status: z.enum(["defined", "ambiguous"]),
  definition: z.string().optional(),
  note: z.string().optional(),
  tables: z.array(z.string()).optional(),
  possible_mappings: z.array(z.string()).optional(),
});

export const GlossaryWriteSchema = z.object({
  terms: z.record(GlossaryTermSchema),
});

export const CatalogWriteSchema = z.object({
  version: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  entities: z.array(z.object({
    name: z.string(),
    file: z.string(),
    grain: z.string().optional(),
    description: z.string().optional(),
    use_for: z.array(z.string()).optional(),
    common_questions: z.array(z.string()).optional(),
  })).optional(),
  glossary: z.string().optional(),
  metrics: z.array(z.object({
    file: z.string(),
    description: z.string().optional(),
  })).optional(),
});
```

### Cache Invalidation

After any successful write, call `_resetWhitelists()` from `semantic.ts` to clear the cached table whitelist. The next `executeSQL` call will re-read from disk.

For multi-instance deployments (multiple API pods), cache invalidation is local only. This is acceptable for now — the whitelist is lazy-loaded per request, so pods converge within one request cycle. A future improvement could add a filesystem watcher or a pub/sub invalidation signal.

### Optimistic Locking

Prevent two admins from overwriting each other's changes:

1. **Read:** `GET /semantic/entities/:name` returns `ETag` header (SHA-256 of file content)
2. **Write:** `PUT /semantic/entities/:name` requires `If-Match` header with the ETag
3. **Conflict:** If file changed since read, return `409 Conflict` with current content

```typescript
// Simplified flow in route handler
const currentContent = await fs.readFile(filePath, "utf-8");
const currentEtag = createHash("sha256").update(currentContent).digest("hex");

if (req.header("If-Match") && req.header("If-Match") !== currentEtag) {
  return c.json({ error: "File modified by another user", current: currentContent }, 409);
}
```

For new files (`POST`), check that the file doesn't already exist — return `409` if it does.

### Audit Trail

All write operations log to the audit system (existing `auditLog()` in `packages/api/src/lib/auth/audit.ts`):

```typescript
await auditLog({
  action: "semantic.entity.update",   // or .create, .delete
  resource: "entities/companies.yml",
  userId: user.id,
  details: { diff: "..." },           // optional: before/after summary
});
```

---

## UI Design

### Navigation

No new sidebar items needed. The existing `/admin/semantic` page gains an "Edit" mode toggle.

### Layout Modes

**Browse mode (current):** Read-only. File tree on the left, pretty-printed content on the right. No changes.

**Edit mode (new):** Same layout, but the right panel becomes editable.

```
┌──────────────────────────────────────────────────────┐
│  Semantic Layer                    [Browse] [Edit]    │
├──────────┬───────────────────────────────────────────┤
│ 📁 File  │  Entity: companies                        │
│  Tree    │  ┌─────────────────────────────────────┐  │
│          │  │ Table: [companies        ]          │  │
│ + New    │  │ Grain: [one row per customer co... ] │  │
│          │  │ Description:                        │  │
│ catalog  │  │ ┌─────────────────────────────────┐ │  │
│ glossary │  │ │ Customer companies representing │ │  │
│ entities/│  │ │ our B2B client base...          │ │  │
│  ├ co... │  │ └─────────────────────────────────┘ │  │
│  ├ pe... │  │                                     │  │
│  └ ac... │  │ Dimensions                  [+ Add] │  │
│ metrics/ │  │ ┌───┬──────┬────────┬─────────────┐ │  │
│  ├ co... │  │ │PK │ Name │ Type   │ Description │ │  │
│  └ ac... │  │ ├───┼──────┼────────┼─────────────┤ │  │
│          │  │ │ ✓ │ id   │ number │ Primary key │ │  │
│          │  │ │   │ name │ string │ Company nam │ │  │
│          │  │ │   │ ...  │  ...   │     ...     │ │  │
│          │  │ └───┴──────┴────────┴─────────────┘ │  │
│          │  │                                     │  │
│          │  │ Measures                    [+ Add] │  │
│          │  │ Joins                       [+ Add] │  │
│          │  │ Query Patterns              [+ Add] │  │
│          │  │                                     │  │
│          │  │         [Save] [Discard] [YAML ↔]   │  │
│          │  └─────────────────────────────────────┘  │
└──────────┴───────────────────────────────────────────┘
```

### Form Sections (Entity Editor)

Each section is collapsible. Sections map directly to YAML top-level keys.

| Section | Fields | UI Pattern |
|---------|--------|------------|
| **Header** | name, table, type, grain, description, connection | Text inputs + textarea + select |
| **Dimensions** | name, sql, type, description, primary_key, sample_values | Editable table with inline editing. Row actions: edit, delete, reorder. "+ Add" button |
| **Virtual Dimensions** | name, sql, type, description, sample_values | Same as dimensions, with SQL textarea. `virtual: true` set automatically |
| **Measures** | name, sql, type, description | Editable table. Type is a select dropdown (count, count_distinct, sum, avg, min, max) |
| **Joins** | to, description, type | Editable table. "to" autocompletes from other entity names |
| **Query Patterns** | description, sql | Card list. Each card has a description input + SQL editor (Monaco or textarea) |
| **Use Cases** | free-text strings | Editable list of text inputs |

### Form Sections (Metrics Editor)

| Section | Fields | UI Pattern |
|---------|--------|------------|
| **Metric Card** | id, label, description, type, sql, unit, aggregation, objective, source | Card per metric. Type is a select (atomic/breakdown/derived). SQL gets a code textarea. Objective is a select |
| **Add Metric** | — | "+ Add Metric" button at bottom |

### Form Sections (Glossary Editor)

| Section | Fields | UI Pattern |
|---------|--------|------------|
| **Term Card** | term name, status, definition, note, tables, possible_mappings | Card per term. Status toggles between defined/ambiguous — shows different fields per status |
| **Add Term** | — | "+ Add Term" button |

### YAML Toggle

A "YAML" tab shows the raw YAML in a code editor (Monaco, dynamically imported). Changes in the form update the YAML preview and vice versa — but they are **not** live-synced bidirectionally during editing. Instead:

- **Form → YAML:** Clicking the YAML tab serializes the current form state to YAML
- **YAML → Form:** Clicking the Form tab parses the YAML and populates the form. Parse errors show an inline banner

This avoids the complexity of real-time bidirectional sync while still letting power users drop into raw YAML when needed.

### Create New Entity Flow

1. Click "+ New" in the file tree
2. Choose type: Entity, Metric, or Glossary Term
3. For entities: modal asks for entity name (becomes filename) and table name
4. For metrics: modal asks for metric file name
5. Editor opens with a minimal template pre-filled
6. Save writes the new file

### Delete Flow

1. Right-click entity in file tree → "Delete" (or delete button in header)
2. Confirmation dialog: "Delete entities/companies.yml? This removes it from the semantic layer. The underlying database table is not affected."
3. On confirm: `DELETE /api/v1/admin/semantic/entities/:name`
4. File tree updates, selection moves to next item

### Unsaved Changes

- Dirty state tracked per file. Unsaved files show a dot indicator in the file tree
- Navigating away from a dirty file shows a "Discard changes?" confirmation
- Browser `beforeunload` event prevents accidental tab close with unsaved changes

---

## Component Plan

### New Components

| Component | Location | Description |
|-----------|----------|-------------|
| `EntityForm` | `packages/web/src/ui/components/admin/entity-form.tsx` | Form editor for entity YAML |
| `MetricsForm` | `packages/web/src/ui/components/admin/metrics-form.tsx` | Form editor for metrics YAML |
| `GlossaryForm` | `packages/web/src/ui/components/admin/glossary-form.tsx` | Form editor for glossary YAML |
| `CatalogForm` | `packages/web/src/ui/components/admin/catalog-form.tsx` | Form editor for catalog YAML |
| `YamlEditor` | `packages/web/src/ui/components/admin/yaml-editor.tsx` | Monaco wrapper for raw YAML editing |
| `DimensionTable` | `packages/web/src/ui/components/admin/dimension-table.tsx` | Editable dimension table |
| `CreateEntityDialog` | `packages/web/src/ui/components/admin/create-entity-dialog.tsx` | New entity creation modal |
| `DeleteConfirmation` | reuse existing | Already exists for conversations |

### Modified Components

| Component | Changes |
|-----------|---------|
| `/admin/semantic/page.tsx` | Add edit mode toggle, wire up save/create/delete |
| `SemanticFileTree` | Add "+ New" button, delete action, dirty indicators |
| `search-params.ts` | Add `mode` param: `parseAsStringLiteral(["browse", "edit"])` |

### Shared Libraries

| File | Description |
|------|-------------|
| `packages/api/src/lib/semantic-validation.ts` | Zod schemas for write validation (new) |
| `packages/web/src/ui/lib/yaml-utils.ts` | YAML serialize/deserialize helpers for form ↔ YAML conversion (new) |

---

## Security

### Path Traversal

All write endpoints reuse the existing `isValidEntityName()` check and resolved-path validation. The write path adds:

- File extension must be `.yml`
- Resolved path must be a child of `getSemanticRoot()`
- No symlink following (`fs.lstat` check before write)

### Authorization

- All endpoints require `admin` role (existing `adminAuthPreamble()`)
- Audit log captures every write with user identity

### Input Sanitization

- YAML is parsed and re-serialized via `yaml` (comment-preserving) before writing — prevents YAML injection attacks (anchors, aliases, tags)
- No raw user input reaches the filesystem path — entity names are validated against `/^[a-zA-Z0-9_-]+$/`

### Deployment Constraints

| Environment | Write support | Notes |
|-------------|---------------|-------|
| Self-hosted (Docker/Railway) | Yes | Writes to local filesystem |
| Vercel | No | Read-only filesystem. Return `501 Not Implemented` with message directing users to edit files in their repo |
| Sidecar | N/A | Sidecar only handles explore commands |

Detection: Check `process.env.ATLAS_RUNTIME === "vercel"` or attempt a write to a temp file in the semantic root on startup.

---

## Implementation Plan

### Phase 1: API + Raw YAML Editor
1. Add `semantic-validation.ts` with Zod write schemas
2. Add PUT/POST/DELETE routes for entities, metrics, glossary, catalog
3. Add ETag-based optimistic locking
4. Add `YamlEditor` component (Monaco, dynamic import)
5. Wire edit mode toggle on `/admin/semantic` page
6. Raw YAML editing with save/discard

This gives power users full editing capability with validation guardrails.

### Phase 2: Form Editor
7. Build `EntityForm` with all sections (dimensions, measures, joins, etc.)
8. Build `MetricsForm` and `GlossaryForm`
9. Add form ↔ YAML conversion utilities
10. Add inline validation feedback (red borders, error messages)
11. Build `CreateEntityDialog` for new entity/metric creation

### Phase 3: Polish
12. Add delete flow with confirmation
13. Unsaved changes detection (dirty state, beforeunload)
14. File tree enhancements (dirty indicators, context menu)
15. Audit log entries for all write operations

---

## Alternatives Considered

### DB-backed semantic layer
Store YAML in the internal Postgres instead of the filesystem. Would solve the Vercel read-only problem but adds complexity (migration, sync with file-based workflows, breaks `atlas init` and `atlas diff`). Deferred — can layer this on later without changing the API contract.

### Git integration (commit-on-save)
Every edit creates a git commit. Enables history, rollback, PR-based review. Adds significant complexity (git operations from the API process, auth for push, merge conflicts). Better suited as a Phase 3+ feature. The ETag-based locking is a simpler first step.

### Separate editor app
Build the editor as a standalone tool (VS Code extension, CLI TUI). Fragments the admin experience and requires separate deployment. The admin console is already the right home.

### Live bidirectional form ↔ YAML sync
Keep form and YAML views in perfect sync as the user types. Complex to implement correctly (partial YAML parse errors, cursor position preservation, comment stripping). The tab-switch approach is simpler and avoids a class of bugs.

---

## Resolved Questions

1. **Comment preservation** — Use the `yaml` npm package (not `js-yaml`) to preserve YAML comments through parse/serialize round-trips. Users who hand-edit YAML with comments should not lose them when saving through the form editor.

2. **Catalog auto-update** — Yes. When creating or deleting an entity, auto-update `catalog.yml` to add/remove the entity reference. Keeps catalog consistent with the filesystem without manual effort.

3. **Validation strictness** — Minimal validation: require `table` + at least one dimension. All other fields (`sample_values`, `use_cases`, `query_patterns`, etc.) are optional. Let users add richness incrementally. Show tips/hints above the editor to guide users toward richer entity definitions without enforcing them.

4. **Multi-source UX** — Yes, the create dialog should let users pick a source (which determines the target directory). Don't silently default to `entities/` — make the multi-source structure visible.

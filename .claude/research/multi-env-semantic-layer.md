# Multi-environment semantic layer + connection-scoped content

**Status:** audit (complete) · **Date:** 2026-05-11 · **Spawned by:** [#2329](https://github.com/AtlasDevHQ/atlas/issues/2329) (closed) · **PRD:** [#2336](https://github.com/AtlasDevHQ/atlas/issues/2336) · **Milestone candidate:** 1.6.x

## Context

An org with N connections pointing at the same logical schema (e.g. us-int + eu + apac Postgres copies) ends up with N copies of every connection-scoped row in Atlas's internal DB. Discovered dogfooding: my own Atlas workspace has 3 regional Postgres connections → 3 entries for every YAML entity / metric, 3 PII classifications, 3 dashboard cards.

This audit maps the surface of the problem and sketches three model options to inform a PRD interview. **No implementation.** No vocabulary lock-in.

---

## Table audit

Six internal-DB tables carry `connection_id` today. Verified via grep on `packages/api/src/lib/db/schema.ts` and `packages/api/src/lib/db/migrations/*.sql`.

| Table | `connection_id` shape | Unique key including it | Mode system? | Source |
|---|---|---|---|---|
| `semantic_entities` | nullable (NULL = "all connections") | `(org_id, entity_type, name, COALESCE(connection_id, '__default__'))` × 3 partial indexes per status | **Yes** (draft / published / archived / draft_delete) | `schema.ts:388` |
| `dashboard_cards` | nullable | none | No | `schema.ts:1495` |
| `conversations` | nullable | none | No | `schema.ts:88` |
| `scheduled_tasks` | nullable | none | No | `schema.ts:218` |
| `approval_queue` | NOT NULL, default `"default"` | none (status column is for approval workflow, not content mode) | No | `schema.ts:933` |
| `pii_column_classifications` | NOT NULL, default `"default"` | `UNIQUE(org_id, table_name, column_name, connection_id)` | No | `schema.ts:1118` |

### Stragglers — none

The issue flagged `prompts`, `starter_prompts`, `learned_patterns`, `saved_queries`, `reports`, `dashboards` as "likely also affected." **They are not.** None of these tables carry `connection_id`. `prompt_collections` and `query_suggestions` (starter prompts) participate in the content-mode system but are connection-agnostic — they live above the connection layer. `dashboards` (parent of `dashboard_cards`) has no `connection_id`; the FK lives on the child card.

This is a smaller blast radius than the issue feared. Six tables, not twelve.

### Migration 0028 — what actually happened

The issue cites `0028_fix_semantic_entity_uniqueness.sql` as evidence that `connection_id` in the natural key caused the us+apac boot crash. The migration header tells a slightly different story:

> 0024/0025 indexed `(org_id, name, connection_id)` filtered by status — but the original uniqueness key was `(org_id, entity_type, name)`. 'accounts' exists as both an `entity_type='entity'` row AND an `entity_type='metric'` row for the same org + connection, so the 0024/0025 indexes rejected perfectly legitimate data.

The proximate bug was **missing `entity_type`** from the partial indexes, not `connection_id`. The fix preserved `COALESCE(connection_id, '__default__')` — i.e. it doubled down on connection-scoping as the natural key. So 0028 is not directly an indictment of `connection_id` in the key; it is, however, evidence that the connection-scoped uniqueness model is **fragile under schema evolution** and has already cost two prod regions a boot.

The deeper point the issue is making still stands: if `connection_id` weren't in the natural key, 0028 wouldn't have needed to be that complicated.

### Consumer surface

Synthesizing the consumer-audit findings (`packages/api/src/lib/semantic/entities.ts`, `packages/api/src/lib/dashboards.ts`, `packages/api/src/lib/scheduled-tasks.ts`, `packages/api/src/api/routes/admin-publish.ts`, `packages/web/src/ui/components/admin/entity-list.tsx`, etc.):

**Call-site density** (refactor cost ordering, descending):

1. **`semantic_entities`** — ~15 sites. List/get/upsert/tombstone/publish/whitelist all branch on `connection_id`. The whitelist (`packages/api/src/lib/semantic/whitelist.ts`) keys queryable tables off entity rows, so connection scoping flows into the SQL validation path.
2. **`scheduled_tasks`** — ~10 sites. Full CRUD + scheduler engine + form UI.
3. **`dashboard_cards`** — ~8 sites. Insert/list/render; `connectionId` is set once and not editable.
4. **`conversations`** — ~6 sites. Set at conversation creation; flows into agent execution.
5. **`approval_queue`** — ~3 sites. Metadata only; not used as a filter dimension.
6. **`pii_column_classifications`** — 1–2 sites. EE-only scanning.

**Wire-format exposure** (would force `@useatlas/types` major bump if `connectionId` shape changes):

- `semantic_entities` → `GET /api/v1/admin/semantic/org/entities`, `GET /api/v1/admin/semantic/entities/{name}`, `PUT /api/v1/admin/semantic/entities/edit/{name}`
- `dashboard_cards` → `GET /api/v1/admin/dashboards/{id}`, `GET /api/v1/dashboards/{id}`, `POST /api/v1/admin/dashboards/{id}/cards`
- `scheduled_tasks` → `GET /api/v1/admin/scheduled-tasks`, `POST /api/v1/admin/scheduled-tasks`
- `conversations` → `GET /api/v1/conversations`, `GET /api/v1/conversations/{id}`
- `approval_queue` → likely in admin approvals list
- `pii_column_classifications` → internal-only

**No shared helper.** Each table module reimplements its own `(orgId, connectionId)` filtering inline. There is no `findByConnection()` util to refactor centrally — a model change touches 5–6 modules independently. This is itself a small architecture-wins finding (deepen modules around connection scoping), worth flagging in `architecture-wins.md`.

**Atomic publish endpoint** (`packages/api/src/api/routes/admin-publish.ts`) handles `semantic_entities` and `connections` in a single transaction. Phase 4 cascades archive: when a connection is archived, all `semantic_entities` rows with matching `connection_id` flip to `status='archived'`. `dashboard_cards`, `scheduled_tasks`, `approval_queue` are **not** in the publish flow — they live outside the mode system today.

This is the load-bearing constraint for any redesign: whatever we pick must extend the publish transaction cleanly, or the draft-publish UX falls apart.

---

## Model options

### Option A — Connection groups

**Sketch:** Add a `connection_groups` table. Each connection belongs to zero or one group. Content rows reference `connection_group_id` instead of `connection_id`. A group with three members (us / eu / apac) shares one row per entity; the agent picks a member at execution time.

**Schema delta:**
- New table: `connection_groups (id, org_id, name, created_at)`
- New column on `connections`: `group_id text references connection_groups(id)`
- Rename `connection_id` → `connection_group_id` on the 6 tables (or keep both during transition, see migration below)

**Mode-system fit:** Clean. The publish transaction already operates on `(org_id, entity_type, name, connection_id)`; substituting `connection_group_id` is a one-line change in the partial indexes and the publish promote step. Draft promotion is per-group, which matches what a multi-region admin actually wants ("publish this metric change to all my prod regions at once").

**Query-routing UX:** Conversation picks a group default at creation; agent executes against one group member (default = first, or "last used"). Override available per turn via the connection picker. Federation (run on all members and merge) is a separate problem — explicitly punt.

**Customer mental model:** "Three connections in the *prod* group share semantic content." Closest to how operators already think about replicas. Vocabulary candidates: *group*, *fleet*, *replica set*.

**Migration cost: M.**
- Schema: add table + nullable `connection_group_id` columns; backfill by creating a one-member group per connection (1:1 default).
- Code: 5–6 modules touch `connection_id` directly; renaming is mechanical but every read site needs review.
- Wire format: `connectionId` → `connectionGroupId` on response shapes. Breaking. Could be deferred with a transitional alias.

**Limits:** All-or-nothing grouping. If EU+APAC share a schema but US is different, the operator must split into two groups — which is correct, but it does mean group membership is a hard partition, not a fuzzy match.

---

### Option B — Template + environments (dbt-target / Terraform-workspace model)

**Sketch:** Promote entity definitions to org-scoped *templates*. Each connection is an "environment" of zero or more templates. Content lives on templates, not on `(org, connection)` pairs. The "default" case is one template per org with N environments per template.

**Schema delta:**
- New table: `entity_templates (id, org_id, entity_type, name, definition_yaml, status)` — replaces today's `semantic_entities` natural key.
- New table: `template_environments (template_id, connection_id, env_overrides_json)` — per-env override layer.
- Drop `connection_id` from `semantic_entities` body; the table effectively becomes the templates table.
- Same shape extends to `scheduled_tasks` (task templates with per-env enable/disable), `dashboard_cards` (card templates), `pii_column_classifications` (template tag, env-bound classification).

**Mode-system fit:** Templates carry `status`. Publish promotes templates atomically; environments inherit. This is **cleaner than today** — drafts are workspace-level, environments are downstream. The publish transaction simplifies (one row per logical entity, not N).

**Query-routing UX:** Conversation picks an environment at creation. Templates resolve at agent-call time by joining template → environment. Auto-detection via query content (e.g. "show me EU sales") is a future bolt-on, not core. UX picker stays in the chat header.

**Customer mental model:** Closest to industry vocabulary. dbt has `target`, Terraform has `workspace`, Vercel has `environment`. The "I know what this means" curve is shallowest here for any operator with infra experience. Frontline analysts may need onboarding ("an environment is a connection plus per-region tweaks").

**Migration cost: L.**
- Schema: largest refactor. Semantic entities lose their identity column; new table.
- Code: most consumer code reads entities-by-connection today. Switching to template-first read paths touches the agent loop, the whitelist, the admin editor, and the publish flow.
- Wire format: meaningful breaking changes. `Entity` → `EntityTemplate` + `EntityEnvironment`. `@useatlas/types` major bump unavoidable.
- The agent's entity-by-name resolution (`packages/api/src/lib/semantic/entities.ts:listEntityRows`) is currently the load-bearing read path; it changes shape entirely.

**Limits:** Largest blast radius. Highest ROI but pays it forward — once shipped, this is the *correct* model for any future multi-env feature (per-env feature flags, per-env access policy, per-env audit).

---

### Option C — Connection tags + tag-selector content

**Sketch:** Each connection carries a tag set (`region=us`, `schema=novamart-v3`, `tier=prod`, `tenant=acme`). Content rows target *tag selectors* (`tier=prod AND region IN (us, eu)`) instead of a connection ID. At read time, a connection matches a row if its tags satisfy the selector.

**Schema delta:**
- New table: `connection_tags (connection_id, key, value)` — many-to-many.
- New column on the 6 tables: `tag_selector_json` (or a normalized `content_tag_selectors` join table for indexability).
- Drop `connection_id` from the 6 tables.

**Mode-system fit:** Awkward. Publish promotes drafts whose selectors may match different connection sets than the published version, so the "what changed" view fragments. The atomic publish transaction has to recompute selector→connection resolution on every promote — solvable, but introduces a new class of bugs (selector drift between draft and published).

**Query-routing UX:** Conversation picks a connection at creation (unchanged); the engine resolves which entity rows apply based on that connection's tag set. Federation could lean on tag selectors naturally ("run this on every connection where `tier=prod`"). Most flexible long-term.

**Customer mental model:** Highest cognitive cost. "An entity exists wherever its tag selector matches" is correct but abstract. Operators have to maintain *both* connection tags *and* content selectors and keep them in sync. Closest analogue is Kubernetes label selectors — powerful but a known UX trap.

**Migration cost: L.**
- Schema: largest data-model change. Tag tables + selector storage + new query patterns.
- Code: every read path that currently filters by `connection_id` becomes a selector-resolution call. Indexing is harder (selectors don't map to btree indexes naturally — likely need a materialized resolution table for performance).
- Wire format: every list endpoint exposes selectors instead of `connectionId`. Breaking. Plus new endpoints to manage tags.
- Performance risk: list queries become joins-over-selectors. Easy to introduce N+1 reads.

**Limits:** Most flexible (partial overlaps, transient groupings, ad-hoc tenant slicing). Most overhead. Best for a future where Atlas serves real multi-tenant SaaS with hundreds of connection partitions; overkill for the multi-region operator dogfood case.

---

## Recommendation

**Primary: Option A — Connection groups.** Smallest migration cost, mechanically obvious to operators, extends publish cleanly. Solves the dogfood case (us-int + eu + apac sharing semantic layer) on day one. The "all-or-nothing partition" limitation is real but not blocking — operators can split groups when their fleet diverges.

The 1:1 backfill (one group per existing connection) is the lowest-risk path: existing single-connection orgs see zero behavior change; multi-region orgs do one explicit "merge these into a group" action.

**Fallback: Option B — Template + environments.** If the PRD interview surfaces requirements that Option A can't model (per-env overrides on entity definitions, per-env feature flags, per-env access policy), the template model is the correct answer. Higher cost but compounds — once we have templates, every future "per-env X" feature is free.

**Reject for now: Option C — Tag selectors.** Right model for a multi-tenant SaaS partition story (10s–100s of tenant connections per org). Wrong tool for the current dogfood pain. Revisit when Atlas-as-tenant-isolation enters the roadmap (probably 2.x).

The decision tree: *Are there cases where one connection's entity definition should differ from another in the same group?* If no → A. If yes → B. If the answer is also "and we want fluid grouping that changes per-row" → C.

---

## Open questions for the PRD interview

1. **Override granularity.** In a multi-region setup, do *any* entity definitions actually differ per region, or is it 100% identical schemas? If 100% identical, Option A is sufficient forever; if even one column differs per region, Option B becomes necessary.
2. **Group membership stability.** Are connection groups stable (set once at connection creation, rarely changed) or fluid (operators routinely re-shuffle)? Stable → A wins. Fluid → consider B or C.
3. **Per-env scheduled tasks.** Should a scheduled task run on all members of a group (federation), one chosen member, or be replicated per env with separate cron schedules? This shapes whether `scheduled_tasks` participates in the group model or stays per-connection.
4. **Dashboard card sharing.** Should a dashboard card show data from all group members (3 columns side-by-side), one chosen member, or pick at view time? Affects the `dashboard_cards` schema delta.
5. **Approval queue scope.** Should an approval be group-wide (one approval covers any group member running the query) or per-execution? Today's `approval_queue.connection_id NOT NULL` defaults to "default" — clearly already vestigial.
6. **PII classification scope.** Is a column's PII tag the *same* across all group members (likely yes — same schema), or per-member? Affects whether the unique index becomes `(org_id, table_name, column_name, group_id)` or stays per-connection.
7. **Publish atomicity across groups.** If an admin drafts a change to an entity used by two different groups, is that one row or two? Today the natural key disambiguates by `connection_id`; with groups it's `group_id`. Forces a clear definition of "what is the unit of publish."
8. **Wire-format break window.** Is this acceptable as a `@useatlas/types` major bump, or do we need to ship a transitional alias for a deprecation cycle? SDK consumers (`@useatlas/sdk`, `@useatlas/react`, embedded chat) all carry `connectionId` in their shapes.
9. **Conversation-picks-member UX.** When a conversation belongs to a group, how is the executing member chosen? Last-used? Explicit picker? Default-member-on-group? Affects the `conversations.connection_id` column's future.
10. **Vocabulary lock-in.** *Group* / *environment* / *target* / *workspace* / *fleet* — picking before the PRD risks anchoring. But the lazy answer ("connection group") may also be the right one; mirror the option name unless interview surfaces a better one.

---

## Out of scope

- Implementation. PRD comes next.
- Vocabulary lock-in (env / target / group / workspace).
- Cross-region query federation — separate problem, touches data residency, defer until the model exists.
- Sandbox / sidecar interaction — connections only, no agent-tool changes.
- ee/ vs core split — the model lives in `packages/api`; ee may add a UI flourish (group-level access policy) but the schema is core.

## Followups

- Architecture-wins entry: connection-scoped query helpers are duplicated across 5–6 modules. Worth deepening with a `withConnectionScope(orgId, connectionId)` helper independent of the multi-env decision.
- ROADMAP candidate slot: 1.6.x ("Multi-env semantic layer"). Not a 1.4.2 / 1.4.3 / 1.5.0 item — too large, not blocking the proactive-chat narrative.

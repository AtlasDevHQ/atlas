# Semantic Layer Onboarding — "add a database → a semantic layer that just works"

> Design doc for the end-to-end experience of generating a semantic layer when a database is added to Atlas. Covers both the *generation* friction (mechanical baseline → rich layer) and the *multi-DB legibility* friction ("which entities belong to which database"). Companion to [semantic-expert-agent.md](./semantic-expert-agent.md), which owns the **post-onboarding maintenance** layer.

## Problem

Generating the semantic layer for a newly-added database is the main source of onboarding friction. Two distinct pains:

1. **Generation is work, and the first artifact is shallow.** `atlas init` profiles the DB and writes a *mechanical* baseline (column names as descriptions, template query patterns). LLM enrichment exists but is an optional, CLI-only afterthought (`packages/cli/bin/enrich.ts`). The product literally tells you to drop to a terminal: `/admin/semantic`'s empty states say "Run `atlas init`", and the web wizard's generated output is mechanical. So "just works" doesn't — you get a blank-ish layer and a homework assignment.

2. **Once there's more than one database, you can't tell which is which.** The data model already scopes every entity to a **Connection group** (`semantic_entities` natural key `(org_id, entity_type, name, connection_group_id)`, #2340/#2412), but the **surface** doesn't make it legible: the file layout is flat, the YAML field is the misleadingly-named `connection:`, and the `/admin/semantic` view shows group only as a per-row *badge* on one flat list. "Good for one DB, hard to know which is for which."

A third, subtler pain ties them together: **there's no in-product road to generation after the one-time onboarding wizard.** The wizard (`/wizard`) is a first-run gate with "Skip for now → /". Adding a connection in `/admin/connections` offers no path to build its semantic layer. So the "newly added DB" — whether it's your **5th** or your **1st after skipping signup** — dead-ends at the CLI.

### What exists today (corrected map)

| Component | What it does | Gap |
|-----------|-------------|-----|
| `atlas init` (CLI) | Profiles DB → mechanical YAML; optional `--enrich` LLM pass | Enrichment optional + CLI-only; mechanical by default |
| `packages/api/src/api/routes/wizard.ts` | **Server-side** `profile → generate → preview → save`; wired to `/wizard` web UI | Mechanical only (no LLM); scopes by `connectionId`, **not group**; one-time onboarding gate |
| `packages/cli/bin/enrich.ts` | LLM enrichment of descriptions / use_cases / query_patterns / glossary | CLI-only; not reachable from the API/web |
| `semantic/` file layout | Flat `entities/*.yml`; per-source subdir + `connection:` field both half-supported (`whitelist.ts`) | Flat = N DBs interleave indistinguishably on disk |
| `/admin/semantic` view | File tree keyed on `(name, connectionGroupId)`, group shown as a **badge** | Badge on a flat list ≠ grouped; not legible at a glance |
| `/admin/connections` | Add/manage SQL connections + connection groups | **No** path to generate a semantic layer for a new connection |
| `atlas diff` | Reports schema drift | Reports, doesn't fix → maintenance, see expert agent |

## Design

The whole design reduces to **one principle**:

> There is **one** generalized "generate the semantic layer for group *G*" flow. The onboarding wizard, an inline prompt after adding a connection, and a per-group empty state are all just *entry points* into it — identical whether *G* is the 1st database (added after skipping signup) or the Nth.

### A. Scope unit & vocabulary

Entities bind to a **Connection group** — a standalone DB is simply a group-of-one; multi-region **Members** share a schema, so they share one set of entities. This is already what the DB enforces; we make the surface honest.

- The unit is surfaced as **`group`** everywhere: YAML `group:`, the view's grouping, the CLI's target.
- The three historical aliases — the YAML `connection:` field, the CLI `--source` flag, the admin/API `source` — are **deprecated and unified** to `group`. (See [CONTEXT.md § Semantic layer scoping](../../CONTEXT.md) and [ADR-0012](../adr/0012-group-scoped-semantic-layer-directories.md).)

### B. On-disk representation (self-host / file-based)

Per-group directories make "which is for which" legible in git and the file tree:

```
semantic/                       # the DEFAULT group (single DB) stays flat
  catalog.yml  glossary.yml
  entities/orders.yml …
  metrics/…

semantic/                       # multi-DB
  catalog.yml  …                # default group (NULL connection_group_id)
  entities/…
  groups/
    warehouse/                  # group "warehouse" (Snowflake)
      catalog.yml  glossary.yml
      entities/  metrics/
    crm/                        # group "crm" (Salesforce)
      catalog.yml  …
```

- The loader infers the group from the directory (`semantic/groups/<group>/…` → group `<group>`); an in-file `group:` field is an **optional override**, not a co-equal second source of truth.
- The **default group stays flat at the root** (`semantic/entities/…`, `connection_group_id = NULL`), so single-DB users see zero added nesting.
- This formalizes (and renames) the existing-but-unblessed `semantic/<source>/entities/` inference in `whitelist.ts` into the dedicated `groups/` namespace. Legacy `semantic/<source>/` layouts need a one-time migration (see ADR-0012 Consequences).
- **All four artifact types — entities, metrics, glossary, catalog — share one layout-aware traversal** (`getGroupDirs` in `lib/semantic/scanner.ts`, #3240). A non-default group's `groups/<group>/metrics/*.yml`, `groups/<group>/glossary.yml`, and `groups/<group>/catalog.yml` are discovered and attributed to `<group>` on every read path (admin discovery, the agent's lookup helpers, and the boot-time search index). `groups/` is a reserved namespace, so nothing is ever attributed to a source literally named "groups". The admin catalog endpoint remains the global root view (catalog is unscoped in the admin/DB model); group catalogs surface as `use_for` hints in the agent's semantic index.

In SaaS (DB-backed), the group is `connection_group_id` on the entity row — no files; the same grouping drives the view.

### C. View (legibility)

`/admin/semantic` upgrades from a flat list with per-row group **badges** to a **grouped tree** keyed by Connection group, mirroring the disk layout 1:1:

```
catalog.yml                       # global — see scoping note below
glossary.yml                      # global
▾ default  · Postgres · 1 member
    orders.yml   customers.yml   payments.yml
▾ crm  · Salesforce · 1 member
    leads.yml   accounts.yml
▾ warehouse  · Snowflake · 2 members
    events.yml   sessions.yml
▾ metrics
    revenue.yml   sessions_per_day.yml
```

(The metrics tree node lists plain file names; the group is shown as a badge on the metric **card** in the right-hand viewer, not on the tree node.)

*As implemented (#3235):*

- **Entities** render under collapsible Connection-group sections in `SemanticFileTree`, replacing the per-row environment badge. Each section header carries the group's **datasource type + member count**, joined in from the admin connections list (`/api/v1/admin/connections` → `groupId`/`groupName`/`dbType`) — the semantic entities endpoint only carries the group id (`connectionId`), not the datasource type. The default group sorts first, then groups by label.
- **Single-DB** (only the default / `null` group) renders the **flat** `entities` folder with no group chrome — the standalone-DB case sees zero added nesting. The grouped layout engages the moment any non-default group has entities.
- **Graceful degrade:** which groups render is driven by the entities themselves, so a group with no matching connection row (e.g. a file-based `groups/<group>/` with no configured connection) still renders — just labeled by its id, with no datasource/member suffix. A failed connections fetch is non-fatal for the same reason.
- **Scoping of the other artifacts** (preserving current semantics): **catalog** is global in the admin/DB model (the admin endpoint serves only the root `catalog.yml`; group catalogs feed the agent index per §B), so it stays at the tree root. **glossary** is likewise surfaced as a single combined root node today. **metrics** carry their group as `source` (`"default"` for the flat root, the group name for `groups/<group>/metrics/<id>.yml`); the Metrics viewer tags each non-default metric card with its group so group-scoped metrics read legibly while the metrics folder stays a single list.
- **#3276 (folded in):** the Metrics normalizer (`normalize-metrics.ts`) now unwraps **single-object** metric files (`{ id|name|label, sql }`) in addition to the array and `{ metrics: [...] }` forms. The single-object shape is the common generated `groups/<group>/metrics/<id>.yml` output; it was previously discovered by the backend but silently dropped by the UI.

### D. Generation — two explicit phases with a cost gate

The single most important UX decision: **generation is two phases, and the LLM never fires by accident.**

**Phase 1 — Mechanical baseline (no LLM, auto, free, instant).**
The profiler grabs names, types, sample values, cardinality, PKs/FKs → a complete YAML "template" for every (non-ignored) table. This runs automatically and is, on its own, a **usable, queryable** semantic layer. Nothing about Phase 1 costs money or waits on a model.

**Phase 2 — Enrichment (explicit, granular, cost-controlled, streamed).**
An LLM round-trip that receives the table profile **and read-only access to the DB** (so it can check distributions/samples to ground its output). It is **never auto-triggered** — no "big expensive LLM call by mistake." Controls:

- **Enrich all** — one deliberate action; shows a scale/cost confirmation first (e.g. "Enrich 24 tables?") so the spend is never a surprise.
- **Enrich selected** — a per-table selector to enrich only the tables you care about.
- **Ignore** — exclude tables you don't need (dead/legacy, junction, cache). The list is **pre-seeded** from the profiler's `table_flags.possibly_abandoned` signal (the profiler already flags these — see `catalog.yml`'s "4 legacy/abandoned tables" note), so you confirm rather than hunt.

Enrichment results **stream in per table**, upgrading each row in place. Because enrichment is structured per-table, the engine can start blocking-with-progress and gain true streaming later without rework.

> Why gen-time enrichment and not the expert agent here: the expert agent's edge is **data-distribution analysis** and **audit-log corroboration** ("this join appears in 47 queries"). A *newly-added* DB has an **empty audit log** — that edge doesn't exist yet at onboarding. At the moment of adding a DB, all that exists is schema + samples + cardinality, which is exactly what gen-time enrichment consumes. The expert agent earns its keep *after* there's query history.

### E. Entry points — one flow, many doors

All three doors call the same group-scoped generation flow (Phase 1 → optional Phase 2 → preview → save-to-group):

1. **Inline-on-add (push).** Adding a SQL connection that forms a **new** group offers "Generate semantic layer for *G*?" inline in `/admin/connections`. Adding a **member to an already-populated group** (e.g. `eu-prod` into `prod`) does **not** re-prompt — that group already has its schema.
2. **Per-group empty state (pull).** `/admin/semantic`, viewed for a group with no entities, shows "No semantic layer yet — **Generate**" *instead of* "run `atlas init`". Always-available way back in.
3. **Onboarding wizard (now just a caller).** The first-run `/wizard` becomes one caller of the shared flow rather than a special gate. Skipping it therefore costs nothing — you pick the same thread up later via (1) or (2).

This is what makes the flow **DB-count-agnostic**: the 1st-DB-after-skip and the Nth-DB are the same code path.

### F. Shared engine (CLI ↔ web parity)

Today the generator runs in two places and enrichment in a third (CLI-only). Consolidate:

- Move the mechanical generator + the enrichment logic out of `packages/cli/bin/enrich.ts` into shared **`packages/api/src/lib/semantic/…`** (respecting CLAUDE.md: `lib/` sits above `api/routes/`; `lib/` must not import from `api/routes/`).
- Both front-ends call the same engine: the `wizard.ts` routes (web) and `atlas init` / a new enrich surface (CLI). One behavior, two doors — no drift between "what the CLI produces" and "what the wizard produces."
- Fix `wizard.ts` to scope by **group**, not `connectionId` (`wizard.ts:565`).

### G. Relationship to the Semantic Expert Agent

[semantic-expert-agent.md](./semantic-expert-agent.md) (`atlas improve`, #1180) is repositioned as the **post-onboarding maintenance layer** — drift correction, query-history-driven deepening, validated proposals via test queries — explicitly *out* of the onboarding flow. Onboarding gets you to a rich-enough layer with one deliberate enrichment pass; the expert agent keeps it rich as the schema and the query history evolve. The two share tooling (DB-read access during enrichment is a subset of the expert agent's `profileTable`/`checkDataDistribution`), but they are different moments in the lifecycle.

## Out of scope / open questions

- **Drift re-sync after onboarding.** When the DB schema changes later, `atlas diff` + the expert agent own re-sync. Not part of the add-a-DB flow.
- **Cost-confirmation precision.** "Enrich all" should show *some* scale signal before spending; whether that's a table count, a token estimate, or a dollar estimate is a follow-up (token estimates require a tokenizer pass over the profile).
- **Enrichment concurrency.** Per-table enrichment can run in parallel; the degree (and rate-limit handling) is an implementation detail for the engine.
- **Preview step.** The wizard's existing `/preview` ("preview agent behavior with generated entities") is retained as the "see it work before you save" beat; its exact placement relative to enrichment (preview baseline vs preview enriched) is a UI detail.
- **REST datasources.** This doc is about SQL Datasources and their entity YAMLs. REST datasources (`openapi-generic`) have their own representation; not covered here.

## Build sequence (for `/to-issues`)

Tracer-bullet slices, roughly in dependency order:

1. **Engine extraction** — move generator + enrichment into `packages/api/src/lib/semantic/`; CLI + wizard call it.
2. **Group-scoped layout + loader** — `semantic/groups/<group>/` convention, dir-inference + `group:` override, legacy-layout migration (ADR-0012).
3. **`wizard.ts` group scoping** — replace `connectionId` scoping with group; save into the group's namespace.
4. **Two-phase generate UI** — mechanical baseline auto + Enrich all / select / ignore (pre-seeded) + streamed results.
5. **Grouped-tree view** — `/admin/semantic` grouped by Connection group with datasource-type/member labels.
6. **Entry points** — inline-on-add prompt in `/admin/connections` (new-group trigger) + per-group "Generate" empty state replacing "run `atlas init`".
</content>
</invoke>

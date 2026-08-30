# Semantic layer scoping

> **One of Atlas's bounded contexts.** The map is [CONTEXT-MAP.md](../../../CONTEXT-MAP.md);
> system-wide decisions stay in [docs/adr/](../../adr/). Extracted from the root
> [CONTEXT.md](../../../CONTEXT.md) on 2026-08-30 ([#5302](https://github.com/AtlasDevHQ/atlas/issues/5302)):
> the prose below is that file's `## Semantic layer scoping` section, moved unchanged except that
> relative links are repathed for the new depth. It is no longer in the root file.
> Vocabulary rules for consumers: [docs/agents/domain.md](../../agents/domain.md).


The semantic layer (entity YAMLs, glossary, metrics) describes the schema of a **Connection group**, not of an individual **Member** or **Datasource**. Members within a group are interchangeable and share a schema, so they share one set of entities; a standalone Datasource is simply a group-of-one. An entity therefore binds to exactly one Connection group.

- **Entity group scope** — the Connection group an entity describes; the unit behind "which entities belong to which database." Surfaced as the entity's **group** (YAML `group:`, the view's grouping, the CLI's target). A NULL/absent scope is the **default group** — the single-database case where the "which is for which" question doesn't arise, and the layout collapses to flat `semantic/entities/*.yml`.
  _Avoid_: scoping entities to a Member or an individual Datasource — members share a schema, so the binding is to the group, never to one connection.

### Flagged ambiguities

- "source" / `connection:` / `--source` — historically the entity-group scope wore three different names: the YAML `connection:` field, the CLI `--source` flag, and the admin/API `source` (computed as the group id, defaulting to `"default"`). All three denote the **Connection group**. Canonical surface term: **group**; the aliases are deprecated and being unified.

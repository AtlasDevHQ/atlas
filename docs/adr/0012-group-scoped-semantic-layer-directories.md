# ADR-0012: Semantic layer is Connection-group-scoped, represented as per-group directories

**Status:** Proposed
**Date:** 2026-06-05
**Builds on:** #2340 / #2412 (multi-environment semantic layer — `semantic_entities.connection_group_id`), [ADR-0011](./0011-unified-conversation-scope.md) (Connection group as the SQL-routing unit)
**Design:** [docs/design/semantic-onboarding.md](../design/semantic-onboarding.md)
**Glossary:** [CONTEXT.md § Semantic layer scoping](../../CONTEXT.md)

## Context

The data model already scopes every entity to a **Connection group** (the `semantic_entities` natural key includes `connection_group_id`, #2340/#2412). But the *surface* never committed to that unit, so the same concept wears three different names and two half-built file representations:

| Layer | Name | Value |
|-------|------|-------|
| DB schema | `connection_group_id` | the real scope key |
| Entity YAML | `connection:` field | a free-string "hint, distinct from the DB row's group scope" (`admin-source.ts:89`) |
| CLI | `--source` (legacy) / `--connection` | overloaded; `--source` writes `connection: <x>` **and** a `semantic/<x>/entities/` subdir |
| Admin API | `source` | computed as `connection_group_id ?? "default"` |

On disk, `whitelist.ts` partitions entities by a "connection id" inferred from **either** an explicit `connection:` field **or** a per-source subdirectory (`semantic/warehouse/entities/` → `warehouse`), with the field winning — two co-equal sources of truth, neither blessed. The default layout is flat (`semantic/entities/*.yml`), so a multi-DB workspace's entities interleave in one directory, distinguishable only by opening each file. The `/admin/semantic` view reflects this: group appears as a per-row *badge* on a flat list, not as a grouping.

This is the root of two onboarding pains: "which entities belong to which database" is illegible, and the generator has no single, honest notion of where a new DB's entities live.

## Decision

**1. The Connection group is the canonical semantic-layer scope unit, surfaced everywhere as `group`.** A standalone Datasource is a group-of-one (`connection_group_id = NULL` → the *default group*). Members within a group share a schema and therefore share one set of entities; entities never bind to an individual Member or Datasource.

**2. On disk, each non-default group is its own directory under a dedicated `groups/` namespace:**

```
semantic/                       # default group (NULL connection_group_id) — flat, unchanged
  catalog.yml  glossary.yml  entities/  metrics/
semantic/groups/<group>/        # one directory per non-default group
  catalog.yml  glossary.yml  entities/  metrics/
```

The loader infers the group from the directory; an in-file **`group:` field is an optional override**, not a co-equal second source of truth. The default group stays flat at the root so single-DB users see no extra nesting. The file `group` maps directly to the DB `connection_group_id`.

**3. The aliases `connection:` (YAML), `--source` (CLI), and `source` (admin/API) are deprecated and unified to `group`.** They continue to resolve for back-compat during migration but are no longer the canonical spelling.

## Consequences

- **Loader change + migration.** `whitelist.ts` group-inference moves from `semantic/<x>/entities/` to `semantic/groups/<x>/entities/`; the flat root remains the default group. Existing `semantic/<source>/entities/` layouts (legacy `--source` output) need a one-time migration into `semantic/groups/<source>/`, or a back-compat read path that recognizes both until migrated. The `connection:`-field path keeps working as the override.
- **Generator output path.** `atlas init` and the `wizard.ts` `/generate`+`/save` routes write into `semantic/groups/<group>/…` (or the flat root for the default group). `wizard.ts` must switch from `connectionId` scoping (`wizard.ts:565`) to group scoping.
- **View.** `/admin/semantic` renders a **grouped tree** keyed by Connection group instead of a flat list with badges; it mirrors the disk layout in file-based mode and `connection_group_id` rows in DB-backed (SaaS) mode.
- **Field winner reversed in spirit.** Today the in-file `connection:` field *wins* over the directory. Going forward the **directory is canonical** and `group:` is the override — so an entity sitting in `groups/warehouse/` with `group: crm` inside is a recognized foot-gun the loader should warn on, not silently honor backwards.
  - *As implemented (read side, #3232):* the reversal applies to the **canonical `groups/<group>/` namespace** — a disagreeing `group:`/`connection:` field there is logged (`log.warn`) and the directory wins. In the **flat default root** the field still *assigns* the group (the override path, and the back-compat `connection:` behavior). The **legacy `<source>/` layout retains its historical field-wins precedence** for back-compat until migrated into `groups/`, so upgrading changes no existing flat/legacy behavior. Precedence is centralized in `resolveEntityGroup()` (`semantic/scanner.ts`).
  - *Scope of #3232:* the read side ships **entities-only**. Group-scoped `metrics/`, `glossary.yml`, and `catalog.yml` discovery does **not** yet recognize the `groups/<group>/` namespace (the metric/glossary loaders skip the reserved `groups/` dir); tracked in #3240.
- **No DB migration.** SaaS already stores `connection_group_id`; this ADR aligns the *file/CLI/admin surface* to it. No schema change.
- **Docs.** CONTEXT.md gains the "Semantic layer scoping" section; the onboarding design doc depends on this layout.

## Alternatives considered

- **In-file `group:` field only, keep one flat `entities/` directory.** Rejected: it reproduces the exact illegibility we're fixing — N databases' tables interleave in one folder, git diffs mix groups, and the view must parse every file to reconstruct grouping. The on-disk layout would carry no information.
- **Keep both representations as co-equals (today's behavior, field wins).** Rejected: two sources of truth is the current bug. We keep the field only as an explicit override, with the directory canonical.
- **Per-Datasource / per-Member scoping instead of per-group.** Rejected: members in a group share a schema, so per-member scoping forces duplicate entities per member or breaks the group abstraction that SQL routing (ADR-0011) already depends on.
- **Reuse the legacy `semantic/<source>/` form (no `groups/` parent).** Rejected: a bare `semantic/<x>/` collides visually with `semantic/entities/`, `semantic/metrics/`, and the `.orgs`/`.history` dot-dirs. A dedicated `groups/` parent keeps the root unambiguous and the migration mechanical.
</content>

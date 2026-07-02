# OKF interop spike — mapping findings & recommendations

**Issue:** #4140 · **Date:** 2026-07-02 · **Status:** spike complete; productionization is a follow-up

Google's [Open Knowledge Format v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
(announced 2026-06-12) is a vendor-neutral bundle of markdown files with YAML
frontmatter for the metadata/context AI agents need. Same "the semantic layer
is a plain file" thesis as ours; the difference is stance: OKF is a
**descriptive interchange format** (only `type` required, prose-first),
Atlas's YAML is an **authoritative runtime** (pinned metric SQL runs verbatim,
`status: ambiguous` gates the agent, the table whitelist enforces
queryability). This spike prototyped both directions to measure how lossy the
mapping actually is. Verdict up front: **worth speaking; the mapping is
asymmetric** — export is easy and total, import is a useful but genuinely
lossy draft generator.

## What shipped in this spike

- `packages/api/src/lib/semantic/okf/` — pure mapping engine, both directions,
  operating on in-memory `{ path, content }` lists (no fs coupling — reusable
  by a future ingest pipeline, see #4182).
- `atlas okf import --bundle <dir>` / `atlas okf export --out <dir>` —
  file↔file CLI prototypes (`packages/cli/src/commands/okf.ts`).
- Tests incl. a GA4-shaped foreign-bundle fixture and a full round-trip
  assertion (`packages/api/src/lib/semantic/okf/__tests__/`).

## OKF in one paragraph (as verified against the spec + GA4 sample)

A bundle is a directory tree of markdown concept docs. Frontmatter: `type`
(required, free text — "BigQuery Table", "Reference", "Playbook"), plus
recommended `title`/`description`/`resource`/`tags`/`timestamp`; **unknown
keys are legal and consumers must preserve them** (this is load-bearing
below). Reserved filenames: `index.md` (navigation, no frontmatter except
root `okf_version`), `log.md` (history). Links are untyped edges; meaning
lives in surrounding prose. In the GA4 sample, tables carry a `# Schema`
bullet list (`- \`col\` (TYPE): description`; the launch blog uses a markdown
table instead), metrics and joins are `type: Reference` docs tagged
`metric`/`join` with a ```sql fence.

## Mapping table

### Import (OKF → Atlas draft)

| OKF | Atlas | Fidelity |
|---|---|---|
| table/view concept (`type` contains "table"/"view") | `entities/<stem>.yml` (`name` ← `title`, `description` ← frontmatter + `# Overview`) | clean |
| `# Schema` entries (bullet **and** table form) | `dimensions[]` with `sql: <name>`, types mapped onto `number/string/date/timestamp/boolean` | clean for scalars; **types coarsened** (INT64 and FLOAT both → `number`) |
| RECORD/STRUCT/ARRAY/JSON columns | **skipped**, reported | lossy — no scalar dimension equivalent |
| metric Reference (+```sql fence) | `metrics/okf-imported.yml` entry, **`okf.unverified_sql: true`** | lossy in *authority*: OKF metric SQL is illustrative prose (GA4's `new_user_count` SQL is a fragment with an explanatory comment, not runnable). Promoting it silently into pinned-metric status would be an integrity hole, so import never does |
| join Reference (```sql equality) | `joins[]` entry on the source entity when **both** sides resolve to imported tables | partial — GA4's own join spec uses prose aliases (`GA_EVENTS`, `ADS_CLICKS`), which don't resolve; reported as unmapped. Cardinality is never expressed |
| dataset concept | folded into `catalog.yml` description | clean (Atlas has no dataset object) |
| glossary-ish concepts (tag `glossary`/`term`) | `terms` map, always `status: defined` | OKF has no ambiguity concept |
| anything else (`Playbook`, `API Endpoint`, …) | reported unmapped | by design — but this is exactly the content a knowledge-connection store would want (#4182) |
| entity type / grain / measures / virtual dims / sample stats | not inferable from prose | left for the existing scan → enrich → edit flow |

Every import carries an `okf:` provenance block (source path, resource, tags,
timestamp) — legal because `EntityShape` is passthrough.

### Export (Atlas → OKF)

Total: every entity, metric, and glossary term becomes a conformant concept
doc with prose a foreign consumer can read (`# Schema` bullets, measures,
joins, example queries) plus navigation `index.md`s and root `okf_version`.
What foreign consumers **lose is semantics, not data**:

- **Table whitelist** — entity existence survives; runtime enforcement has no
  OKF equivalent. A consumer can see what's queryable, nothing stops it
  querying anything else.
- **Pinned-metric authority** — the SQL is in the doc, but to a non-Atlas
  consumer it's illustrative prose, not a contract.
- **Ambiguity gating** — `status: ambiguous` terms export with their
  possible mappings and an "Atlas asks the user" prose note; no consumer will
  actually ask.

## Round-trip fidelity — the central finding

**Prose alone does not round-trip.** Structured → prose → structured loses
types (coarsened), measures, virtual-dimension SQL, join cardinality, and all
profiler stats. **With an extension namespace it round-trips exactly:** the
exporter writes the full source object under the `atlas:` frontmatter key
(`atlas.entity` / `atlas.metric` / `atlas.term`+`entry`), which OKF v0.1
explicitly permits and requires consumers to preserve. Re-import restores
those objects verbatim — the round-trip test asserts deep equality, including
`status: ambiguous` gating and metric authority (no `unverified_sql` flag on
the native path).

So the two paths through the importer are:
1. **Atlas-produced bundle** → lossless restore from `atlas:` (identity).
2. **Foreign bundle (GA4 etc.)** → heuristic prose parse, deterministic, no
   LLM pass needed for the structural 80% (schema/descriptions/links);
   an LLM pass would only add value for inferring grain/measures/types from
   prose — exactly what the existing enrich step already is.

## Decisions & recommendations

1. **One-shot draft generator, not a maintained sync.** Import output is
   drafts for scan → enrich → edit; a sync would need identity/merge rules
   OKF can't express (it has no stable IDs beyond file paths). Re-run =
   re-import with `--force`.
2. **CLI surface: `atlas okf import|export`** subcommand group in the
   published `atlas` binary. Bare `import`/`migrate-import` were taken;
   file↔file means no tenant-DB access, so it doesn't belong in
   `atlas-operator` (ADR-0025/0026).
3. **Core, not plugin** — per triage decision on #4140; it targets the core
   semantic SSOT directly.
4. **Keep the `atlas:` extension namespace** as the compatibility contract.
   If productionized, document the key shapes; consider trimming
   `atlas.entity` duplication (frontmatter + prose carry the same info) if
   bundle size matters.
5. **No ADR yet.** The round-trip shape becomes load-bearing only if/when a
   consumer beyond our own importer depends on `atlas:` — write the ADR at
   productionization, cross-linking ADR-0012/0017/0025.
6. **Follow-up (#4182):** the importer's bundle-parsing seam is deliberately
   fs-free so an internally hosted per-workspace OKF document store
   ("knowledge connections") can reuse it; the unmapped concept kinds
   (playbooks, runbooks, API endpoints) that this importer rejects are that
   feature's payload.

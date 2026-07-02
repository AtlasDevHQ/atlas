# ADR-0028: Knowledge Base is a fourth pillar (hosted OKF collections)

**Status:** Accepted
**Date:** 2026-07-01
**Context milestone:** v0.0.40 — Knowledge Base Pillar (#81; shipped as tag `v0.0.40` — the milestone was titled v0.0.41 until the tag train overtook it)
**Depends on:** [ADR-0006](./0006-three-pillar-integration-taxonomy.md), [ADR-0007](./0007-unified-install-pipeline.md)
**Issues:** #4182 (design), #4140 (OKF interop spike, findings in [docs/research/okf-interop-spike.md](../research/okf-interop-spike.md))

## Context

Customers hold knowledge that informs data answers but isn't schema: business rules, runbooks, product definitions, deprecation notices. The OKF interop spike (#4140) made Atlas *speak* Google's [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) at the file boundary; #4182 makes Atlas *host* it — ingesting a customer's knowledge base per SaaS Workspace as first-class agent context.

Where does that live in the taxonomy? ADR-0006 established three mutually-exclusive pillars (Datasource / Chat Platform / Action Target), enforced by `plugin_catalog`'s pillar CHECK. A knowledge corpus is none of them: Atlas reads from it, but not tabular data via `executeSQL`; it is descriptive context only. Meanwhile the plugin SDK already carried a latent fourth kind — `PluginType` includes `"context"` with a `contextProvider` seam (used by `plugins/yaml-context`) — but that type predates the pillar taxonomy and has no pillar value, no admin surface, and no install lifecycle.

A second question rode along: what does "hosting OKF" mean for the documents themselves? OKF's design principles are *just markdown, just files, indexable by any search tool, the same file with no translation layer*. Any hosting design that rewrites documents (wrapping them in trust envelopes, transforming them into a proprietary at-rest shape) forfeits those properties and the portability story with them.

## Decision

**1. Knowledge Base is a fourth pillar.** Catalog rows of type `context`, pillar `knowledge`, admin surface `/admin/knowledge` (one-surface-per-pillar rule). Definition: *a third-party knowledge corpus Atlas ingests descriptive context from — never queried as data, never authoritative*. The moat boundary — the semantic layer (whitelist, pinned metrics, glossary gating) is the **sole authoritative** context surface; Knowledge Base content is **descriptive only** — is now a property of the taxonomy rather than a discipline any one implementation must maintain. Nothing in a knowledge document ever runs verbatim, extends the table whitelist, or gates the agent.

**2. Collection = Knowledge Base install = Atlas's hosted OKF bundle.** The knowledge pillar joins the *multi-instance* side of `workspace_plugins` (the datasource-pillar pattern: composite PK `(workspace_id, catalog_id, install_id)`, excluded from the `workspace_plugins_singleton` partial unique). Each install is a named **collection** (`install_id` is the slug): one hosted tree, one root `index.md`, independently searchable — one per product or corpus so the agent needn't wade through unrelated knowledge. Knowledge documents belong to exactly one collection; uploads upsert into the tree by path. Collections are **workspace-global, never group-scoped** — an entity describes a Connection group's *schema*; a knowledge document describes the *business*. Affinity ("this runbook concerns the EU replica") is a `tags` concern, not a structural FK.

**3. Atlas hosts OKF verbatim.** Document bodies are stored and mirrored byte-identical to what was reviewed; the only Atlas addition is provenance under the `atlas:` frontmatter extension key (collection, ingest time, source) — spec-legal (OKF requires consumers to preserve unknown keys) and the same namespace the spike established for export. The agent reads collections with the base tools it already has — the sandboxed explore tool (`ls`/`cat`/`grep`) over the per-org, per-mode mirror (`.orgs/{orgId}/modes/{mode}/knowledge/<collection>/…`, the `semantic/sync.ts` dual-write pattern generalized) — walking `index.md` hierarchies as OKF intends. No `readDocument` tool, no viewer, no translation layer. Exporting a collection back to a bundle is the tree itself.

**4. Injection hardening lives at the boundaries, not in the files.** Ingested third-party content is defended by: (a) the content-mode **draft→published review gate** — every ingest lands `draft`; a human saw the content before the non-admin agent path ever can; promotion happens only through the atomic publish endpoint (an "upload & publish" convenience runs that same endpoint in the same admin action; connector-synced content gets no such option and always queues for review); re-ingests that change a published document demote it to `draft`; (b) prompt framing — the explore tool description and system prompt declare the `knowledge/` subtree third-party descriptive content, never instructions, once; (c) structure — the read-only sandbox, and hard-boundary tests proving Knowledge Base content cannot reach the SQL whitelist, pinned metrics, or glossary gating.

**5. v0 lifecycle.** One built-in catalog row, `okf-upload`: an **explicit, degenerate form install** — no credentials, minimal `config_schema`; installing creates the collection, ingest is a separate admin act (bundle upload → the spike's fs-free parser → `knowledge_documents` + `knowledge_links` rows, frontmatter and links extracted at ingest, caps via the settings registry). Uninstall archives the collection's documents (content-mode `archived`), never hard-deletes. Notion/Confluence connectors (OAuth installs, `INTEGRATION_TABLES` credentials, Scheduler sync), `searchKnowledge` (frontmatter filter / Postgres FTS / 1-hop link-graph), and embeddings are deliberate follow-ups; v0 search is grep-native, per the format.

## Alternatives considered

### Shoehorn into the Datasource pillar (rejected)

`ConnectionRegistry` treats every `pillar = 'datasource'` install as a query-execution target; a Knowledge Base must never be one — that's the moat boundary. It would also put knowledge rows on `/admin/connections` under the wrong verb and force carve-outs at every site that filters on the pillar.

### Extend the semantic layer instead of a new pillar (rejected)

Blurs descriptive into authoritative. The semantic layer's value is precisely that everything in it is enforced (whitelist, pinned SQL, gating); mixing in unenforced third-party prose would make "is this authoritative?" a per-file question. Kept crisp by construction: separate pillar, separate tables, agent-visible as a separate subtree.

### Skip the catalog for v0 — plain tables + an upload endpoint (rejected)

v0's only ingest is a credential-less file upload, so the install machinery looks like ceremony. But it defers exactly the decision this ADR exists to make, and the Notion/Confluence follow-ups would retrofit lifecycle, credentials, and sync state onto an unregistered feature. The degenerate form install costs almost nothing and makes collections nameable from day one.

### A new "upload" install model (rejected)

The install-model enum is load-bearing across handler dispatch and admin UI. Static-bot is already documented as "a degenerate form-install"; an upload install is one step further along the same line. If connectors later reveal a real content-push pattern, name it when there's a second example.

### Per-file provenance envelopes baked into the mirror (rejected)

Wrapping mirrored documents in trust-boundary text breaks OKF's "same file, no translation layer" principle, invites delimiter-forgery (a document containing a fake end-of-envelope marker), and is theater next to the review gate — a determined injection mimics whatever framing wraps it. Provenance rides in `atlas:` frontmatter; trust posture rides in the tool/prompt framing and the review gate.

### Group-scoped knowledge documents (rejected)

The issue's "per-workspace group scoping (ADR-0012)" phrasing read two ways. Entities bind to Connection groups because members share a schema the entity describes; knowledge documents describe the business. ADR-0012 is reused for the *per-org mirror mechanics* only. A nullable group column is an easy additive migration if a real need emerges; unwinding a baked-in group FK is not.

## Consequences

- Migrations widen the `plugin_catalog` / `workspace_plugins` pillar CHECKs to admit `'knowledge'`; the knowledge pillar must stay out of the `workspace_plugins_singleton` partial unique (multi-instance is what makes collections possible).
- `knowledge_documents` mirrors OKF frontmatter as real columns (`type`, `title`, `description`, `tags` jsonb, `timestamp`, `resource`) plus body, collection ownership, `atlas:` provenance, and a content-mode `status` column; `knowledge_links` holds the link graph extracted at ingest. Both are content-mode participants (draft counts, publish endpoint, dev-mode overlay — drafts are previewable through the agent in developer mode via the existing per-mode mirror).
- The layered search roadmap (structured frontmatter filter → Postgres FTS → 1-hop graph expansion → embeddings) lands on these same rows later without re-ingestion; adopting it is a tool addition, not a storage change.
- A multi-pillar anti-confusion enters the glossary: Notion/Confluence can be a **REST Datasource** (live vendor-API queries) *or* a **Knowledge Base** (ingested, indexed, review-gated context) — one catalog row per (system, pillar), a customer can install both.
- CONTEXT.md gains the pillar entry, the Collection term, and the descriptive-vs-authoritative anti-confusion (updated alongside this ADR).

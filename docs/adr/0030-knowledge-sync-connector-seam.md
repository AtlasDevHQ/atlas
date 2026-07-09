# Knowledge Sync Connectors: one shared engine, vendors as adapters

A **Knowledge Sync Connector** is a server-side vendor pull that mirrors a
customer's portal content (Confluence spaces, Notion workspaces, …) into a
Knowledge Base collection as review-gated drafts. This ADR names the seam and
fixes its division of labor: a connector is a **vendor client** (enumerate +
fetch changed documents, behind a per-vendor interface with test doubles) plus
a **converter** (pure functions, vendor format → markdown), and everything
else — scheduling, high-water marks, reconciliation cadence, rate-limit
backoff, caps, ingest — is **one shared engine** that vendors never
reimplement. Decided in slice #4376 of PRD #4375; this is the ADR-0028 §5
"second example" decision executed.

## Context

ADR-0028 §5 named Notion/Confluence connectors as deliberate follow-ups and —
per the repo's "name it when there's a second example" discipline — refused to
design the connector abstraction against one hypothetical. PRD #4375 is that
moment: two real vendors at once, with verified vendor ground truth (Confluence
has no markdown output and points-based 429s; Notion's search is officially
non-exhaustive with ~3 req/s limits), so the seam gets named against two real
adapters. The `@atlas/okf-bundle` extraction (#4373) recorded the enabling
invariant in its README: *collect produces documents; pack produces transport*
— a server-side connector must consume collected documents at the ingest seam,
never pack a tar just to unpack it in the same process.

## Decision

**1. The ingest seam splits at document level.** `ingestBundle()` (bytes →
files: size caps, archive extraction) now delegates to `ingestDocuments()`
(documents → rows: per-doc byte cap, lenient parse, doc-count cap, the
uninstall-race re-check, upsert-by-path, optional archive-absent, optional
publish — all in ONE transaction — then a post-commit mirror invalidation).
Upload and bundle-sync
are unchanged consumers of the same transaction; connectors enter at
`ingestDocuments` with collected documents. This deliberately opens the seam
PRD #4372 kept closed ("api changes are imports only" applied to *its* slices,
not this one).

**2. `IngestSource` widens; the publish guard does not.** The source union
gains `` `connector:${string}` `` (e.g. `connector:confluence`), stamped into
`atlas_source` so every row records which vendor wrote it. The atomic-publish
guard stays keyed on `source !== "upload"`, so **connectors structurally
cannot publish** — widening the union can never widen the publish surface
(ADR-0028 §4). Pinned by a structural test plus source-text pins on the engine
modules (no content-mode import, no `status='published'` write).

**3. Two cadences, decided per collection per cycle.** Incremental cycles
fetch changes since the persisted **high-water mark minus a 5-minute overlap
window** (vendor clock skew and minute-granularity change feeds re-fetch a few
unchanged docs, which no-op in the upsert-by-path diff — overlap costs
bandwidth, never correctness) and upsert drafts. **Reconciliation crawls** — on
the `ATLAS_KNOWLEDGE_SYNC_RECONCILE_INTERVAL_HOURS` settings-registry knob
(default weekly), and always for a collection that has never synced — enumerate
the full set; **subtractive archiving of vendor-deleted paths and full-set cap
validation happen ONLY there**, because both launch vendors make
incremental-only sync unsound (non-exhaustive search, query edges). An empty
reconciliation is an error that archives nothing — one bad vendor response
must never wipe a collection (the bundle-sync posture).

**4. Bookkeeping lives in `knowledge_sync_state`, advances only on success.**
Migration 0168 adds `high_water_mark`, `sync_cursor` (opaque vendor
continuation), and `last_reconciled_at` — additive, NULL for bundle-sync rows.
The upsert COALESCEs previous values forward when an attempt passes nulls
(every error attempt does), so a failed cycle can never skip the changes it
failed to ingest, and an unparseable vendor timestamp is dropped with a warn
rather than persisted.

**5. Rate limiting is engine property.** A vendor client throws
`ConnectorRateLimitError` (parsed 429/`Retry-After`); the engine waits
min(`Retry-After`, 60s) and retries up to 3 **total** attempts (the initial
try + 2 retries), then records an error outcome for that collection. Per-collection failure isolation is unchanged
from bundle-sync: the cycle walk continues past any single failure.

**6. Dispatch is keyed on catalog id.** The sync cycle lists installs of
`bundle-sync` plus every catalog id in the connector registry
(`lib/knowledge/connectors.ts`) and routes each install to its engine. A
vendor package ships a `KnowledgeSyncConnector` (catalog id + vendor slug +
client factory) and registers it at wiring time; the fixture-vendor test suite
drives the full path — Scheduler cycle → dispatch → engine → document-level
ingest — with no real vendor existing yet.

## Alternatives considered

### Keep connectors on the bundle path (build a tar in-process, rejected)

Each vendor would pack collected documents into an archive for `ingestBundle`
to immediately unpack. Pure ceremony (the #4373 invariant exists to forbid
it), and it would launder connector ingests through `bundle-sync`-shaped code,
losing per-vendor provenance and forcing container-stage failure kinds onto
callers that have no container.

### A generic `"connector"` source value instead of `connector:<vendor>` (rejected)

Loses provenance the compliance story needs (`atlas_source` should say *which*
vendor wrote a row) and buys nothing — the publish guard keys on
`!== "upload"`, so the union's width is free.

### Subtractive archiving on incremental cycles (rejected)

Requires trusting vendor change feeds to report deletions exhaustively —
false for both launch vendors (Notion search is officially non-exhaustive;
Confluence CQL has edges). A path Atlas archives because a feed forgot it is a
correctness bug with a user-visible blast radius; deletions belong to the
crawl that provably saw the full set.

### Per-vendor backoff / scheduling (rejected)

429 handling, overlap windows, and cadence decisions duplicated per vendor is
exactly the copy-adaptation this seam exists to prevent (the #81 lesson that
produced `ingestBundle`). Vendor clients stay thin enough to fake in tests;
everything retryable/schedulable is engine code, tested once.

### High-water marks in `workspace_plugins.config` (rejected)

A re-install upserts `config = EXCLUDED.config`, silently wiping sync
bookkeeping — the same reason `knowledge_sync_state` exists at all (migration
0164). The new columns land there.

## Consequences

- ADR-0028 §5's "no connector abstraction yet" deferral is **closed** (this
  ADR is the second-example naming it anticipated); §5 carries an amendment
  pointer here. The `@atlas/okf-bundle` README's "no `IngestSource` framework"
  phrasing is superseded: the framework now exists, and the recorded
  collect/pack invariant is what made it a document-level entry.
- Vendor slices (#4377 Confluence, #4378 Notion) implement only: a catalog
  row + install handler, a credentialed vendor client honoring the
  `ConnectorVendorClient` contract (throwing `ConnectorRateLimitError` on
  429s, redacting hosts/tokens in error messages at construction), and a
  golden-fixture-tested pure converter. They must not add scheduling, backoff,
  archiving, or publish logic.
- The `/admin/knowledge` surface reads the same `knowledge_sync_state` row for
  connector collections; recognizing connector catalog rows in its
  list/sync/uninstall branches is vendor-slice work.
- Engine behavior is tested only through the sync/ingest seams with vendor
  test doubles (`connector-sync.test.ts`); the real-Postgres suite executes
  the new state SQL (COALESCE-forward semantics) and migration 0168 against a
  live schema.
- CONTEXT.md gains the **Knowledge Sync Connector** term.

## Amendment (#4396): the shared support HTML→markdown converter sub-seam

PRD #4395 extends the connector family to **support/help-center platforms**
(Zendesk Guide, Intercom, Help Scout, Freshdesk, Front, Zoho Desk, ServiceNow,
Salesforce Knowledge). The vendor research found the tier homogeneous in one
load-bearing way: **every viable support platform returns article bodies as
plain HTML** — unlike Confluence's storage-XHTML dialect or GitBook's extended
markdown. So the tier gets ONE shared converter, named as a sub-seam of this
ADR's "converter" role:

- `lib/knowledge/support/html-to-markdown.ts` — pure, golden-fixture-tested
  HTML→markdown with the same degradation policy the per-vendor converters
  established (unconvertible constructs → counted, visible placeholders
  linking back to the vendor page; never silent drops), plus a **cross-link
  rewriting hook** vendors use to absolutize relative article links.
- A support connector must NOT fork its own HTML→markdown pass; per-vendor
  shaping (titles, paths, provenance, locale fan-out) stays in the vendor's
  `documents.ts`.
- Built with the anchor slice (#4396 Zendesk Guide — token auth + the tier's
  only native incremental feed); consumed by every subsequent support vendor.
- Delta-less vendors in the tier (Intercom, Freshdesk, Front) lean on the
  engine's reconciliation crawl as their change detection — `fetchChanges`
  falls back to full enumeration; no engine change (the two-cadence split
  above already prices this in, just costlier cycles, documented per vendor).

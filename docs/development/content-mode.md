# Content Mode System

Long-form reference for the Content Mode rules summarized in [CLAUDE.md](../../CLAUDE.md) § *Content Mode System*. The draft/published/archived lifecycle is how Atlas keeps in-progress admin edits invisible to end-users until an atomic publish.

## Opt-in: every new user-surfaced content table

Any new table that holds content end-users see (prompts, connections, semantic entities, dashboards, reports, starter prompts, etc.) must include:

- a `status` column with the `draft` / `published` / `archived` enum, and
- a matching `CHECK` constraint.

Default new rows to `draft` unless there's an explicit reason to bypass the pending-changes banner.

## Participate in mode-resolution middleware

- **Read handlers** that expose the content to non-admins must gate by `status = 'published'`.
- **Admin handlers in developer mode** should overlay `status IN ('draft', 'published')` via the `ContentModeRegistry`.
- **Effect-based routes** `yield* ContentModeRegistry` and call `readFilter(table, mode, alias)`.
- **Non-Effect callers** (e.g. `lib/db/internal.ts`) call `resolveStatusClause(table, mode, alias)` from `packages/api/src/lib/content-mode/port.ts` — the registry delegates to the same helper so semantics stay in lockstep. `resolveStatusClause` **throws** for an exotic entry (it can't guess an overlay CTE); an exotic table that has plain status semantics exports its own equivalent instead — e.g. `brainFactStatusClause` for `brain_facts`.
- `resolveMode()` lives in `packages/api/src/api/routes/middleware.ts`.
- **Write handlers** must honor the caller's `atlasMode` when choosing the status value.

## Visible to the atomic publish endpoint

`/api/v1/admin/publish` is the single place drafts become visible to everyone. A new content table must:

- have its drafts promoted inside the existing transaction (phase 3 in `admin-publish.ts`), and
- surface its draft count in `/api/v1/mode` `draftCounts` so the banner stays accurate.

Partial failure rolls every table back — **never** stamp a content table's drafts to published outside the publish transaction.

## The fact class: a promotion that can refuse (#4769, ADR-0036)

`brain_facts` — the company brain's tier-2 reviewed claims — is registered as an **exotic** entry, and it is the only one whose promotion can decline an individual row. Reads are ordinary status semantics (`brainFactStatusClause` / the registry's `readFilter`); the exotic-ness is entirely about the write.

**Why it can't be a simple entry.** A `SimpleModeTable` promotes with one blanket `UPDATE … WHERE status='draft'`. That statement has no per-row opinion, so it can neither refuse a fact nor say which one it refused. ADR-0036 states *no-provenance-no-promotion* (T4) and *no-grant-no-promotion* (T5) as absolutes, and "refuse with an actionable error" is per-row by definition. The rejected alternative was widening `SimpleModeTable` with a `refuse` SQL fragment — that restates the grant grammar in SQL, giving `lib/brain/acl.ts` a second source of truth, and puts one table's machinery in a shape four others share.

**What is actually refusable, and what is already unrepresentable.** Migration 0180 makes most of both rules impossible at rest — `source_episode_id uuid NOT NULL` + a composite FK, `chk_brain_facts_provenance_nonempty`, `chk_brain_facts_grant_nonempty`. So the provenance refusals (`PROVENANCE_MISSING`, `PROVENANCE_EMPTY`) are **defense in depth**: no draft can reach them today, and the live-PG test asserts exactly that (the CHECK refuses, at INSERT). They exist so the rule is enforced where the promotion *decision* is made, not only where the bytes land — surviving a future CHECK relaxation.

`GRANT_UNUSABLE` is the **live** rule and the reason the refusal isn't ceremony. The 0180 CHECK deliberately admits any non-empty element, including one outside the grant grammar: `visible_to = ['everyone']` is legally storable and grants *nobody* access, because enforcement is array overlap against reader tokens and no reader token is ever malformed.

Read `acl.ts`'s constraint precisely, because a loose paraphrase would condemn this rule: what it forbids is a stricter **rejection at rest or at import** — Atlas must never make a legally-stored row unstorable or unimportable, because such a row is a workspace that can't be migrated between regions and the failure surfaces at cutover. It does *not* say Atlas may never be stricter than Postgres; `acl.ts` says outright that its own parser is "deliberately stricter than both". A promotion refusal is neither a rejection at rest nor at import — the row stays stored, exportable, importable, and fixable, it is simply not stamped "reviewed and trusted" while invisible to every reader. That is why the stricter rule is legitimate here and would not be legitimate as a tightened CHECK.

**The corollary:** `GRANT_UNUSABLE` is an invariant of the *promotion path*, not of published facts. A region import writes `status` verbatim, so a workspace can legitimately arrive carrying an already-`published` fact whose grant this classifier would refuse. That asymmetry is deliberate — an importer stricter than the CHECK is the exact failure the rule forbids — and it is pinned by a test so a future "fix" of one side has to argue with it.

**Refuse the row, never the workspace.** A refused fact stays `draft` and the transaction still commits. Failing the shared transaction was rejected: facts arrive continuously from the extraction fiber, so one deriver bug would wedge a tenant's *entire* publish — every prompt, entity, and connection — until somebody hand-edited the database. The refused row stays counted in `draftCounts.brainFacts`, stays listed in the publish preview, and is re-offered next publish. A refusal that only reached the server log would be a silent partial publish, so it is reported on **every** publish surface under one name — `refusedDrafts[]`, top-level in the shared `PublishResult` core (the #4156 discipline), swept from every adapter's `PromotionReport.refused` by `collectRefusals`:

| Surface | How a refusal reaches the caller |
| --- | --- |
| `POST /api/v1/admin/publish` | `refusedDrafts[]` + `refusedDraftTotal` → the Publish modal stays open and renders `RefusedDraftsBanner` |
| MCP `publish_datasources` | both fields in `structuredContent`, so an agent cannot relay `published: true` as unqualified success |
| `atlas datasource publish` | each `detail` printed to **stderr** (exit stays 0 — the publish did commit) |
| `audit_log` | every refused id + reasons, **uncapped** — the durable record, since `log.warn` rotates |

**The list is capped; the count never is.** `refusedDrafts[]` stops at 100 entries so a runaway producer can't make one response unboundedly large — but every entry is a *real* row, and `refusedDraftTotal` carries the true number. **Count off `refusedDraftTotal`, never `refusedDrafts.length`:** they differ exactly when the backlog is worst. An earlier cut appended a synthetic `(truncated)` marker row instead, which simply moved the under-count from the audit row into the UI headline. Both renderers now read the total and say "showing the first N of M".

Note the CLI's nothing-to-publish guard has to account for refusals too: an all-refused publish has every promoted count at zero, and the guard would otherwise print "no pending drafts in this workspace" over a backlog of blocked ones.

A retracted draft (`invalidated_at IS NOT NULL`) is excluded from promotion, from `draftCounts`, and from the preview — consistently, so an excluded row never becomes an unpromotable backlog nobody is told about.

**A second per-row opinion: the grant (#4823).** Promotion also decides what `visible_to` a fact is published *with* — its own tokens, unioned with every grammar-valid principal named by the episodes on a `provenance` edge to it. ADR-0036 §T5 permits a grant to widen only at the review gate, and publish *is* the review gate; the fix rides the existing bulk promote, so it adds no per-fact affirmative verb (which #4772's inverted review model forbids). The union is append-only, so it cannot narrow a grant, and the widening `UPDATE` keeps the `status = 'draft'` **predicate** (it writes `status = 'published'`) and also stamps `pre_widening_visible_to` from the pre-overwrite `visible_to` — the ACL input for provenance attribution (#4836), so a published fact's grant is never rewritten. Mechanically it is a **second** UPDATE, issued only for the rows whose grant actually changed — one combined statement would round-trip every promoted fact's grant through jsonb to change none of them, and the blast radius of a write that touches an ACL should be exactly the rows whose ACL changed. The REST route and the MCP seam both sweep the widenings with the shared `collectWidenings`, for the reason `collectRefusals` exists. (The third publish surface — `knowledge/ingest-bundle.ts`'s "upload & publish" — sweeps only the supersessions, #4937. A widening on that path reaches only the adapter's own INFO line, and that line samples at 20 ids because the complete list rides `PromotionReport.widened`, which that path discards — so a >20-grant widening there loses ids.) On the REST route every widened row reaches `audit_log` as `widenedGrants[]`, uncapped, for the same reason `refusedDrafts` does — more so, since the change is permanent and nothing re-offers it. On the MCP seam it reaches a `log.warn` and no further: `publishWorkspaceDrafts` writes no audit row for *anything*, so a widening-only row would be the single audited event on a path with no audit trail.

**Not registered, deliberately:** `brain_episodes` has no `status` column at all — episodes are append-only *evidence*, and evidence is not review-gated; only the claims drawn from it are. `brain_edges` is derived structure whose visibility follows its endpoints, content-mode-exempt for the same reason `knowledge_links` is.

**Grep-provable single promotion path — nine gated columns, two asymmetries, four INSERT justifications.** `scripts/check-brain-fact-promotion.sh` (in `/ci` and the `ci` workflow) refuses, outside its allowlist:

- `status` on **UPDATE and INSERT** — a writer must omit it so 0180's `draft` default applies the gate by construction;
- `visible_to` — and, on the same terms, `pre_widening_visible_to` (#4836) — on **UPDATE only**, including an upsert's `ON CONFLICT … DO UPDATE` half. An INSERT naming `visible_to` is correct and required: the grant is *derived at ingest*, so an INSERT arm would refuse the write the whole ACL design rests on;
- `valid_to` (#4912) on **UPDATE only**, for the temporal axis: *a human promotion stamps `valid_to`; there is no autonomous supersession* (ADR-0036 §Temporal). INSERT is deliberately ungated — importing a fact with an already-closed window is a restore, not an arbitration. Unlike a stray `status` write, a stray supersession is **invisible**: every as-of-now read hides the row it just retired.
- the identity keys — `subject_key`, `predicate_key`, `object_key`, and the comparison columns `subject_cmp` / `object_cmp` (#5019, ADR-0037) — on **UPDATE only**, on the grant's terms exactly. A key is `alias(lexicalNorm(surface))`, *derived at ingest*, so an INSERT naming them is correct and required. What must not exist is a second writer that **re-keys** an existing fact: a key decides what a claim collides with, and the collision is what the publish gate stamps `valid_to` on — so de-merging two keys between `SUPERSESSION_TARGETS_SQL`'s SELECT and `SUPERSEDE_STAMP_SQL`'s UPDATE retires a pair that no longer collides, reaching the irreversible column by proxy. Re-keying belongs in the alias-approval decide transaction, which takes the identity-mutation advisory lock and previews the effect before a human commits. This also turns what was legal-*by-omission* into a recorded decision: an alias approval changes **published** rows' collision behaviour with no draft stage, which is defensible (the surfaces are untouched, so no user-facing content moved) but should be defensible on the record. Neither `_cmp` column exists yet — both arms are gated ahead of #5032 so the guard never lags the schema, and both spellings are listed because #5019 names `subject_cmp` while ADR-0037 §4's column table names `object_cmp`; over-breadth is free here and a missing arm is not.

`scripts/__tests__/check-brain-fact-promotion.test.sh` pins both directions on each column — including the must-PASS derive-at-ingest inserts, so a future tidy-up into symmetry has to fail a test first. The failure message branches per column, because "omit the column" is the fix for `status` and actively wrong for a grant. An ingest writer simply omits `status` — 0180 defaults it to `draft`, so the gate applies itself.

**Two carve-outs, both recorded here because the rule requires it.** Beyond the promotion adapter itself (`lib/content-mode/adapters/brain-facts.ts`, which *is* `promoteBrainFacts`), the allowlist names exactly two writers, and each has to argue that it is not making a new gate decision:

- **the region import** (`api/routes/admin-migrate.ts`) preserves the *source* workspace's review status verbatim — restoring a prior gate decision, not making one. Demoting reviewed facts back to draft at every cutover would re-queue a human's completed review work;
- **the correction verbs** (`lib/brain/correction.ts`, #4915) — see [the correction carve-out](#a-correction-is-the-second-gate-time-writer-correct_fact-4915) below.

Each entry is listed twice, once under `packages/api/` and once under `create-atlas/templates/*/src/`, because the scan covers the templates on purpose and the allowlist matches full paths rather than a `src/…` suffix any package could adopt.

## Carve-outs must be explicit and justified

A table that bypasses mode (e.g. `user_favorite_prompts`, where pins are per-user and must never be a shared-workspace draft) needs a comment explaining why in the schema file. If in doubt, opt in: retrofitting mode after launch is painful.

### System-seeded content may be published-at-seed (the `/use-demo` carve-out, #3932)

The "promote only via the atomic publish endpoint" rule governs **human-authored drafts** (admin edits, profiler/wizard output) that need a review step before going live. **System-curated, read-only content with no review step** is a justified carve-out: it may be written directly at `status='published'` at seed time.

The canonical case is the `/use-demo` onboarding seed. It imports the bundled demo semantic layer via `importFromDisk(orgId, { …, status: "published" })` (which threads `status` into `bulkUpsertEntities`), inside the same `withDemoSeedLock` transaction that flips the workspace's `__demo__` install to `published`.

**Why published, not draft (the invariant decision behind #3932):** a fresh signup runs in `published` atlas-mode by default (no developer cookie). The published-mode entity read (`listEntityRows(…, "published")` — the source for **both** the chat data-setup gate **and** the agent's whitelist) requires the **entity's own** `status='published'`. A published *install* alone does **not** surface a draft entity. Seeded as drafts, the demo entities were invisible to the gate (→ "Connect data" prompt, composer hidden) **and** the agent (→ empty whitelist), dead-ending the brand-new user at the activation moment.

Three fixes were weighed:

- **(a)** Gate on install-presence instead of entity count — *rejected*: fixes only the gate, leaving the agent with an empty whitelist (a worse dead-end: composer shows, then the agent says it has no tables).
- **(b)** Make published-mode reads surface any entity backed by a published install — *rejected*: widest blast radius; every workspace's in-progress draft entities would leak into published mode, weakening the core published-only invariant globally.
- **(c) — chosen**: seed the demo entities as `published`. The demo layer *is* the customer's queryable layer for the demo datasource; it's read-only (`use-demo-readonly`) with no review step, so there is no draft to "promote later". This fixes the gate and the agent with **zero** change to any other workspace's draft/published semantics, and it removes the phantom "drafts pending publish" backlog the old behavior left in every demo org's `draftCounts`.

The carve-out is bounded: only the `/use-demo` route passes `status: "published"`; `bulkUpsertEntities` / `importFromDisk` still default to `draft`, so the admin-import, wizard, profiler, and auth-migrate paths keep their review-then-publish workflow. The published upsert's `ON CONFLICT … WHERE status='published'` keeps re-seeding idempotent. Regression coverage: `lib/semantic/__tests__/demo-publish-visibility-pg.test.ts` (live-PG, pins published-visible / draft-invisible) plus the unit chain in `bulk-upsert-atomicity`, `semantic-sync`, and `onboarding` tests.

### A correction is the second gate-time writer (`correct_fact`, #4915)

`lib/brain/correction.ts` is on `check-brain-fact-promotion.sh`'s allowlist, and it is the carve-out the guard's own remediation text forecast. It writes two of them:

- `status = 'published'` (`PROMOTE_CORRECTION_FACT_SQL`) — the replacement claim a `supersede` authors, promoted inside the same transaction rather than queued as a draft;
- `valid_to` — **not** a second spelling: the verb *executes the publish adapter's own* `SUPERSEDE_STAMP_SQL`, imported rather than restated, so the two human-arbitration paths cannot drift.

**Why this is a gate decision and not a bypass of one.** ADR-0036 §T4 makes a correction the second human-authoritative entry point beside the review gate: the correction's author *is* the reviewer, so making the write wait for a second one would review the reviewer. The write is actor-attributed, recorded as an immutable human-authored correction episode, and still screened through the **same** `classifyFactForPromotion` the publish gate runs — so *no-provenance-no-promotion* and *no-grant-no-promotion* hold on this path too. Tier-1 (warehouse-derived) targets are refused for every verb.

**The carve-out is the file, not a shape.** It covers the statements above and the imported #4912 stamp. Any *new* statement in that module touching `status`, `visible_to`, or `valid_to` needs the same argument the existing ones carry — a banner at the top of that module's SQL section says so, which is where the next editor is standing.

The rationale is recorded in two other places a reader might reach first: `correction.ts`'s module header and the guard's own `ALLOWLIST` comment. (The guard's failure text states the *rule* — an allowlist entry needs a recorded rationale — not the rationale itself.) It is recorded **here** because [`.claude/rules/content-mode.md`](../../.claude/rules/content-mode.md) names this document as the register a carve-out must appear in — and it was missing from #4915 until #4939 added it. That rule's `paths:` now also cover `lib/brain/**`, so the next editor of the module that *holds* a carve-out sees the register clause, rather than only the editors of the routes and adapters around it.

### Amendment approval dual-applies to a draft of the same entity (semantic-improve, #4517)

Semantic-improve **amendment approval is itself the publish gate** — approving a proposed change writes the entity's `status='published'` row directly (`applyAmendmentToEntity` in `lib/semantic/expert/apply.ts`), rather than staging a draft for the atomic `/api/v1/admin/publish` endpoint. This is a justified inversion of "promote only via the atomic publish endpoint": the amendment review queue **is** the review step, and the decide seam (#4506) makes "approved means applied" true by construction. There is no separate draft to promote later — the reviewed thing is the published change.

**The hazard this creates, and the dual-apply that closes it.** A developer-mode edit can leave a `draft` row shadowing the same entity. If approval only wrote the published row, a later `/api/v1/admin/publish` — whose `promoteSemanticEntities` deletes the published row and flips `draft → published` — would **clobber the approved change** with the older draft body. So the apply, after writing the published row, **also applies the same amendment to the `draft` sibling** when one exists (`dualApplyToDraftSibling`). Because both writes go through the same `applyAmendment` (append-or-replace **by identity** — `upsertByIdentity`), the two rows converge, and publish carries the approved change forward instead of dropping it.

**Why the published overlay is the apply/diff baseline.** Both the apply and the live-diff render (`computeAmendmentLiveDiff`, #4511) resolve the **published** overlay via `resolveAmendmentBaseline(…, "published")`, not the draft-preferred developer overlay. Two reasons: (1) the reviewer must diff/approve the published body the approval mutates — reading a draft overlay would leak unpublished draft content into the published row; (2) it lets a draft that **removed** the amendment's target still resolve the published baseline, so the draft-side miss is a *skip*, not a spurious apply failure. A never-published, draft-only entity falls back to the developer overlay so it still resolves.

**A draft-side miss is a visible skip, never silence.** If the draft removed the amendment's target (`applyAmendment` throws), tombstoned the entity (`status='draft_delete'`), or its own write fails, the published apply has **already succeeded** — a draft-side problem must not un-approve it. Each case is logged and recorded on the **draft's version history** (`recordDraftSkip`), so an admin editing the draft sees why it diverged; the apply returns a structured `draftDualApply: { kind: "skipped", reason }`. The `GET /pending` live diff also carries `draftExists` so the review card notes a pending draft before approval.

The carve-out is bounded: it lives entirely in the semantic-improve apply/diff path; no other content table's drafts are written outside the atomic publish transaction. Regression coverage: `lib/semantic/expert/__tests__/apply-dual-apply.test.ts` (unit — draft converges, target-miss/tombstone skip visibly) and `lib/semantic/__tests__/amendment-dual-apply-pg.test.ts` (live-PG — draft exists → approve → publish → the approved change survives).

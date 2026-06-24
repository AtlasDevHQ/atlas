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
- **Non-Effect callers** (e.g. `lib/db/internal.ts`) call `resolveStatusClause(table, mode, alias)` from `packages/api/src/lib/content-mode/port.ts` — the registry delegates to the same helper so semantics stay in lockstep.
- `resolveMode()` lives in `packages/api/src/api/routes/middleware.ts`.
- **Write handlers** must honor the caller's `atlasMode` when choosing the status value.

## Visible to the atomic publish endpoint

`/api/v1/admin/publish` is the single place drafts become visible to everyone. A new content table must:

- have its drafts promoted inside the existing transaction (phase 3 in `admin-publish.ts`), and
- surface its draft count in `/api/v1/mode` `draftCounts` so the banner stays accurate.

Partial failure rolls every table back — **never** stamp a content table's drafts to published outside the publish transaction.

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

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

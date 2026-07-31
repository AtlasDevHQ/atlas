---
paths:
  - "packages/api/src/lib/content-mode/**"
  - "packages/api/src/lib/db/schema.ts"
  - "packages/api/src/api/routes/**"
  # `lib/brain/**` is here because a carve-out was created there without this
  # rule ever loading (#4939): `brain_facts` is the one exotic content-mode
  # entry, and `lib/brain/correction.ts` is on the promotion guard's allowlist.
  # The slices that loaded this rule created no carve-out; the slice that
  # created one loaded no rule, so the "record the rationale" clause below
  # reached nobody.
  - "packages/api/src/lib/brain/**"
---

# Content mode (draft / published)

Schema requirements, mode-resolution middleware, the atomic publish endpoint, and carve-out rules: [docs/development/content-mode.md](docs/development/content-mode.md).
- [ ] **New user-surfaced content tables opt into mode** — Add a `status` column (`draft`/`published`/`archived` enum + `CHECK`), default `draft`. Gate non-admin reads by `status = 'published'`; admin/dev-mode overlays `status IN ('draft','published')` via `ContentModeRegistry` (`readFilter`) or `resolveStatusClause` for non-Effect callers. Register the table in `CONTENT_MODE_TABLES` (`lib/content-mode/tables.ts`) — the publish wire contract derives from it
- [ ] **Promote only via the atomic publish endpoint** — `/api/v1/admin/publish` is the single place drafts go live: promote inside its transaction (`admin-publish.ts`) and surface the count in `/api/v1/mode` `draftCounts`. Never stamp drafts to published outside it. Carve-outs (e.g. `user_favorite_prompts`) need a recorded rationale (migration comment + the content-mode doc)

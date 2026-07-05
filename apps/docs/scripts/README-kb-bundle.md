# Docs → Knowledge Base bundle

Builds the docs portal's Knowledge Base bundle — a `.tar.gz` OKF tree of clean
markdown (one file = one document, `title`/`description`/`tags` frontmatter)
for the KB ingest seam (ADR-0028).

Since #4367 this script is the **dogfood consumer of `@atlas/fumadocs-okf`**
(`packages/fumadocs-okf` — see its README for the adapter contract and the
bundle-sync hosting recipe). The adapter owns OKF rendering, deterministic
archive paths, generation-time ingest-cap validation, and deterministic
packing; this script supplies only the portal-specific parts:

- **source shims** (`kb-bundle-sources.ts`): the portal's real Fumadocs loader
  lives behind the Next bundler (`.source/server.ts` imports
  `*.mdx?collection=…` modules bun can't resolve), so local mode walks
  `content/` and approximates the processed surface (fence-aware ESM strip),
  and deployed mode reads the live site's `llms.txt` + `.mdx` twins
  (byte-faithful bodies);
- the **audience transform** via the adapter's body-transform hook: the
  portal's own `stripInactiveAudienceBlocks` resolves
  `<WhenSaaS>`/`<WhenSelfHosted>`/`<AudienceLink>` per mount and fails closed,
  so a SaaS bundle is structurally incapable of carrying self-hosted branches
  (pinned by `src/lib/__tests__/kb-bundle.test.ts`). A page the strip can't
  fully resolve is skipped, never emitted.

Reserved-basename fix (#4367): the ingest parser silently skips `index.md` /
`log.md`, which used to drop all 8 section-landing pages (165 built → 157
ingested, `rejected=0`). The adapter now folds `…/index.mdx` onto the section
slug (`shared/comparisons/index.mdx` → `shared/comparisons.md`) in BOTH modes,
so built count == ingested count; the summary prints any reserved renames.

## 1. Generate the bundle

```bash
cd apps/docs
# local (default): build from the repo content/ tree
bun run scripts/build-docs-kb-bundle.ts --out /tmp/docs-kb-saas.tar.gz
# self-hosted surface (content/self-hosted + content/shared):
bun run scripts/build-docs-kb-bundle.ts --audience self-hosted --out /tmp/docs-kb-sh.tar.gz
# keep the api-reference stubs (usually don't — they're empty <APIPage> shells):
bun run scripts/build-docs-kb-bundle.ts --include-api-reference

# from a deployed site: fetch llms.txt + .mdx twins (byte-faithful bodies, no build)
bun run scripts/build-docs-kb-bundle.ts --from-deployed https://docs.useatlas.dev --out /tmp/docs-kb-deployed.tar.gz
```

`--from-deployed` reads each page's URL *path* from the index and re-roots it
onto the base URL you pass, so it works against staging or a preview
deployment. It is **surface-dependent**: it only works on a site that has
opted into the hand-authored `llms.txt` + `.mdx`-twin routes (ours has). Local
mode's archive paths are prefixed per section (`docs/…`, `shared/…`,
`self-hosted/…`); deployed mode uses a single `portal/…` prefix. Twin-fetch
failures are fail-loud (unlike the #4366 spike): a silently partial bundle fed
to a bundle-sync collection would archive the missing pages' documents via the
subtractive diff.

The summary line `Documents: N` is a reconcile contract — expect the SAME
count ingested. A smaller ingest count means silent drops; investigate.

## 2. Create an upload collection (staging)

A collection is a `pillar='knowledge'` install of the `catalog:okf-upload`
catalog. Easiest path is the admin UI:

**Admin → Knowledge → add an OKF upload collection.** Note the collection slug
(its `install_id`) — you need it for the ingest call.

## 3. Ingest the bundle

Upload the raw bytes as `application/octet-stream` to the ingest route. Requires
an authenticated **admin session** (reuse your browser session cookie against the
staging API, or an admin API credential):

```bash
curl -sS -X POST \
  "$STAGING_API/api/v1/admin/knowledge/$COLLECTION_SLUG/ingest" \
  -H "Content-Type: application/octet-stream" \
  -H "Cookie: $ADMIN_SESSION_COOKIE" \
  --data-binary @/tmp/docs-kb-saas.tar.gz
```

Everything lands as **`draft`**. Review it:

```bash
curl -sS "$STAGING_API/api/v1/admin/knowledge/$COLLECTION_SLUG/documents" \
  -H "Cookie: $ADMIN_SESSION_COOKIE" | jq '.documents | length'
```

## 4. Publish

⚠️ **`?publish=true` on the ingest call, and `POST /api/v1/admin/publish`, are
BOTH workspace-wide** — they promote every pending draft across all content-mode
tables (entities, connections, prompts, knowledge), not just these docs. For a
clean staging test, either use a throwaway workspace, or ingest without publish,
confirm no other drafts are pending, then publish deliberately.

```bash
# publish this workspace's pending drafts (includes the just-ingested docs):
curl -sS -X POST "$STAGING_API/api/v1/admin/publish/" -H "Cookie: $ADMIN_SESSION_COOKIE"
```

Published docs are mirrored to the agent's sandboxed `explore` view
(`.orgs/{orgId}/modes/published/knowledge/...`); drafts appear only in developer
mode. A good final check is asking the agent something only these docs answer.

## 5. bundle-sync instead of upload

For the scheduled-pull path (synced content always queues for review — no
publish shortcut, enforced at the seam), host the generated archive at an
endpoint and point a `bundle-sync` collection at it. The full recipe — static
artifact vs route handler, the bearer-protected variant, the SSRF egress-guard
reachability constraints, and the cap-settings knobs — lives in
`packages/fumadocs-okf/README.md`.

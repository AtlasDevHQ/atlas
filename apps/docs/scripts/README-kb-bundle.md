# Docs → Knowledge Base staging-ingestion test

A throwaway helper for exercising the KB upload-ingest pipeline (ADR-0028) end to
end in **staging**, using the docs portal as a realistic prose corpus.

`build-docs-kb-bundle.ts` turns the portal content into a `.tar.gz` OKF tree of
clean markdown (one file = one document, `title`/`description`/`tags`
frontmatter) that the upload-ingest seam accepts directly. It has two modes:

- **local** (default) — build from the repo `content/` tree. No network, no
  build; approximates the processed surface (fence-aware ESM strip + audience
  strip). Best for a reproducible, offline bundle.
- **`--from-deployed <base-url>`** — build from a *deployed* docs site's
  `llms.txt` index + per-page `.mdx` twins over HTTP. Bodies are byte-faithful to
  fumadocs' `getText("processed")` (the same content the on-page "copy markdown"
  button yields), titles/descriptions come from the index, and no local build is
  needed. Use it to A/B the body fidelity against the local bundle.

## What it produces

Mirrors the SaaS `source` composition (`src/lib/source.ts`): `content/docs`
(minus the 473 auto-generated `api-reference/` stubs) + `content/shared`, scoped
to the `saas` audience. ~165 documents, ~0.7 MB — comfortably under the ingest
caps (1000 docs / 1 MB per doc / 25 MB per bundle).

Pages whose content is entirely component-rendered at build time (e.g.
`changelog.mdx` is just `<ChangelogTimeline />`) carry no static prose, so they
ingest as contentless KB docs and are skipped. MDX `import`/`export` module
lines are stripped fence-aware — an `import` inside a ``` code block is a code
*example* and is preserved, only the top-of-file component imports are removed.

Faithfulness: the leak-safety-critical transform — resolving
`<WhenSaaS>` / `<WhenSelfHosted>` / `<AudienceLink>` for the target audience — is
done by importing the portal's own pure `stripInactiveAudienceBlocks` (the same
function `getLLMText` uses), so a SaaS bundle is structurally incapable of
carrying self-hosted branches. It does **not** run fumadocs' `getText("processed")`
MDX pass; since that preserves component tags verbatim anyway the gap is minor
(the odd leftover `<Callout>` tag), and MDX `import`/`export` module lines are
stripped here so the body reads as prose. For a byte-faithful bundle instead,
harvest the `.md` twins a full `next build` emits under `out/` — this script is
the lightweight, reproducible stand-in.

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

`--from-deployed` reads each page's URL *path* from the index and re-roots it onto
the base URL you pass, so it works against staging or a preview deployment, not
just prod. It filters `api-reference/` and contentless pages the same way local
mode does.

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

## 5. (Fast follow) bundle-sync instead of upload

The portal already publishes `https://docs.useatlas.dev/llms-full.txt` and
per-page `.mdx` twins. Once the upload path looks right, a `bundle-sync`
collection pointed at that surface tests the scheduled-pull path — synced content
always queues for review (no publish shortcut, enforced at the seam).

# `@atlas/fumadocs-okf` — Fumadocs → Atlas Knowledge Base bundles

Turn any [Fumadocs](https://fumadocs.dev) site into an OKF `.tar.gz` the Atlas
Knowledge Base ingests — through the **existing** `bundle-sync` connector (pull
on a schedule) or the admin upload route. No `packages/api` changes, no new
connector: the adapter's whole job is producing an archive the ingest seam
already accepts (issue #4367; ADR-0028 §5 deliberately defers any
connector/adapter framework).

**Unpublished by design.** This package is internal (`private: true`), consumed
in-repo by the docs portal and by third parties via copy. Publishing to npm is
deferred until the API survives a real non-Atlas consumer — at which point it
needs an explicit `fumadocs-core` peerDependency range pinned to the majors
actually tested, and the `0.0.x` exact-pin publish sequencing from the root
CLAUDE.md applies.

## Requirements

The site's `source.config.ts` must enable processed-markdown output on each
collection the bundle draws from:

```ts
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: { includeProcessedMarkdown: true },
  },
});
```

That one line is the only opt-in. Without it a page has no
`getText("processed")` body and the build **fails with an error naming this
config** — the adapter never falls back to raw MDX (a raw body would carry
unstripped `import`/`export` lines and un-expanded component content: quietly
worse documents).

## Usage

```ts
import { loader } from "fumadocs-core/source";
import { buildFumadocsOkfBundle } from "@atlas/fumadocs-okf";

export const source = loader({ baseUrl: "/docs", source: docs.toFumadocsSource() });

const result = await buildFumadocsOkfBundle(source, {
  prefix: "docs",                        // stable top-level dir — see "Path stability"
  tags: ["acme-docs"],                   // provenance tags, visible in the review UI
  filter: (page) => !page.path.startsWith("internal/"),   // page-filter hook
  transform: (body, page) => body,       // body-transform hook (return null to skip a page)
});

await Bun.write("site-kb.tar.gz", result.bytes);
console.log(result.stats); // documents, byte totals, skips, reserved renames
```

The input is typed **structurally** against the loader surface
(`getPages()`, `page.path`, `page.data.{title,description,getText}`), so this
package has no `fumadocs-core` dependency — a real `loader()` output satisfies
it, and so does a hand-built shim where the bundler-generated source isn't
loadable (see `apps/docs/scripts/kb-bundle-sources.ts` for both a filesystem
shim and a deployed-site shim).

Multi-section sites compose collects and pack once — the ingest caps AND
cross-section path uniqueness are validated over the merged set at pack (a
duplicate archive path is refused, never silently last-write-wins):

```ts
import { collectFumadocsPages, mergeCollectResults, packOkfBundle } from "@atlas/fumadocs-okf";

const merged = mergeCollectResults([
  await collectFumadocsPages(docsSource, { prefix: "docs" }),
  await collectFumadocsPages(blogSource, { prefix: "blog" }),
]);
const { bytes } = packOkfBundle(merged.docs);
```

### Built-in skips (they ride the same hooks)

- **`api-reference/` stubs** (`skipApiReference`, default on) — auto-generated
  OpenAPI shells with no prose; a waste of the doc-count cap.
- **Contentless pages** (`skipContentless`, default on) — pages that are
  entirely component-rendered (e.g. a body of just `<ChangelogTimeline />`).

Both are counted in `stats.skipped`, never silent, and can be disabled or
replaced by your own `filter`.

### What the path mapping guarantees

Archive paths derive **deterministically from `page.path`** — no hashing, no
ordering dependence — under your stable `prefix`:

| page                    | archive path        | why                                            |
| ----------------------- | ------------------- | ---------------------------------------------- |
| `guides/setup.mdx`      | `guides/setup.md`   | 1:1                                            |
| `guides/index.mdx`      | `guides.md`         | landing folds onto the section slug            |
| `index.mdx` (root)      | `overview.md`       | root landing                                   |
| `ops/log.mdx`           | `ops/log-doc.md`    | reserved OKF basename — renamed, never dropped |

The fold/rename matters: the KB ingest parser **silently skips** the reserved
OKF basenames `index.md`/`log.md` (navigation/history in hand-authored OKF
trees). Fumadocs uses `index.mdx` for real section-landing content, so without
the fold a site's biggest overview pages vanish without even a rejection row —
that exact 8-of-165 gap is what motivated this mapping (#4367). Every rename is
reported in `stats.renamedReserved`.

**Reconcile guardrail:** `stats.documents` is the count Atlas should report as
ingested. Because reserved basenames are renamed at generation, a smaller
ingest count is a signal to investigate, never expected shrinkage.

## Path stability & rename churn

The bundle-sync subtractive diff (`archiveAbsent`) keys on **full bundle
paths**. Consequences:

- Keep `prefix` constant across builds (never a build number or commit SHA) —
  a changed prefix reads as "everything absent + everything new" and
  re-archives/re-drafts the whole collection.
- Renaming a page's slug or directory reads as "old path absent + new path
  added": the old document is **archived** and the new one lands as a fresh
  **draft** for review. That churn is *expected and safe* (synced content never
  hard-deletes), but it is visible in review queues — plan slug renames
  accordingly.

## Ingest caps (validated at generation time)

Atlas rejects bundles over its knowledge-ingest caps. The adapter validates at
**generation** time and fails with the actual numbers, so the site owner sees
the overflow where they can act on it — not as a recurring per-sync ingest
error on the Atlas side they can't see into.

| cap                | default | server setting                            |
| ------------------ | ------- | ----------------------------------------- |
| documents / bundle | 1000    | `ATLAS_KNOWLEDGE_INGEST_MAX_DOCS`         |
| bytes / document   | 1 MB    | `ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES`    |
| bytes / bundle     | 25 MB   | `ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES` |

The settings are runtime-tunable by a platform operator from the Admin console
(settings registry — no redeploy). If the target workspace runs raised caps,
pass the raised values via the `caps` option; the defaults here are pinned to
the server defaults by this package's round-trip test.

## Hosting recipe — feeding a `bundle-sync` collection

A `bundle-sync` collection is a Knowledge Base install whose config carries an
`endpoint_url` + `auth_scheme` (`none | bearer | basic`). On a schedule, Atlas
pulls the endpoint and re-ingests: new/changed pages land as **drafts** for
review, pages that left the bundle are archived (the subtractive diff). Synced
content always queues for review — there is no publish shortcut at this seam.

### 1. Generate the archive in your build

```jsonc
// package.json
{ "scripts": { "build:kb": "bun run scripts/build-kb-bundle.ts" } }
```

Run it in CI next to your site build so the artifact always matches the
deployed content. Output is **byte-deterministic** for identical content
(sorted entries, fixed timestamps), so an unchanged site produces an unchanged
artifact — content-addressed hosting and honest artifact diffs both work.

### 2. Serve it

Any of these work — the endpoint just has to return the raw `.tar.gz` bytes:

- **Static artifact**: copy `site-kb.tar.gz` into your static output
  (`public/`), served at `https://docs.example.com/site-kb.tar.gz`.
- **Next.js route handler** (bearer-protected variant shown below).

**Reachability constraints (read this before picking a host).** Atlas fetches
the endpoint through its SSRF egress guard:

- The URL must be **publicly routable**. Private, loopback, link-local, and
  internal-DNS targets are blocked — at the initial URL *and at every redirect
  hop*. An internal-only artifact host won't work.
- On a **cross-origin redirect the auth header is stripped**. If the endpoint
  is authenticated, any redirects must stay same-origin (best: serve 200s
  directly, no redirects).
- The endpoint is validated at install time too — a blocked target is a
  field-level error when configuring the collection, not a silent dead sync.

### 3. The bearer-protected variant, end to end

Protect the route — compare against a long random token you mint:

```ts
// app/kb-bundle/route.ts  (plain Node APIs — works on any Next.js host)
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function GET(req: Request) {
  const token = process.env.KB_BUNDLE_TOKEN!;
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${token}`;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return new Response("unauthorized", { status: 401 });
  }
  const bytes = await readFile("./artifacts/site-kb.tar.gz");
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "application/gzip" },
  });
}
```

Then configure the collection (Admin → Knowledge → add a Bundle Sync
collection, or the install API) with:

- `endpoint_url`: `https://docs.example.com/kb-bundle`
- `auth_scheme`: `bearer`
- auth secret: the token

The secret is stored encrypted at rest in Atlas's dedicated
`knowledge_sync_credentials` table (never in plugin config); switching the
scheme back to `none` deletes the credential row. `basic` works the same with
a `user:password` secret.

### 4. Verify the first sync

Trigger a sync (or wait for the schedule), then check the collection's
documents: the ingested count should **equal** `stats.documents` from your
build, and every synced doc sits in `draft` awaiting review. If the counts
differ, something dropped — see the reconcile guardrail above.

## Dogfood consumer

`apps/docs/scripts/build-docs-kb-bundle.ts` builds the Atlas docs portal's own
bundle through this adapter — including a leak-safety-critical body transform
(audience stripping) supplied via the `transform` hook, and shims for both a
local content walk and a deployed `llms.txt` + `.mdx`-twin surface. It's the
reference for adapting sites whose real loader isn't importable outside the
Next bundler.

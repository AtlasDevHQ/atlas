# @atlas/okf-bundle

Source-neutral OKF knowledge-bundle builder + the single-homed **OKF wire
contract**. This is the core behind every Atlas Knowledge Base importer:
`@atlas/fumadocs-okf` is the first named adapter, the built-in
[markdown-tree adapter](#the-markdown-tree-adapter) the second, and the
built-in [Mintlify importer](#the-mintlify-importer) (the markdown-tree
adapter plus a `docs.json` nav filter) the third. (Confluence shipped as a *server-side*
Knowledge Sync Connector instead — ADR-0030, #4376 — consuming collected
documents at the ingest seam, not as a generation-side adapter here.) Private
workspace package — not published to npm (promote to a `@useatlas/*` name only
after the API survives a real non-Atlas consumer).

## The doc-source seam

An importer implements exactly one thing:

```ts
interface DocSourcePage {
  readonly path: string;          // source-relative .md/.mdx path — archive paths derive from it
  readonly url?: string;          // messages only
  readonly title?: string;
  readonly description?: string;
  readonly tags?: unknown;        // non-string entries ignored
  loadBody(): Promise<string>;    // file read, HTTP fetch, … — throw to fail loud
}

interface DocSource<P extends DocSourcePage = DocSourcePage> {
  getPages(): readonly P[];
}
```

Everything downstream is the core's, identical for every source:

- **collect** (`collectPages`) — adapter stub-skip predicate → caller `filter`
  → `loadBody()` under bounded concurrency → `transform` hook (return `null`
  to fail-soft-skip) → contentless check → OKF render → deterministic archive
  path. Skips are **counted, never silent**; a body that fails to load fails
  the build with the page named.
- **path derivation** (`deriveArchivePath`) — a pure function of `page.path`:
  section landings fold onto the section slug (`plugins/index.mdx` →
  `plugins.md`), the root landing becomes `overview.md`, and anything still
  landing on a reserved OKF basename (`index.md`/`log.md` — silently skipped
  by the ingest parser) gets a `-doc` suffix. Built count == ingested count by
  construction.
- **cap validation** (`validateIngestCaps`) — the ingest seam's caps applied
  at *generation* time with real numbers (`IngestCapExceededError` names the
  settings knob that raises them).
- **collision guard** — within a collect and again across merged collects at
  pack (`packOkfBundle`); a bundle is either collision-free or refused.
- **packing** (`packOkfBundle` / `createDeterministicTarGz`) — plain POSIX
  ustar + gzip, byte-deterministic (sorted entries, zeroed mtimes).

The generic page parameter `P` lets an adapter thread its own page type
through the `filter`/`transform`/`tags` hooks — the Fumadocs adapter exposes
hooks typed on the Fumadocs loader page while delegating collection here.

## Recorded invariant: collect and pack stay separate

**Collect produces documents; pack produces transport.** Tar is the
remote-transport adapter for the upload route and the bundle-sync connector.
A *server-side* Knowledge Sync Connector (ADR-0030, #4376 — the executed
ADR-0028 §5 follow-up) consumes **collected documents** at the document-level
ingest seam (`ingestDocuments`) directly; it never has to pack an archive
just to unpack it in the same process — this invariant is what made that
entry point possible. Don't fuse the stages, and don't let pack grow
document-shaping behavior.

## The wire module (`@atlas/okf-bundle/wire`)

`src/wire.ts` is the **one home** of the OKF wire contract shared by builders
and `packages/api`'s ingest side (strict parser, lenient parser, knowledge
mirror, ingest caps): reserved basenames, the frontmatter field set,
the `Document` default type, `okf_version`, the `atlas:` extension key, the
ingest-cap defaults, and the mechanical markdown helpers (frontmatter block
split, heading scan, basename util). Both sides import it, so equality holds
by construction — the old cross-package drift-pin tests are retired.

It is a **zero-import leaf**. YAML parsing is injected
(`splitFrontmatterBlock(content, parseYaml)`) rather than imported, keeping
this package's runtime dependencies to `fflate` alone; `packages/api` binds
`js-yaml` once in `semantic/okf/md-utils.ts`.

Dependency direction is one-way by construction: `packages/api` → this
package. `@atlas/okf-bundle` never depends on `@atlas/api` — not even as a
devDependency (the round-trip test through the real ingest stages lives in
`@atlas/fumadocs-okf`, which may dev-dep the api).

## The markdown-tree adapter

`createMarkdownTreeSource` (in this package — the doc source every file-based
docs corpus needs) walks a tree of `.md`/`.mdx` files into a `DocSource`:
deterministic sorted enumeration (hidden dot-segments excluded), frontmatter
(`title`/`description`/`tags`) split via the wire module's
`splitFrontmatterBlock` (a malformed block fails LOUD with the page named),
and an optional fence-aware strip of top-level MDX module lines from `.mdx`
bodies (`stripMdxModules`, default on — `import`/`export` inside code fences
are examples and survive). Frontmatter parsing resolves lazily per page, so a
page a filter skips never costs a read.

```ts
import { buildOkfBundle, createMarkdownTreeSource } from "@atlas/okf-bundle";
import { load } from "js-yaml"; // or Bun.YAML.parse — the parser is injected

const source = await createMarkdownTreeSource({
  root: "content/docs",
  parseYaml: load,
});
const { bytes, stats } = await buildOkfBundle(source, { prefix: "docs" });
```

"Any docs folder" works out of the box. The
[Mintlify importer](#the-mintlify-importer) is this adapter plus a nav filter.
The Atlas docs portal's local mode is this adapter plus portal policy
(`apps/docs/scripts/kb-bundle-sources.ts`).

## The Mintlify importer

`createMintlifySource` (#4391) points the markdown-tree adapter at a Mintlify
site and derives a `filter` predicate from the site's nav manifest —
`docs.json`, falling back to legacy `mint.json` — so only nav-reachable pages
collect. Pages on disk but absent from navigation (snippets, retired pages,
drafts) are declined by the filter and land in the counted
`skipped.filtered` bucket, never silently.

```ts
import { buildOkfBundle, createMintlifySource } from "@atlas/okf-bundle";
import { load } from "js-yaml";

const { source, filter, nav } = await createMintlifySource({
  root: "my-mintlify-site",
  parseYaml: load,
});
const { bytes, stats } = await buildOkfBundle(source, { prefix: "docs", filter });
// nav.manifestPath — which manifest won; stats.skipped.filtered — off-nav pages
```

The manifest is parsed structurally as unknown JSON (no Mintlify config-type
dependency; runtime deps stay `fflate`-only), exploiting the one invariant
that holds across every navigation shape — tabs, anchors, dropdowns,
versions, languages, arbitrarily nested groups, and the flat legacy
`mint.json` group array: **a page path only ever appears as a string element
of a `pages` array**. `href`/`openapi` strings are never pages. A missing,
malformed, or zero-page manifest throws `NavManifestError` at generation time
— the importer never falls back to collecting the whole tree (use
`createMarkdownTreeSource` directly for an unfiltered walk).

## Hosting / ingest recipes

See `@atlas/fumadocs-okf`'s README for serving a built archive to a
bundle-sync collection (including the bearer-protected variant and the
egress-guard reachability constraints) — the recipes apply to any bundle this
core produces.

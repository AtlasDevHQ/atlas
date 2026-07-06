# @atlas/okf-bundle

Source-neutral OKF knowledge-bundle builder + the single-homed **OKF wire
contract**. This is the core behind every Atlas Knowledge Base importer:
`@atlas/fumadocs-okf` is the first named adapter, the markdown-tree adapter
(#4374) the second; Confluence/Mintlify later are one adapter each. Private
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
A future *server-side* connector (ADR-0028 §5 — deliberately deferred, no
`IngestSource` framework) consumes **collected documents** at the ingest seam
directly; it must never have to pack an archive just to unpack it in the same
process. Don't fuse the stages, and don't let pack grow document-shaping
behavior.

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

## Hosting / ingest recipes

See `@atlas/fumadocs-okf`'s README for serving a built archive to a
bundle-sync collection (including the bearer-protected variant and the
egress-guard reachability constraints) — the recipes apply to any bundle this
core produces.

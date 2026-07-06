/**
 * The doc-source seam + the bundle builder's public shapes.
 *
 * A doc source is the ONLY thing an importer implements: enumerate pages,
 * where a page carries a relative path, optional title/description/tags, and
 * resolves a markdown body asynchronously. Everything downstream — collect,
 * path derivation, cap validation, collision guard, deterministic packing —
 * is the core's, identical for every source (PRD #4372). The interface is
 * structural and minimal on purpose: `@atlas/fumadocs-okf` maps the Fumadocs
 * loader surface onto it, a filesystem walker or an HTTP fetcher satisfies it
 * directly, and a test fixture is a page array.
 */

import {
  DEFAULT_INGEST_MAX_BUNDLE_BYTES,
  DEFAULT_INGEST_MAX_DOC_BYTES,
  DEFAULT_INGEST_MAX_DOCS,
} from "./wire";

/** One page of a doc source — the per-page surface the collect stage reads. */
export interface DocSourcePage {
  /**
   * Source-relative `.md`/`.mdx` path, e.g. `guides/getting-started.mdx`.
   * Archive paths derive deterministically from this (no hashing, no ordering
   * dependence) so the bundle-sync subtractive diff stays stable across
   * builds.
   */
  readonly path: string;
  /** Rendered URL when the source has one. Optional — used only in messages. */
  readonly url?: string;
  readonly title?: string;
  readonly description?: string;
  /** Frontmatter tags, when the source carries them. Non-string entries are ignored. */
  readonly tags?: unknown;
  /**
   * Resolve the page's markdown body. May be a file read or an HTTP fetch —
   * the collect stage bounds concurrency and NEVER calls this for a page a
   * filter already skipped. Throw (ideally a `PageLoadError`, or an
   * adapter-specific error like the Fumadocs adapter's
   * `ProcessedTextUnavailableError`) when the body cannot be produced —
   * fail-loud beats a silently partial bundle.
   */
  loadBody(): Promise<string>;
}

/** A doc source: enumerate pages. Generic so adapter hooks keep their own page type. */
export interface DocSource<P extends DocSourcePage = DocSourcePage> {
  getPages(): readonly P[];
}

/**
 * Ingest caps mirrored from Atlas's KB ingest seam
 * (`@atlas/api/lib/knowledge/ingest-limits`). Validated at GENERATION time so
 * a site owner sees the overflow with real numbers where they can act on it,
 * instead of as a recurring per-sync ingest error on the Atlas side.
 * Runtime-tunable server-side via the settings registry
 * (`ATLAS_KNOWLEDGE_INGEST_MAX_DOCS` / `_MAX_DOC_BYTES` / `_MAX_BUNDLE_BYTES`);
 * pass matching values here when an operator has raised them.
 */
export interface IngestCaps {
  /** Max concept documents per bundle. */
  readonly maxDocs: number;
  /** Max decoded size of any single document, in bytes. */
  readonly maxDocBytes: number;
  /** Max bundle size, in bytes — applied to BOTH the decoded total and the compressed archive. */
  readonly maxBundleBytes: number;
}

/** Default caps — the wire module's `DEFAULT_INGEST_MAX_*` constants, which
 *  the server's ingest seam also imports (equal by construction, not by pin). */
export const DEFAULT_INGEST_CAPS: IngestCaps = {
  maxDocs: DEFAULT_INGEST_MAX_DOCS,
  maxDocBytes: DEFAULT_INGEST_MAX_DOC_BYTES,
  maxBundleBytes: DEFAULT_INGEST_MAX_BUNDLE_BYTES,
};

/** One page's collected OKF document, ready to pack. */
export interface CollectedDoc {
  /** Archive path (prefix included), derived deterministically from `page.path`. */
  readonly path: string;
  /** Full rendered OKF document (frontmatter + body). */
  readonly content: string;
  /** UTF-8 byte length of `content` — what the per-doc ingest cap sees. */
  readonly bytes: number;
  /** The originating `page.path`, for reconciliation and error messages. */
  readonly sourcePath: string;
}

/** Why pages were left out of the bundle — surfaced, never silent. */
export interface CollectSkips {
  /** Pages the caller's `filter` hook declined. */
  readonly filtered: number;
  /** Auto-generated API-reference stub pages (`isApiReferenceStub` hits — the
   *  predicate and its default-on policy belong to each adapter; the core
   *  owns only this accounting bucket). */
  readonly apiReference: number;
  /** Pages whose transformed body carried no ingestable prose (built-in skip, `skipContentless`). */
  readonly contentless: number;
  /** Pages the `transform` hook skipped by returning `null`. */
  readonly transformSkipped: number;
}

/**
 * A `-doc` suffix rename applied because a page would otherwise land on a
 * reserved OKF basename the ingest parser silently skips (e.g. `ops/log.mdx`
 * → `docs/ops/log-doc.md`). Ordinary `index` folds (`guides/index.mdx` →
 * `guides.md`) are the NORMAL mapping and are not reported here. `from` is
 * the source `page.path`; `to` is the full archive path (prefix included).
 */
export interface ReservedRename {
  readonly from: string;
  readonly to: string;
}

export interface CollectResult {
  readonly docs: readonly CollectedDoc[];
  readonly skipped: CollectSkips;
  /**
   * The `-doc` suffix renames applied so no emitted path lands on a reserved
   * OKF basename (`index.md` / `log.md` — the ingest parser silently skips
   * those; issue #4367: 8 of 165 portal docs vanished that way). Together
   * with the ordinary `index` fold, this makes built-count == ingested-count
   * by construction. Folds are not listed here — only the rarer suffix
   * renames, which a site owner may want to know about.
   */
  readonly renamedReserved: readonly ReservedRename[];
}

/**
 * The page-type-independent collect options — single-homed so an adapter
 * that re-types the hooks on its own page shape (e.g. `@atlas/fumadocs-okf`)
 * extends THIS instead of `Omit`-ing the hook keys: a new `P`-generic hook
 * added to {@link CollectOptions} then fails the adapter's compile instead
 * of silently riding through typed on the wrong page surface.
 */
export interface CollectBaseOptions {
  /**
   * Stable top-level directory every archive path lives under (the
   * bundle-sync subtractive diff keys on full paths — a per-build prefix
   * would re-archive everything on every sync). One or more plain path
   * segments, e.g. `"docs"` or `"kb/site"`.
   */
  readonly prefix: string;
  /**
   * Skip pages whose transformed body has no ingestable prose (entirely
   * component-rendered pages). Default `true`.
   */
  readonly skipContentless?: boolean;
  /**
   * How many pages resolve their body concurrently (a source's `loadBody`
   * may be an HTTP fetch). Default 8. Output is deterministic regardless.
   */
  readonly concurrency?: number;
}

export interface CollectOptions<P extends DocSourcePage = DocSourcePage>
  extends CollectBaseOptions {
  /**
   * Page-filter hook: return `false` to leave a page out of the bundle.
   * Runs before the page's body is resolved. Composes with (does not
   * replace) the adapter's built-in skips.
   */
  readonly filter?: (page: P) => boolean | Promise<boolean>;
  /**
   * Body-transform hook, applied to the resolved markdown before the
   * contentless check and OKF rendering. Return `null` to skip the page
   * (counted in `skipped.transformSkipped`) — the fail-soft escape for a
   * transform that must never emit an unprocessed body (e.g. the docs
   * portal's audience strip).
   */
  readonly transform?: (body: string, page: P) => string | null | Promise<string | null>;
  /**
   * Provenance tags stamped into every document's OKF frontmatter (merged
   * with the page's own frontmatter tags, de-duplicated). A function
   * receives the page for per-page tagging.
   */
  readonly tags?: readonly string[] | ((page: P) => readonly string[]);
  /**
   * Adapter-supplied predicate for auto-generated API-reference stub pages
   * (`<APIPage>` shells with no prose — worthless as KB content and a waste
   * of the doc-count cap). Matches are skipped BEFORE the caller filter and
   * body resolution, counted under `skipped.apiReference`. The predicate and
   * its on-by-default policy live in each adapter (e.g. the Fumadocs
   * adapter's top-level `api-reference/` rule) — the core has no opinion on
   * what a stub looks like.
   */
  readonly isApiReferenceStub?: (page: P) => boolean;
}

export interface BuildStats {
  /** Documents in the archive — also the count Atlas should report as ingested.
   *  Reserved basenames are renamed at generation, so a smaller ingest count
   *  is a signal to investigate, not expected shrinkage. */
  readonly documents: number;
  /** Sum of decoded document bytes (the total the ingest bomb-guard sees). */
  readonly totalDocBytes: number;
  /** Compressed `.tar.gz` size (the raw upload-size cap sees this). */
  readonly archiveBytes: number;
  readonly skipped: CollectSkips;
  readonly renamedReserved: readonly ReservedRename[];
}

export interface BuildResult {
  /** The `.tar.gz` archive, byte-for-byte deterministic for identical input. */
  readonly bytes: Uint8Array;
  readonly docs: readonly CollectedDoc[];
  readonly stats: BuildStats;
}

export interface BuildOptions<P extends DocSourcePage = DocSourcePage>
  extends CollectOptions<P> {
  /**
   * Generation-time ingest-cap overrides. Defaults to Atlas's server
   * defaults ({@link DEFAULT_INGEST_CAPS}); pass the raised values when the
   * target workspace's operator has tuned `ATLAS_KNOWLEDGE_INGEST_MAX_*`.
   */
  readonly caps?: Partial<IngestCaps>;
}

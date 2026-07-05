/**
 * The adapter's ONLY input contract: the Fumadocs content-source loader
 * surface, typed STRUCTURALLY so this package needs no `fumadocs-core`
 * dependency at all (issue #4367 constraint 4 — the loader surface *is* the
 * compatibility contract; a real `LoaderOutput` from `loader()` satisfies
 * these shapes as-is, and so does a synthetic test fixture or a CLI shim for
 * a site the Next bundler isn't around to load).
 *
 * The fields mirror fumadocs-core's `Page` (`path`, `url`, `data.title`,
 * `data.description`) plus fumadocs-mdx's doc method `getText("processed")`,
 * which only exists when the site's `source.config.ts` enables
 * `postprocess: { includeProcessedMarkdown: true }` on the collection.
 */

/** The per-page surface the adapter reads. Satisfied by a fumadocs `Page`. */
export interface FumadocsOkfPage {
  /**
   * Virtualized file path relative to the collection's content directory,
   * e.g. `guides/getting-started.mdx`. Archive paths derive deterministically
   * from this (no hashing, no ordering dependence) so the bundle-sync
   * subtractive diff stays stable across builds.
   */
  readonly path: string;
  /** Rendered URL, e.g. `/guides/getting-started`. Optional — used only in messages. */
  readonly url?: string;
  readonly data: {
    readonly title?: string;
    readonly description?: string;
    /** Frontmatter tags, when the site's schema carries them. Non-string entries are ignored. */
    readonly tags?: unknown;
    /**
     * fumadocs-mdx doc method. `getText("processed")` returns the
     * byte-faithful processed markdown when `includeProcessedMarkdown` is
     * enabled; absent or throwing otherwise — which this adapter surfaces as
     * an actionable error, never a raw-MDX fallback.
     */
    readonly getText?: (type: "processed" | "raw") => Promise<string>;
  };
}

/** The source surface the adapter walks. Satisfied by fumadocs' `loader()` output. */
export interface FumadocsOkfSource {
  getPages(): readonly FumadocsOkfPage[];
}

/**
 * Ingest caps mirrored from Atlas's KB ingest seam
 * (`packages/api/src/lib/knowledge/ingest-limits.ts`). Validated at
 * GENERATION time so a site owner sees the overflow with real numbers where
 * they can act on it, instead of as a recurring per-sync ingest error on the
 * Atlas side. Runtime-tunable server-side via the settings registry
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

/**
 * Default caps — kept equal to the `DEFAULT_INGEST_MAX_*` constants in
 * `@atlas/api/lib/knowledge/ingest-limits` (pinned by this package's
 * round-trip test, so they cannot drift silently).
 */
export const DEFAULT_INGEST_CAPS: IngestCaps = {
  maxDocs: 1000,
  maxDocBytes: 1_000_000,
  maxBundleBytes: 25_000_000,
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
  /** Auto-generated API-reference stub pages (built-in skip, `skipApiReference`). */
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

export interface CollectOptions {
  /**
   * Stable top-level directory every archive path lives under (the
   * bundle-sync subtractive diff keys on full paths — a per-build prefix
   * would re-archive everything on every sync). One or more plain path
   * segments, e.g. `"docs"` or `"kb/site"`.
   */
  readonly prefix: string;
  /**
   * Page-filter hook: return `false` to leave a page out of the bundle.
   * Runs before the page's body is resolved. Composes with (does not
   * replace) the built-in skips.
   */
  readonly filter?: (page: FumadocsOkfPage) => boolean | Promise<boolean>;
  /**
   * Body-transform hook, applied to the processed markdown before the
   * contentless check and OKF rendering. Return `null` to skip the page
   * (counted in `skipped.transformSkipped`) — the fail-soft escape for a
   * transform that must never emit an unprocessed body (e.g. the docs
   * portal's audience strip).
   */
  readonly transform?: (body: string, page: FumadocsOkfPage) => string | null | Promise<string | null>;
  /**
   * Provenance tags stamped into every document's OKF frontmatter (merged
   * with the page's own frontmatter tags, de-duplicated). A function
   * receives the page for per-page tagging.
   */
  readonly tags?: readonly string[] | ((page: FumadocsOkfPage) => readonly string[]);
  /**
   * Skip pages under a top-level `api-reference/` segment (auto-generated
   * OpenAPI stubs — `<APIPage>` shells with no prose, worthless as KB
   * content and a waste of the doc-count cap). Default `true`. This is the
   * built-in expression of the filter hook; disable and supply your own
   * `filter` to change the policy.
   */
  readonly skipApiReference?: boolean;
  /**
   * Skip pages whose transformed body has no ingestable prose (entirely
   * component-rendered pages). Default `true`.
   */
  readonly skipContentless?: boolean;
  /**
   * How many pages resolve their body concurrently (a shim's `getText` may
   * be an HTTP fetch). Default 8. Output is deterministic regardless.
   */
  readonly concurrency?: number;
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

export interface BuildOptions extends CollectOptions {
  /**
   * Generation-time ingest-cap overrides. Defaults to Atlas's server
   * defaults ({@link DEFAULT_INGEST_CAPS}); pass the raised values when the
   * target workspace's operator has tuned `ATLAS_KNOWLEDGE_INGEST_MAX_*`.
   */
  readonly caps?: Partial<IngestCaps>;
}

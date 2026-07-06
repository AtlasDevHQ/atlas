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
 *
 * Everything source-neutral — the collect pipeline, cap validation, packing,
 * and their option/result shapes — lives in `@atlas/okf-bundle` behind the
 * doc-source seam; this module only re-declares the hook option types in
 * terms of the Fumadocs page so site build scripts keep their exact surface.
 */

import type {
  BuildOptions as CoreBuildOptions,
  CollectOptions as CoreCollectOptions,
  IngestCaps,
} from "@atlas/okf-bundle";

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
 * The core's collect options with every hook re-typed on the Fumadocs page,
 * plus the adapter's own built-in skip policy.
 */
export interface CollectOptions
  extends Omit<CoreCollectOptions, "filter" | "transform" | "tags" | "isApiReferenceStub"> {
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
  readonly transform?: (
    body: string,
    page: FumadocsOkfPage,
  ) => string | null | Promise<string | null>;
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
   * adapter's built-in expression of the core's stub predicate; disable and
   * supply your own `filter` to change the policy.
   */
  readonly skipApiReference?: boolean;
}

export interface BuildOptions extends CollectOptions {
  /**
   * Generation-time ingest-cap overrides. Defaults to Atlas's server
   * defaults (`DEFAULT_INGEST_CAPS`); pass the raised values when the
   * target workspace's operator has tuned `ATLAS_KNOWLEDGE_INGEST_MAX_*`.
   */
  readonly caps?: CoreBuildOptions["caps"];
}

export type { IngestCaps };

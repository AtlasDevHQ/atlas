/**
 * Typed failures for the Fumadocs → OKF adapter. Plain `Error` subclasses
 * (not Effect `Data.TaggedError`): they cross ordinary function boundaries in
 * build scripts and CLIs, never Effect's typed-error channel, and this
 * package deliberately has no runtime dependency on `@atlas/api`.
 *
 * Every failure mode here is FAIL-LOUD by design (issue #4367): a page
 * without processed text must never silently fall back to raw MDX, a cap
 * overflow must surface at generation time with the actual numbers, and a
 * path collision must never let one document silently overwrite another.
 */

/**
 * A page has no `getText("processed")` body — the site's `source.config.ts`
 * hasn't enabled `postprocess: { includeProcessedMarkdown: true }` on the
 * collection (or the page failed to load). Raw MDX is NOT an acceptable
 * fallback: it carries unstripped `import`/`export` module lines and
 * un-expanded component content — quietly worse documents.
 */
export class ProcessedTextUnavailableError extends Error {
  readonly pagePath: string;

  constructor(pagePath: string, detail?: string) {
    super(
      `Page "${pagePath}" has no processed markdown${detail ? ` (${detail})` : ""}. ` +
        `Enable it in the site's source.config.ts collection config: ` +
        `postprocess: { includeProcessedMarkdown: true } — the adapter never falls back to raw MDX ` +
        `(a raw body would carry unstripped import/export lines and un-expanded component content).`,
    );
    this.name = "ProcessedTextUnavailableError";
    this.pagePath = pagePath;
  }
}

/**
 * Two pages mapped to the same archive path. Deterministic path derivation
 * means this is a real content-layout conflict (e.g. `guide.mdx` next to a
 * post-rename `guide/index.mdx` fold target) — refusing beats one document
 * silently shadowing the other in the collection.
 */
export class ArchivePathCollisionError extends Error {
  readonly archivePath: string;
  readonly pages: readonly [string, string];

  constructor(archivePath: string, firstPagePath: string, secondPagePath: string) {
    super(
      `Pages "${firstPagePath}" and "${secondPagePath}" both map to archive path "${archivePath}". ` +
        `Rename one of the source pages — archive paths derive deterministically from page.path, ` +
        `so a collision would make one document silently overwrite the other at ingest.`,
    );
    this.name = "ArchivePathCollisionError";
    this.archivePath = archivePath;
    this.pages = [firstPagePath, secondPagePath];
  }
}

/** Which ingest cap a bundle overflowed, with the server-side settings knob that raises it. */
export type IngestCapKind = "maxDocs" | "maxDocBytes" | "maxBundleBytes";

const CAP_SETTING: Record<IngestCapKind, string> = {
  maxDocs: "ATLAS_KNOWLEDGE_INGEST_MAX_DOCS",
  maxDocBytes: "ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES",
  maxBundleBytes: "ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES",
};

/**
 * The generated bundle would be rejected by Atlas's KB ingest caps. Raised at
 * GENERATION time, with the actual numbers, so the site owner sees the
 * overflow where they can fix it — not as a recurring per-sync ingest error
 * on the Atlas side they can't see into.
 */
export class IngestCapExceededError extends Error {
  readonly cap: IngestCapKind;
  readonly actual: number;
  readonly limit: number;
  /** The document that tripped a per-doc cap, when one did. */
  readonly docPath?: string;

  constructor(params: {
    cap: IngestCapKind;
    actual: number;
    limit: number;
    docPath?: string;
    detail?: string;
  }) {
    const { cap, actual, limit, docPath, detail } = params;
    const unit = cap === "maxDocs" ? "documents" : "bytes";
    super(
      `Bundle exceeds the Atlas knowledge-ingest cap ${cap}: ` +
        `${actual} ${unit} > ${limit} ${unit}` +
        (docPath ? ` (document "${docPath}")` : "") +
        (detail ? ` — ${detail}` : "") +
        `. Trim the bundle (filter hook), or have the workspace operator raise the ` +
        `${CAP_SETTING[cap]} setting and pass the raised value via the caps option.`,
    );
    this.name = "IngestCapExceededError";
    this.cap = cap;
    this.actual = actual;
    this.limit = limit;
    this.docPath = docPath;
  }
}

/** A `page.path` (or configured prefix) the deterministic mapping can't accept. */
export class InvalidPagePathError extends Error {
  readonly pagePath: string;

  constructor(pagePath: string, reason: string) {
    super(`Cannot derive an archive path for "${pagePath}": ${reason}`);
    this.name = "InvalidPagePathError";
    this.pagePath = pagePath;
  }
}

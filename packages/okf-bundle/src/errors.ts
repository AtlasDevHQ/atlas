/**
 * Typed failures for the OKF bundle builder. Plain `Error` subclasses (not
 * Effect `Data.TaggedError`): they cross ordinary function boundaries in
 * build scripts and CLIs, never Effect's typed-error channel, and this
 * package deliberately has no runtime dependency on `@atlas/api`.
 *
 * Every failure mode here is FAIL-LOUD by design (issue #4367): a body that
 * fails to load must fail the build with the page named, a cap overflow must
 * surface at generation time with the actual numbers, and a path collision
 * must never let one document silently overwrite another. Source-specific
 * failures (e.g. the Fumadocs adapter's `ProcessedTextUnavailableError`) live
 * in their adapter and propagate through the collect stage untouched.
 */

/**
 * A page's body failed to load — a shim's HTTP fetch failed, a file read
 * errored, or `loadBody` returned a non-string. Fail-loud with the page
 * named: a silently partial bundle fed to a bundle-sync collection would
 * archive the missing pages' documents via the subtractive diff. The
 * original failure rides `cause`.
 */
export class PageLoadError extends Error {
  readonly pagePath: string;

  constructor(pagePath: string, detail: string, cause?: unknown) {
    super(
      `Failed to load the body for page "${pagePath}": ${detail}. ` +
        `The bundle builder never substitutes a fallback body — fix the load failure and rebuild.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "PageLoadError";
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
        `. Trim the bundle (filter hook), or have the Atlas platform operator raise the ` +
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

/**
 * A bundle would be packed with ZERO documents. Fail-loud by default because
 * the common cause is accidental (a glob that matched nothing, every page
 * filtered out, a transform that skipped them all), not a deliberate empty
 * source. Atlas's ingest seam refuses a doc-less bundle before any write (the
 * `no_documents` guard — emptying a collection requires uninstalling it), so
 * an empty artifact served to a bundle-sync collection produces a RECURRING
 * sync error on the Atlas side, invisible from the build that caused it —
 * failing here puts the error where the site owner can act on it.
 * `allowEmpty` only permits *packing* the empty archive (useful in tests); it
 * cannot make the server accept one.
 */
export class EmptyBundleError extends Error {
  constructor() {
    super(
      "Refusing to pack a bundle with zero documents — Atlas's ingest seam rejects " +
        "a doc-less bundle (emptying a collection requires uninstalling it), so an " +
        "empty artifact just produces a recurring sync error on the Atlas side. " +
        "Check the source, filter, and transform hooks (a glob matching nothing or " +
        "an over-eager filter is the usual cause); pass allowEmpty only if you " +
        "genuinely need to pack an empty archive (e.g. in a test).",
    );
    this.name = "EmptyBundleError";
  }
}

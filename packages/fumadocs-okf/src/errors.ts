/**
 * The one Fumadocs-specific failure. Every source-neutral failure mode —
 * `PageLoadError`, `ArchivePathCollisionError`, `IngestCapExceededError`,
 * `InvalidPagePathError` — lives in `@atlas/okf-bundle` and propagates
 * through this adapter untouched.
 */

/**
 * A page has no `getText("processed")` body because the site's
 * `source.config.ts` hasn't enabled `postprocess: { includeProcessedMarkdown:
 * true }` on the collection (the method is missing, or fumadocs reported the
 * config as absent). Raw MDX is NOT an acceptable fallback: it carries
 * unstripped `import`/`export` module lines and un-expanded component
 * content — quietly worse documents. A body that fails to LOAD for some
 * other reason is a `PageLoadError` (`@atlas/okf-bundle`) instead — same
 * fail-loud posture, without misprescribing the config fix.
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

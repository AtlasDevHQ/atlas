/**
 * `@atlas/fumadocs-okf` — Fumadocs → OKF knowledge-bundle generator.
 *
 * Turns any Fumadocs content-source loader (or a structurally-compatible
 * shim) into an OKF `.tar.gz` the Atlas Knowledge Base ingests via the
 * existing `bundle-sync` connector or the upload route — zero `packages/api`
 * changes required to consume the output (issue #4367: no new connector and
 * no `IngestSource` adapter framework, per ADR-0028 §5's connectors-are-
 * deliberate-follow-ups posture).
 *
 * See `README.md` for the hosting recipe (serving the archive for a
 * bundle-sync collection, the bearer-protected variant, and the egress-guard
 * reachability constraints).
 */

export {
  buildFumadocsOkfBundle,
  mergeCollectResults,
  packOkfBundle,
  validateIngestCaps,
} from "./build";
export { collectFumadocsPages } from "./collect";
export {
  ArchivePathCollisionError,
  IngestCapExceededError,
  InvalidPagePathError,
  PageLoadError,
  ProcessedTextUnavailableError,
  type IngestCapKind,
} from "./errors";
export { isContentlessBody, pageTags, renderOkfDocument, type OkfFrontmatter } from "./okf";
export {
  deriveArchivePath,
  firstSegment,
  isApiReferencePage,
  normalizePrefix,
  RESERVED_OKF_BASENAMES,
  ROOT_INDEX_STEM,
  type DerivedArchivePath,
} from "./paths";
export {
  createDeterministicTar,
  createDeterministicTarGz,
  splitUstarPath,
  type TarEntry,
} from "./tar";
export {
  DEFAULT_INGEST_CAPS,
  type BuildOptions,
  type BuildResult,
  type BuildStats,
  type CollectedDoc,
  type CollectOptions,
  type CollectResult,
  type CollectSkips,
  type FumadocsOkfPage,
  type FumadocsOkfSource,
  type IngestCaps,
  type ReservedRename,
} from "./types";

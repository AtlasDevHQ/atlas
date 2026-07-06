/**
 * `@atlas/fumadocs-okf` — Fumadocs → OKF knowledge-bundle adapter.
 *
 * Maps any Fumadocs content-source loader (or a structurally-compatible
 * shim) onto `@atlas/okf-bundle`'s doc-source seam, producing an OKF
 * `.tar.gz` the Atlas Knowledge Base ingests via the existing `bundle-sync`
 * connector or the upload route — zero `packages/api` changes required to
 * consume the output (issue #4367; ADR-0028 §5's connectors-are-deliberate-
 * follow-ups posture).
 *
 * Since #4373 this package is adapter-only: what lives here is the loader
 * mapping, `getText("processed")` resolution with the
 * `includeProcessedMarkdown` prescription, and the default `api-reference/`
 * stub skip. The bundle invariants (deterministic paths, reserved-basename
 * renames, cap validation, collision guard, deterministic packing) are the
 * core's and are re-exported for compatibility with existing build scripts.
 *
 * See `README.md` for the hosting recipe (serving the archive for a
 * bundle-sync collection, the bearer-protected variant, and the egress-guard
 * reachability constraints).
 */

export { buildFumadocsOkfBundle } from "./build";
export { collectFumadocsPages, firstSegment, isApiReferencePage } from "./collect";
export { ProcessedTextUnavailableError } from "./errors";
export type {
  BuildOptions,
  CollectOptions,
  FumadocsOkfPage,
  FumadocsOkfSource,
} from "./types";

// Source-neutral surface, re-exported from the core so existing consumers
// (portal build scripts, site repos following the README) keep one import.
export {
  ArchivePathCollisionError,
  createDeterministicTar,
  createDeterministicTarGz,
  DEFAULT_INGEST_CAPS,
  deriveArchivePath,
  IngestCapExceededError,
  InvalidPagePathError,
  isContentlessBody,
  mergeCollectResults,
  normalizePrefix,
  packOkfBundle,
  PageLoadError,
  pageTags,
  renderOkfDocument,
  RESERVED_BASENAMES as RESERVED_OKF_BASENAMES,
  ROOT_INDEX_STEM,
  splitUstarPath,
  validateIngestCaps,
  type BuildResult,
  type BuildStats,
  type CollectedDoc,
  type CollectResult,
  type CollectSkips,
  type DerivedArchivePath,
  type IngestCapKind,
  type IngestCaps,
  type OkfFrontmatter,
  type ReservedRename,
  type TarEntry,
} from "@atlas/okf-bundle";

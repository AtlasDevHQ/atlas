/**
 * `@atlas/okf-bundle` — source-neutral OKF knowledge-bundle builder + the
 * single-homed OKF wire contract (#4373, PRD #4372).
 *
 * The core behind every OKF importer: implement the doc-source seam (a source
 * enumerates pages; a page carries a relative path, optional
 * title/description/tags, and resolves a markdown body asynchronously) and
 * the collect → validate → pack pipeline — deterministic archive paths, the
 * reserved-basename fold/rename, generation-time cap validation, the
 * collision guard, deterministic USTAR+gzip packing, counted skips, typed
 * fail-loud errors — comes for free, identical for every source.
 * `@atlas/fumadocs-okf` is the first named adapter.
 *
 * See `README.md` for the doc-source seam contract and the recorded
 * collect/pack separation invariant.
 */

export {
  buildOkfBundle,
  mergeCollectResults,
  packOkfBundle,
  resolveIngestCaps,
  validateIngestCaps,
} from "./build";
export { collectPages } from "./collect";
export {
  ArchivePathCollisionError,
  EmptyBundleError,
  IngestCapExceededError,
  InvalidPagePathError,
  PageLoadError,
  type IngestCapKind,
} from "./errors";
export { isContentlessBody, pageTags, renderOkfDocument, type OkfFrontmatter } from "./okf";
export {
  deriveArchivePath,
  normalizePrefix,
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
  type CollectBaseOptions,
  type CollectedDoc,
  type CollectOptions,
  type CollectResult,
  type CollectSkips,
  type DocSource,
  type DocSourcePage,
  type IngestCaps,
  type PackOptions,
  type ReservedRename,
} from "./types";
export {
  ATLAS_EXTENSION_KEY,
  DEFAULT_INGEST_MAX_BUNDLE_BYTES,
  DEFAULT_INGEST_MAX_DOC_BYTES,
  DEFAULT_INGEST_MAX_DOCS,
  DEFAULT_OKF_TYPE,
  mdBasename,
  normalizeFrontmatterTags,
  OKF_FRONTMATTER_FIELDS,
  OKF_INDEX_BASENAME,
  OKF_LOG_BASENAME,
  OKF_VERSION,
  RESERVED_BASENAMES,
  splitFrontmatterBlock,
  topLevelHeading,
  type FrontmatterBlockSplit,
  type OkfWireFrontmatter,
  type ParseYaml,
} from "./wire";

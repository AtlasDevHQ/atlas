/**
 * OKF (Open Knowledge Format) interop — spike for #4140.
 *
 * Import: OKF bundle -> first-draft semantic layer (one-shot; scan -> enrich
 * -> edit takes over). Export: semantic layer -> conformant OKF v0.1 bundle
 * with an `atlas:` frontmatter extension that makes Atlas -> OKF -> Atlas
 * re-import lossless for entity/glossary objects and metric fields (metric
 * authority is deliberately re-stamped unverified on import).
 *
 * Findings + mapping table: docs/research/okf-interop-spike.md
 */

export { importOkfBundle, type OkfImportOptions } from "./import";
export { exportToOkf, type OkfExportOptions } from "./export";
export { parseFrontmatter, serializeDocument } from "./frontmatter";
export {
  atlasExtension,
  classifyConcept,
  mapColumnType,
  parseBundle,
  parseSchemaColumns,
  splitSections,
  type MappedColumnType,
} from "./parse";
export type {
  AtlasDimensionType,
  InteropFile,
  MappingReport,
  OkfConcept,
  OkfConceptKind,
  OkfExportResult,
  OkfFrontmatter,
  OkfImportResult,
  ParsedFrontmatter,
} from "./types";

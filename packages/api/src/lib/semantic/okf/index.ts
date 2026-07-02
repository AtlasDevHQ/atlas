/**
 * OKF (Open Knowledge Format) interop — spike for #4140.
 *
 * Import: OKF bundle -> first-draft semantic layer (one-shot; scan -> enrich
 * -> edit takes over). Export: semantic layer -> conformant OKF v0.1 bundle
 * with an `atlas:` frontmatter extension for lossless round-trips.
 *
 * Findings + mapping table: docs/research/okf-interop-spike.md
 */

export { importOkfBundle, type OkfImportOptions } from "./import";
export { exportToOkf, type OkfExportOptions } from "./export";
export { parseFrontmatter, serializeDocument } from "./frontmatter";
export {
  classifyConcept,
  mapColumnType,
  parseBundle,
  parseSchemaColumns,
  splitSections,
} from "./parse";
export type {
  InteropFile,
  MappingReport,
  OkfConcept,
  OkfConceptKind,
  OkfExportResult,
  OkfFrontmatter,
  OkfImportResult,
} from "./types";

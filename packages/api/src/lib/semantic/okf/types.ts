/**
 * OKF (Open Knowledge Format) interop types — spike for #4140.
 *
 * OKF v0.1 (GoogleCloudPlatform/knowledge-catalog) represents knowledge as a
 * directory of markdown files with YAML frontmatter. Only `type` is required;
 * `title` / `description` / `resource` / `tags` / `timestamp` are recommended;
 * unknown keys are legal and consumers must preserve them.
 *
 * Both mapping directions operate on in-memory `{ path, content }` file lists
 * so the module has no filesystem coupling — the CLI walks/writes disk, and a
 * future ingest pipeline (#4182) can feed DB-sourced documents through the
 * same seam.
 */

/** One file in a bundle (OKF) or semantic layer (Atlas), path bundle-relative POSIX. */
export interface InteropFile {
  path: string;
  content: string;
}

/**
 * Frontmatter as parsed from an untrusted bundle. Only `type` is verified at
 * the parse boundary — every other key is `unknown` and consumers MUST narrow
 * before use (the compiler enforces it). Do not widen this to the richer
 * {@link OkfFrontmatter}: that type is for documents *we construct* on export,
 * where the field shapes are true by construction.
 */
export interface ParsedFrontmatter {
  type: string;
  [key: string]: unknown;
}

/**
 * Frontmatter Atlas constructs on export — the spec's recommended keys plus
 * the `atlas:` extension. Sound only on the write side; parsed input uses
 * {@link ParsedFrontmatter}.
 */
export interface OkfFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  timestamp?: string;
  /** Atlas extension namespace (spec-legal unknown key) enabling near-lossless round-trip. */
  atlas?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A parsed OKF concept document (any non-reserved `.md` file). */
export interface OkfConcept {
  /** Bundle-relative path, e.g. `tables/orders.md`. */
  path: string;
  frontmatter: ParsedFrontmatter;
  /** Markdown body after the frontmatter block. */
  body: string;
}

/** Atlas's closed dimension-type vocabulary — what imported columns map onto. */
export type AtlasDimensionType = "number" | "string" | "date" | "timestamp" | "boolean";

/** How a concept was classified for import. */
export type OkfConceptKind =
  | "table"
  | "dataset"
  | "metric"
  | "join"
  | "glossary_term"
  | "unmapped";

/** A column parsed from an OKF `# Schema` section (bullet or table form). */
export interface OkfParsedColumn {
  name: string;
  /** Raw source type string, e.g. `INTEGER`, `RECORD`. */
  rawType: string;
  description: string;
}

/** Result of mapping in either direction. */
export interface MappingReport {
  /** Human-readable notes about information lost or approximated. */
  lossy: string[];
  /** Inputs that could not be mapped at all (path + reason). */
  unmapped: string[];
  /** Non-fatal observations (e.g. defaults applied). */
  notes: string[];
}

/** Output of an OKF → semantic-layer import. */
export interface OkfImportResult {
  /** Semantic-layer files to write (entities/*.yml, glossary.yml, metrics/*.yml, catalog.yml). */
  files: InteropFile[];
  report: MappingReport;
}

/** Output of a semantic-layer → OKF export. */
export interface OkfExportResult {
  /** OKF bundle files to write (concept docs + index.md files). */
  files: InteropFile[];
  report: MappingReport;
}

export function emptyReport(): MappingReport {
  return { lossy: [], unmapped: [], notes: [] };
}

/**
 * Builds a pre-computed semantic index from entity YAMLs, metrics,
 * glossary, and catalog files.
 *
 * The index is a Markdown string injected into the agent system prompt
 * so the agent can identify relevant tables without using explore tool
 * calls. Two rendering modes:
 *
 * - **Full** (< 20 entities): shows columns with types, descriptions,
 *   measures, joins, and query patterns.
 * - **Summary** (20+ entities): compact one-liner per entity with column
 *   count, PK, measure count, and join targets.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { createLogger } from "@atlas/api/lib/logger";
import type {
  CatalogEntry,
  ParsedDimension,
  ParsedEntity,
  ParsedGlossaryTerm,
  ParsedJoin,
  ParsedMeasure,
  ParsedMetric,
  ParsedQueryPattern,
} from "./types";

const log = createLogger("semantic-index");

/** Entity count threshold: < this → full mode, >= this → summary mode. */
const FULL_MODE_THRESHOLD = 20;

/** Maximum description length before truncation. */
const MAX_DESCRIPTION_LENGTH = 200;

/** Reserved directory names at the semantic root (not per-source subdirs). */
const RESERVED_DIRS = new Set(["entities", "metrics"]);

function truncateDescription(desc: string): string {
  if (desc.length <= MAX_DESCRIPTION_LENGTH) return desc;
  return desc.slice(0, MAX_DESCRIPTION_LENGTH - 3) + "...";
}

function readYamlFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");
  return yaml.load(content);
}

function parseDimensions(raw: unknown): ParsedDimension[] {
  if (!Array.isArray(raw)) return [];
  const dims: ParsedDimension[] = [];
  for (const d of raw) {
    if (!d || typeof d !== "object" || !("name" in d)) continue;
    const obj = d as Record<string, unknown>;
    dims.push({
      name: String(obj.name),
      type: String(obj.type ?? "unknown"),
      description: obj.description ? String(obj.description) : undefined,
      primary_key: obj.primary_key === true,
      foreign_key: obj.foreign_key === true,
      sample_values: Array.isArray(obj.sample_values)
        ? obj.sample_values.map(String)
        : undefined,
    });
  }
  return dims;
}

function parseMeasures(raw: unknown): ParsedMeasure[] {
  if (!Array.isArray(raw)) return [];
  const measures: ParsedMeasure[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object" || !("name" in m)) continue;
    const obj = m as Record<string, unknown>;
    measures.push({
      name: String(obj.name),
      type: obj.type ? String(obj.type) : undefined,
      sql: obj.sql ? String(obj.sql) : undefined,
      description: obj.description ? String(obj.description) : undefined,
    });
  }
  return measures;
}

function parseJoins(raw: unknown): ParsedJoin[] {
  if (!Array.isArray(raw)) return [];
  const joins: ParsedJoin[] = [];
  for (const j of raw) {
    if (!j || typeof j !== "object") continue;
    const obj = j as Record<string, unknown>;
    const target = obj.target_entity ?? obj.to;
    if (!target) continue;
    joins.push({
      target_entity: String(target),
      relationship: obj.relationship ? String(obj.relationship) : undefined,
      description: obj.description ? String(obj.description) : undefined,
    });
  }
  return joins;
}

function parseQueryPatterns(raw: unknown): ParsedQueryPattern[] {
  if (!Array.isArray(raw)) return [];
  const patterns: ParsedQueryPattern[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object" || !("name" in p)) continue;
    const obj = p as Record<string, unknown>;
    patterns.push({
      name: String(obj.name),
      description: obj.description ? String(obj.description) : "",
    });
  }
  return patterns;
}

/**
 * Parse a single entity YAML file into a ParsedEntity.
 * Returns null if the file is invalid or missing the required `table` field.
 */
function parseEntityFile(filePath: string, sourceId?: string): ParsedEntity | null {
  try {
    const raw = readYamlFile(filePath);
    if (!raw || typeof raw !== "object") return null;

    const obj = raw as Record<string, unknown>;
    if (!obj.table || typeof obj.table !== "string") return null;

    return {
      name: obj.name ? String(obj.name) : obj.table,
      table: obj.table,
      description: obj.description ? String(obj.description) : undefined,
      type: obj.type ? String(obj.type) : undefined,
      grain: obj.grain ? String(obj.grain) : undefined,
      connection: obj.connection ? String(obj.connection) : undefined,
      sourceId,
      dimensions: parseDimensions(obj.dimensions),
      measures: parseMeasures(obj.measures),
      joins: parseJoins(obj.joins),
      queryPatterns: parseQueryPatterns(obj.query_patterns),
    };
  } catch (err) {
    log.warn(
      { file: filePath, err: err instanceof Error ? err.message : String(err) },
      "Failed to parse entity file for index — skipping",
    );
    return null;
  }
}

/** Load all entities from a single entities directory. */
function loadEntitiesFromDir(dir: string, sourceId?: string): ParsedEntity[] {
  if (!fs.existsSync(dir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch {
    return [];
  }

  const entities: ParsedEntity[] = [];
  for (const file of files) {
    const entity = parseEntityFile(path.join(dir, file), sourceId);
    if (entity) entities.push(entity);
  }
  return entities;
}

/** Load all entities from the semantic root (flat + per-source). */
function loadAllEntities(semanticRoot: string): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  // Default entities (semantic/entities/*.yml)
  entities.push(...loadEntitiesFromDir(path.join(semanticRoot, "entities")));

  // Per-source subdirectories (semantic/{source}/entities/*.yml)
  if (fs.existsSync(semanticRoot)) {
    try {
      const entries = fs.readdirSync(semanticRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subEntities = path.join(semanticRoot, entry.name, "entities");
        if (fs.existsSync(subEntities)) {
          entities.push(...loadEntitiesFromDir(subEntities, entry.name));
        }
      }
    } catch {
      // Ignore scan errors
    }
  }

  return entities;
}

/** Load metrics from metrics/*.yml files. */
function loadMetrics(semanticRoot: string): ParsedMetric[] {
  const metricsDir = path.join(semanticRoot, "metrics");
  if (!fs.existsSync(metricsDir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(metricsDir).filter((f) => f.endsWith(".yml"));
  } catch {
    return [];
  }

  const metrics: ParsedMetric[] = [];
  for (const file of files) {
    try {
      const raw = readYamlFile(path.join(metricsDir, file));
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as Record<string, unknown>;
      const rawMetrics = obj.metrics;
      if (!Array.isArray(rawMetrics)) continue;
      for (const m of rawMetrics) {
        if (!m || typeof m !== "object" || !("name" in m)) continue;
        const mObj = m as Record<string, unknown>;
        metrics.push({
          name: String(mObj.name),
          description: mObj.description ? String(mObj.description) : undefined,
          entity: mObj.entity ? String(mObj.entity) : undefined,
          aggregation: mObj.aggregation ? String(mObj.aggregation) : undefined,
        });
      }
    } catch {
      // Skip malformed metric files
    }
  }
  return metrics;
}

/** Load glossary terms from glossary.yml. */
function loadGlossary(semanticRoot: string): ParsedGlossaryTerm[] {
  const glossaryPath = path.join(semanticRoot, "glossary.yml");
  if (!fs.existsSync(glossaryPath)) return [];

  try {
    const raw = readYamlFile(glossaryPath);
    if (!raw || typeof raw !== "object") return [];
    const obj = raw as Record<string, unknown>;
    const terms = obj.terms;
    if (!Array.isArray(terms)) return [];

    return terms
      .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object" && "term" in t)
      .map((t) => ({
        term: String(t.term),
        definition: t.definition ? String(t.definition) : undefined,
        status: t.status ? String(t.status) : undefined,
        disambiguation: t.disambiguation ? String(t.disambiguation) : undefined,
      }));
  } catch {
    return [];
  }
}

/** Load catalog entries for use_for hints. */
function loadCatalog(semanticRoot: string): Map<string, CatalogEntry> {
  const catalogPath = path.join(semanticRoot, "catalog.yml");
  if (!fs.existsSync(catalogPath)) return new Map();

  try {
    const raw = readYamlFile(catalogPath);
    if (!raw || typeof raw !== "object") return new Map();
    const obj = raw as Record<string, unknown>;
    const entries = obj.entities;
    if (!Array.isArray(entries)) return new Map();

    const map = new Map<string, CatalogEntry>();
    for (const e of entries) {
      if (!e || typeof e !== "object" || !("name" in e)) continue;
      const eObj = e as Record<string, unknown>;
      map.set(String(eObj.name), {
        name: String(eObj.name),
        description: eObj.description ? String(eObj.description) : undefined,
        useFor: Array.isArray(eObj.use_for) ? eObj.use_for.map(String) : undefined,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render a single entity in full mode (all columns with types). */
function renderEntityFull(entity: ParsedEntity): string {
  const lines: string[] = [];

  // Header: **table** [connection] — description
  let header = `**${entity.table}**`;
  const connLabel = entity.sourceId ?? entity.connection;
  if (connLabel) header += ` [${connLabel}]`;
  if (entity.description) {
    header += ` — ${truncateDescription(entity.description)}`;
  }
  lines.push(header);

  // Use-for hints
  if (entity.useFor && entity.useFor.length > 0) {
    lines.push(`  Use for: ${entity.useFor.join("; ")}`);
  }

  // Dimensions (columns)
  if (entity.dimensions.length > 0) {
    const colLines: string[] = [];
    for (const d of entity.dimensions) {
      let col = `${d.name} (${d.type}`;
      if (d.primary_key) col += " PK";
      if (d.foreign_key) col += " FK";
      col += ")";
      if (d.description) col += ` — ${d.description}`;
      colLines.push(`  ${col}`);
    }
    lines.push(`  Columns: ${colLines.length}`);
    lines.push(...colLines);
  }

  // Measures
  if (entity.measures.length > 0) {
    lines.push(`  Measures:`);
    for (const m of entity.measures) {
      let line = `  - ${m.name}`;
      if (m.type) line += ` (${m.type})`;
      if (m.description) line += ` — ${m.description}`;
      lines.push(line);
    }
  }

  // Joins
  if (entity.joins.length > 0) {
    const joinTargets = entity.joins.map((j) => `→ ${j.target_entity}`);
    lines.push(`  Joins: ${joinTargets.join(", ")}`);
  }

  // Query patterns
  if (entity.queryPatterns.length > 0) {
    lines.push(`  Query patterns:`);
    for (const p of entity.queryPatterns) {
      lines.push(`  - ${p.name}: ${p.description}`);
    }
  }

  return lines.join("\n");
}

/** Render a single entity in summary mode (compact one-liner). */
function renderEntitySummary(entity: ParsedEntity): string {
  const parts: string[] = [];

  let header = `**${entity.table}**`;
  const connLabel = entity.sourceId ?? entity.connection;
  if (connLabel) header += ` [${connLabel}]`;
  parts.push(header);

  if (entity.description) {
    parts.push(truncateDescription(entity.description));
  }

  // Column count + PK
  if (entity.dimensions.length > 0) {
    const pk = entity.dimensions.find((d) => d.primary_key);
    let colInfo = `${entity.dimensions.length} columns`;
    if (pk) colInfo += `, PK: ${pk.name}`;
    parts.push(colInfo);
  }

  // Use-for hints
  if (entity.useFor && entity.useFor.length > 0) {
    parts.push(`Use for: ${entity.useFor.join("; ")}`);
  }

  // Measures count
  if (entity.measures.length > 0) {
    parts.push(`${entity.measures.length} measures`);
  }

  // Join targets
  if (entity.joins.length > 0) {
    const targets = entity.joins.map((j) => j.target_entity);
    parts.push(`joins: ${targets.join(", ")}`);
  }

  return parts.join(" | ");
}

/** Render the metrics section. */
function renderMetrics(metrics: ParsedMetric[]): string {
  const lines: string[] = ["### Metrics", ""];
  for (const m of metrics) {
    let line = `- **${m.name}**`;
    if (m.entity) line += ` (${m.entity})`;
    if (m.description) line += ` — ${m.description}`;
    lines.push(line);
  }
  return lines.join("\n");
}

/** Render the glossary section. */
function renderGlossary(terms: ParsedGlossaryTerm[]): string {
  const lines: string[] = ["### Glossary", ""];
  for (const t of terms) {
    let line = `- **${t.term}**`;
    if (t.status === "ambiguous") line += " [AMBIGUOUS]";
    if (t.definition) line += ` — ${t.definition}`;
    if (t.disambiguation) line += ` _(${t.disambiguation})_`;
    lines.push(line);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildResult {
  markdown: string;
  entityCount: number;
}

/**
 * Build the semantic index Markdown from a semantic layer root directory.
 *
 * @param semanticRoot - Path to the semantic layer root (e.g. `./semantic`).
 * @returns The built index as a Markdown string, or empty string if no entities found.
 */
export function buildIndex(semanticRoot: string): BuildResult {
  if (!fs.existsSync(semanticRoot)) {
    return { markdown: "", entityCount: 0 };
  }

  // Load all data
  const entities = loadAllEntities(semanticRoot);
  if (entities.length === 0) {
    return { markdown: "", entityCount: 0 };
  }

  const metrics = loadMetrics(semanticRoot);
  const glossary = loadGlossary(semanticRoot);
  const catalog = loadCatalog(semanticRoot);

  // Merge catalog use_for hints into entities
  for (const entity of entities) {
    const catalogEntry = catalog.get(entity.name) ?? catalog.get(entity.table);
    if (catalogEntry?.useFor) {
      entity.useFor = catalogEntry.useFor;
    }
  }

  // Sort entities alphabetically by table name for deterministic output
  entities.sort((a, b) => a.table.localeCompare(b.table));

  const isFullMode = entities.length < FULL_MODE_THRESHOLD;
  const mode = isFullMode ? "full" : "summary";

  const sections: string[] = [];

  // Header
  sections.push(
    `## Semantic Layer Reference (${entities.length} entities, mode: ${mode})`,
  );
  sections.push("");
  sections.push(
    "These entities are pre-indexed from the semantic layer. Use explore to see full details of any entity.",
  );
  sections.push("");

  // Entity list
  if (isFullMode) {
    for (const entity of entities) {
      sections.push(renderEntityFull(entity));
      sections.push("");
    }
  } else {
    for (const entity of entities) {
      sections.push(renderEntitySummary(entity));
    }
    sections.push("");
  }

  // Metrics
  if (metrics.length > 0) {
    sections.push(renderMetrics(metrics));
    sections.push("");
  }

  // Glossary
  if (glossary.length > 0) {
    sections.push(renderGlossary(glossary));
    sections.push("");
  }

  return {
    markdown: sections.join("\n").trimEnd(),
    entityCount: entities.length,
  };
}

/**
 * Pre-indexed semantic layer summary.
 *
 * Reads all entity YAMLs, metrics YAMLs, catalog, and glossary at boot
 * (or on cache invalidation) and builds a compressed text summary that
 * the agent can use without calling the explore tool.
 *
 * Two modes based on entity count:
 * - Small (< 20 entities): full column details in prompt
 * - Large (20+ entities): table-level summaries only
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("semantic-index");

/** Threshold: layers with fewer entities get full column detail. */
const SMALL_LAYER_THRESHOLD = 20;

/** Approximate characters per token (conservative estimate for English). */
const CHARS_PER_TOKEN = 4;

// --- Types for parsed YAML ---

interface EntityDimension {
  name?: string;
  sql?: string;
  type?: string;
  description?: string;
  sample_values?: unknown[];
  primary_key?: boolean;
}

interface EntityMeasure {
  name?: string;
  sql?: string;
  type?: string;
  description?: string;
  aggregation?: string;
}

interface EntityJoin {
  target_entity?: string;
  relationship?: string;
  description?: string;
  join_columns?: Record<string, string>;
}

interface EntityQueryPattern {
  name?: string;
  description?: string;
  sql?: string;
}

interface ParsedEntity {
  name?: string;
  table: string;
  type?: string;
  connection?: string;
  grain?: string;
  description?: string;
  dimensions?: EntityDimension[];
  measures?: EntityMeasure[];
  joins?: EntityJoin[];
  query_patterns?: EntityQueryPattern[];
}

interface ParsedMetric {
  name?: string;
  description?: string;
  sql?: string;
  type?: string;
  entity?: string;
  aggregation?: string;
  unit?: string;
}

interface GlossaryTerm {
  term?: string;
  definition?: string;
  status?: string;
  disambiguation?: string;
}

interface CatalogEntry {
  name?: string;
  description?: string;
  use_for?: string[];
  common_questions?: string[];
}

interface ParsedCatalog {
  version?: string;
  entities?: CatalogEntry[];
}

// --- Index cache ---

let _cachedIndex: string | null = null;
let _cachedEntityCount = 0;

/**
 * Build or retrieve the cached semantic index.
 *
 * @param semanticRoot - Override for the semantic root directory (DI for tests).
 */
export function getSemanticIndex(semanticRoot?: string): string {
  if (_cachedIndex !== null) return _cachedIndex;

  const root = semanticRoot ?? path.resolve(process.cwd(), "semantic");
  _cachedIndex = buildSemanticIndex(root);
  return _cachedIndex;
}

/** Returns the entity count from the last index build. */
export function getIndexedEntityCount(): number {
  return _cachedEntityCount;
}

/** Clear the cached index (called on semantic layer changes). */
export function invalidateSemanticIndex(): void {
  _cachedIndex = null;
  _cachedEntityCount = 0;
}

/**
 * Build a compressed text summary of the entire semantic layer.
 */
export function buildSemanticIndex(semanticRoot: string): string {
  const entities = loadEntities(semanticRoot);
  const metrics = loadMetrics(semanticRoot);
  const glossary = loadGlossary(semanticRoot);
  const catalog = loadCatalog(semanticRoot);

  _cachedEntityCount = entities.length;

  if (entities.length === 0) {
    log.info("No entities found — semantic index is empty");
    return "";
  }

  const isSmall = entities.length < SMALL_LAYER_THRESHOLD;
  const mode = isSmall ? "full" : "summary";

  const sections: string[] = [];

  // Header
  sections.push(
    `## Semantic Layer Reference (${entities.length} entities, mode: ${mode})`,
  );

  // Entity summaries
  sections.push("");
  sections.push("### Tables & Columns");
  for (const entity of entities) {
    sections.push("");
    sections.push(formatEntity(entity, isSmall, catalog));
  }

  // Metrics
  if (metrics.length > 0) {
    sections.push("");
    sections.push("### Metrics");
    for (const metric of metrics) {
      sections.push(formatMetric(metric));
    }
  }

  // Glossary (always include — important for disambiguation)
  if (glossary.length > 0) {
    sections.push("");
    sections.push("### Glossary");
    for (const term of glossary) {
      sections.push(formatGlossaryTerm(term));
    }
  }

  const index = sections.join("\n");

  const tokenEstimate = Math.ceil(index.length / CHARS_PER_TOKEN);
  log.info(
    {
      entityCount: entities.length,
      metricCount: metrics.length,
      glossaryTermCount: glossary.length,
      indexChars: index.length,
      tokenEstimate,
      mode,
    },
    "Semantic index built (%d entities, ~%dk tokens)",
    entities.length,
    Math.round(tokenEstimate / 1000),
  );

  return index;
}

// --- Formatters ---

function formatEntity(
  entity: ParsedEntity,
  full: boolean,
  catalog: ParsedCatalog | null,
): string {
  const lines: string[] = [];
  const conn = entity.connection ? ` [${entity.connection}]` : "";
  const entityType = entity.type ? ` (${entity.type})` : "";

  lines.push(`**${entity.table}**${entityType}${conn}`);

  if (entity.description) {
    // Truncate long descriptions
    const desc =
      entity.description.length > 200
        ? entity.description.slice(0, 197) + "..."
        : entity.description;
    lines.push(desc);
  }

  if (entity.grain) {
    lines.push(`Grain: ${entity.grain}`);
  }

  // Catalog use_for hints
  const catalogEntry = catalog?.entities?.find(
    (e) => e.name === entity.name || e.name === entity.table,
  );
  if (catalogEntry?.use_for && catalogEntry.use_for.length > 0) {
    lines.push(`Use for: ${catalogEntry.use_for.join("; ")}`);
  }

  if (full) {
    // Full mode: list all columns with types
    if (entity.dimensions && entity.dimensions.length > 0) {
      lines.push("Columns:");
      for (const dim of entity.dimensions) {
        const name = dim.name ?? dim.sql ?? "?";
        const type = dim.type ?? "unknown";
        const pk = dim.primary_key ? " PK" : "";
        const desc = dim.description ? ` — ${dim.description}` : "";
        lines.push(`  - ${name} (${type}${pk})${desc}`);
      }
    }

    // Measures
    if (entity.measures && entity.measures.length > 0) {
      lines.push("Measures:");
      for (const m of entity.measures) {
        const name = m.name ?? "?";
        const agg = m.aggregation ?? m.type ?? "";
        const desc = m.description ? ` — ${m.description}` : "";
        lines.push(`  - ${name} [${agg}]${desc}`);
      }
    }

    // Joins
    if (entity.joins && entity.joins.length > 0) {
      lines.push("Joins:");
      for (const j of entity.joins) {
        const target = j.target_entity ?? "?";
        const rel = j.relationship ?? "?";
        lines.push(`  - → ${target} (${rel})`);
      }
    }

    // Query patterns (just names — agent can explore for full SQL)
    if (entity.query_patterns && entity.query_patterns.length > 0) {
      const patternNames = entity.query_patterns
        .map((p) => p.name ?? p.description)
        .filter(Boolean);
      if (patternNames.length > 0) {
        lines.push(`Query patterns: ${patternNames.join(", ")}`);
      }
    }
  } else {
    // Summary mode: column count + key columns only
    const dims = entity.dimensions ?? [];
    const pks = dims.filter((d) => d.primary_key);
    const colCount = dims.length;
    const measureCount = entity.measures?.length ?? 0;
    const joinCount = entity.joins?.length ?? 0;

    const parts: string[] = [`${colCount} columns`];
    if (pks.length > 0)
      parts.push(`PK: ${pks.map((p) => p.name ?? p.sql).join(", ")}`);
    if (measureCount > 0) parts.push(`${measureCount} measures`);
    if (joinCount > 0)
      parts.push(
        `joins: ${entity.joins!.map((j) => j.target_entity).join(", ")}`,
      );
    lines.push(parts.join(" | "));
  }

  return lines.join("\n");
}

function formatMetric(metric: ParsedMetric): string {
  const name = metric.name ?? "unnamed";
  const desc = metric.description ? ` — ${metric.description}` : "";
  const entity = metric.entity ? ` (${metric.entity})` : "";
  return `- **${name}**${entity}${desc}`;
}

function formatGlossaryTerm(term: GlossaryTerm): string {
  const name = term.term ?? "?";
  const status = term.status === "ambiguous" ? " **[AMBIGUOUS]**" : "";
  const def = term.definition ? `: ${term.definition}` : "";
  const disambig = term.disambiguation
    ? ` → ${term.disambiguation}`
    : "";
  return `- **${name}**${status}${def}${disambig}`;
}

// --- Loaders ---

function loadEntities(semanticRoot: string): ParsedEntity[] {
  const entities: ParsedEntity[] = [];

  // Default entities
  loadEntitiesFromDir(path.join(semanticRoot, "entities"), entities);

  // Per-source subdirectories
  if (fs.existsSync(semanticRoot)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(semanticRoot, { withFileTypes: true });
    } catch (err) {
      log.warn({ semanticRoot, err: err instanceof Error ? err.message : String(err) }, "Failed to scan semantic root for per-source entity directories");
      return entities;
    }
    const reserved = new Set(["entities", "metrics"]);
    for (const entry of entries) {
      if (!entry.isDirectory() || reserved.has(entry.name)) continue;
      const subEntities = path.join(semanticRoot, entry.name, "entities");
      if (fs.existsSync(subEntities)) {
        loadEntitiesFromDir(subEntities, entities, entry.name);
      }
    }
  }

  return entities;
}

function loadEntitiesFromDir(
  dir: string,
  out: ParsedEntity[],
  connectionId?: string,
): void {
  if (!fs.existsSync(dir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn({ dir, err: err instanceof Error ? err.message : String(err) }, "Failed to read entities directory for semantic index");
    return;
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const raw = yaml.load(content) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object" || !raw.table) continue;

      const entity: ParsedEntity = {
        name: raw.name as string | undefined,
        table: raw.table as string,
        type: raw.type as string | undefined,
        connection: (raw.connection as string | undefined) ?? connectionId,
        grain: raw.grain as string | undefined,
        description: raw.description as string | undefined,
        dimensions: Array.isArray(raw.dimensions) ? (raw.dimensions as EntityDimension[]) : undefined,
        measures: Array.isArray(raw.measures) ? (raw.measures as EntityMeasure[]) : undefined,
        joins: Array.isArray(raw.joins) ? (raw.joins as EntityJoin[]) : undefined,
        query_patterns: Array.isArray(raw.query_patterns) ? (raw.query_patterns as EntityQueryPattern[]) : undefined,
      };
      out.push(entity);
    } catch (err) {
      log.warn({ file, dir, err: err instanceof Error ? err.message : String(err) }, "Skipping entity file in semantic index — failed to read or parse");
    }
  }
}

function loadMetrics(semanticRoot: string): ParsedMetric[] {
  const metrics: ParsedMetric[] = [];

  // Default metrics
  loadMetricsFromDir(path.join(semanticRoot, "metrics"), metrics);

  // Per-source subdirectories
  if (fs.existsSync(semanticRoot)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(semanticRoot, { withFileTypes: true });
    } catch (err) {
      log.warn({ semanticRoot, err: err instanceof Error ? err.message : String(err) }, "Failed to scan semantic root for per-source metric directories");
      return metrics;
    }
    const reserved = new Set(["entities", "metrics"]);
    for (const entry of entries) {
      if (!entry.isDirectory() || reserved.has(entry.name)) continue;
      const subMetrics = path.join(semanticRoot, entry.name, "metrics");
      if (fs.existsSync(subMetrics)) {
        loadMetricsFromDir(subMetrics, metrics);
      }
    }
  }

  return metrics;
}

function loadMetricsFromDir(dir: string, out: ParsedMetric[]): void {
  if (!fs.existsSync(dir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn({ dir, err: err instanceof Error ? err.message : String(err) }, "Failed to read metrics directory for semantic index");
    return;
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const raw = yaml.load(content) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") continue;

      // Metric files may contain a top-level array of metrics or a single metric
      if (Array.isArray(raw.metrics)) {
        for (const m of raw.metrics as ParsedMetric[]) {
          if (m && typeof m === "object") out.push(m);
        }
      } else if (raw.name) {
        out.push(raw as ParsedMetric);
      }
    } catch (err) {
      log.warn({ file, dir, err: err instanceof Error ? err.message : String(err) }, "Skipping metric file in semantic index — failed to read or parse");
    }
  }
}

function loadGlossary(semanticRoot: string): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];

  // Try root glossary
  loadGlossaryFile(path.join(semanticRoot, "glossary.yml"), terms);

  // Per-source glossaries
  if (fs.existsSync(semanticRoot)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(semanticRoot, { withFileTypes: true });
    } catch (err) {
      log.warn({ semanticRoot, err: err instanceof Error ? err.message : String(err) }, "Failed to scan semantic root for per-source glossary files");
      return terms;
    }
    const reserved = new Set(["entities", "metrics"]);
    for (const entry of entries) {
      if (!entry.isDirectory() || reserved.has(entry.name)) continue;
      loadGlossaryFile(
        path.join(semanticRoot, entry.name, "glossary.yml"),
        terms,
      );
    }
  }

  return terms;
}

function loadGlossaryFile(filePath: string, out: GlossaryTerm[]): void {
  if (!fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = yaml.load(content) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return;

    if (Array.isArray(raw.terms)) {
      for (const t of raw.terms as GlossaryTerm[]) {
        if (t && typeof t === "object") out.push(t);
      }
    }
  } catch (err) {
    log.warn({ filePath, err: err instanceof Error ? err.message : String(err) }, "Failed to load glossary file for semantic index");
  }
}

function loadCatalog(semanticRoot: string): ParsedCatalog | null {
  const catalogPath = path.join(semanticRoot, "catalog.yml");
  if (!fs.existsSync(catalogPath)) return null;

  try {
    const content = fs.readFileSync(catalogPath, "utf-8");
    return yaml.load(content) as ParsedCatalog | null;
  } catch (err) {
    log.warn({ catalogPath, err: err instanceof Error ? err.message : String(err) }, "Failed to load catalog for semantic index");
    return null;
  }
}

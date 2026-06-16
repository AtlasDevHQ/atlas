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
import { getSemanticRoot as getDefaultSemanticRoot } from "./files";
import { scanEntities, resolveEntityGroup, readGroupField, getGroupDirs } from "./scanner";
import { invalidateYamlPatternCache } from "@atlas/api/lib/learn/pattern-analyzer";

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
  virtual?: boolean;
  /**
   * Profiler cardinality stats, mirrored from the entity YAML the profiler
   * emits (`generate/yaml.ts`). Surfaced to the agent by {@link formatEntity}
   * so it can pick high-selectivity filter columns and judge when
   * `COUNT(DISTINCT …)` is cheap (#3630). Both are spread untyped from
   * `yaml.load`, so consumers type-narrow with `typeof … === "number"` before
   * formatting rather than trusting the static type.
   */
  unique_count?: number;
  null_count?: number;
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

export interface ParsedEntity {
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
  /** Canonical metric key (current shape). Older files used `name`. */
  id?: string;
  name?: string;
  description?: string;
  sql?: string;
  type?: string;
  entity?: string;
  aggregation?: string;
  unit?: string;
  /**
   * Display group for the prompt index — set ONLY for the canonical
   * `groups/<group>/` namespace so the agent can tell same-id metrics from
   * different groups apart. Flat default + legacy `<source>/` stay unlabeled
   * (exactly as before, ADR-0012/#3240).
   */
  group?: string;
}

interface GlossaryTerm {
  term?: string;
  definition?: string;
  status?: string;
  disambiguation?: string;
  /**
   * Free-text disambiguation guidance (e.g. "Appears in multiple tables — ASK
   * the user."). Object-form glossaries carry their "ask the user" guidance
   * here rather than in `disambiguation`; the lookup layer (`GlossaryTermLookup`)
   * mirrors this field. See #3277.
   */
  note?: string;
  /**
   * Candidate column mappings for an ambiguous term (e.g.
   * `["orders.status", "users.status"]`), used to spell out the choices the
   * agent should ask the user about. Mirrors `GlossaryTermLookup`. See #3277.
   */
  possible_mappings?: string[];
  /** Display group — set only for the canonical `groups/<group>/` namespace (see {@link ParsedMetric.group}). */
  group?: string;
}

interface CatalogEntry {
  name?: string;
  description?: string;
  use_for?: string[];
  common_questions?: string[];
  /**
   * Resolved Connection group of the catalog this entry came from (`"default"`
   * for the flat root). Stamped by {@link loadCatalog} so a merged multi-group
   * catalog applies each entry's hints only to its own group's entity, never
   * across groups (ADR-0012, #3240).
   */
  group?: string;
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

  const root = semanticRoot ?? getDefaultSemanticRoot();
  _cachedIndex = buildSemanticIndex(root);
  return _cachedIndex;
}

/** Returns the entity count from the last index build. */
export function getIndexedEntityCount(): number {
  return _cachedEntityCount;
}

/** Clear the cached index (called on semantic layer changes). Also drops the
 *  learned-pattern dedup cache, which is derived from the same entity YAMLs'
 *  `query_patterns` — otherwise a freshly-added pattern would keep being
 *  proposed as "novel" until that cache's TTL expires (#3614). */
export function invalidateSemanticIndex(): void {
  _cachedIndex = null;
  _cachedEntityCount = 0;
  invalidateYamlPatternCache();
}

export interface SemanticIndexStats {
  entities: number;
  dimensions: number;
  measures: number;
  metrics: number;
  glossaryTerms: number;
  keywords: number;
}

/** Collect stats from the semantic layer without building the full index text. */
export function getSemanticIndexStats(semanticRoot: string): SemanticIndexStats {
  const entities = loadEntities(semanticRoot);
  const metrics = loadMetrics(semanticRoot);
  const glossary = loadGlossary(semanticRoot);

  let dimensionCount = 0;
  let measureCount = 0;
  const keywords = new Set<string>();

  for (const e of entities) {
    const dims = e.dimensions ?? [];
    const meas = e.measures ?? [];
    dimensionCount += dims.length;
    measureCount += meas.length;

    if (e.table) keywords.add(e.table.toLowerCase());
    if (e.name) keywords.add(e.name.toLowerCase());
    for (const d of dims) {
      if (d.name) keywords.add(d.name.toLowerCase());
    }
    for (const m of meas) {
      if (m.name) keywords.add(m.name.toLowerCase());
    }
  }

  for (const m of metrics) {
    if (m.name) keywords.add(m.name.toLowerCase());
  }

  for (const t of glossary) {
    if (t.term) keywords.add(t.term.toLowerCase());
  }

  return {
    entities: entities.length,
    dimensions: dimensionCount,
    measures: measureCount,
    metrics: metrics.length,
    glossaryTerms: glossary.length,
    keywords: keywords.size,
  };
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

/**
 * Build the per-dimension cardinality fragments the agent uses to pick
 * high-selectivity filters and judge `COUNT(DISTINCT …)` cost (#3630).
 *
 * Returns an ordered fragment list (never a joined string) so callers control
 * spacing per mode, and so slice A-2 (#3634) can append an index marker
 * (e.g. `"indexed"`) without reshaping the formatters. Empty when the
 * dimension carries no profiled stats.
 *
 * `unique_count` / `null_count` are spread untyped from `yaml.load`, so each is
 * narrowed with `typeof … === "number"` here rather than trusting the static
 * type. `null_count` is omitted entirely by the profiler when zero, so an
 * explicit `0` (or a finite count) is the only thing worth surfacing; we report
 * the absolute count rather than a percentage because the per-dimension stats
 * carry no row total to divide by.
 */
function cardinalityFragments(dim: EntityDimension): string[] {
  const fragments: string[] = [];
  if (typeof dim.unique_count === "number" && dim.unique_count >= 0) {
    fragments.push(`~${dim.unique_count} distinct`);
  }
  if (typeof dim.null_count === "number" && dim.null_count >= 0) {
    fragments.push(dim.null_count === 0 ? "no nulls" : `${dim.null_count} null`);
  }
  return fragments;
}

// Exported for unit testing the cardinality markers (#3630) as a pure
// function over in-memory entity objects, without touching the YAML loader.
export function formatEntity(
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

  // Catalog use_for hints — match on entity name/table AND the resolved group,
  // so a merged multi-group catalog never leaks one group's hints onto another
  // group's same-named entity (#3240). `entity.connection` is the entity's
  // resolved group (undefined for the default group).
  const entityGroup = entity.connection ?? "default";
  const catalogEntry = catalog?.entities?.find(
    (e) =>
      (e.name === entity.name || e.name === entity.table) &&
      (e.group ?? "default") === entityGroup,
  );
  if (catalogEntry?.use_for && catalogEntry.use_for.length > 0) {
    lines.push(`Use for: ${catalogEntry.use_for.join("; ")}`);
  }

  if (full) {
    // Full mode: list all columns with types
    if (entity.dimensions && entity.dimensions.length > 0) {
      const realCols = entity.dimensions.filter((d) => !d.virtual);
      const virtualCols = entity.dimensions.filter((d) => d.virtual);

      if (realCols.length > 0) {
        lines.push("Columns:");
        for (const dim of realCols) {
          const name = dim.name ?? dim.sql ?? "?";
          const type = dim.type ?? "unknown";
          const pk = dim.primary_key ? " PK" : "";
          const desc = dim.description ? ` — ${dim.description}` : "";
          const card = cardinalityFragments(dim);
          const cardSuffix = card.length > 0 ? `, ${card.join(", ")}` : "";
          lines.push(`  - ${name} (${type}${pk}${cardSuffix})${desc}`);
        }
      }

      if (virtualCols.length > 0) {
        lines.push("Virtual columns (NOT real columns — use the SQL expression inline):");
        for (const dim of virtualCols) {
          const name = dim.name ?? "?";
          const type = dim.type ?? "unknown";
          const desc = dim.description ? ` — ${dim.description}` : "";
          const sql = dim.sql ? ` sql: ${dim.sql.replace(/\n/g, " ")}` : "";
          lines.push(`  - ${name} (${type})${desc}${sql}`);
        }
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

    // Compact cardinality form: distinct counts for profiled real columns, so
    // the agent can still spot high-selectivity filters in large layers without
    // the full per-column listing (#3630). Capped so a wide table can't blow up
    // the summary line.
    const cardCols = dims
      .filter(
        (d) =>
          !d.virtual &&
          typeof d.unique_count === "number" &&
          d.unique_count >= 0,
      )
      .map((d) => `${d.name ?? d.sql ?? "?"}(~${d.unique_count})`);
    if (cardCols.length > 0) {
      const CARD_CAP = 8;
      const shown = cardCols.slice(0, CARD_CAP).join(", ");
      const overflow =
        cardCols.length > CARD_CAP ? `, +${cardCols.length - CARD_CAP} more` : "";
      parts.push(`cardinality: ${shown}${overflow}`);
    }

    if (measureCount > 0) parts.push(`${measureCount} measures`);
    if (joinCount > 0)
      parts.push(
        `joins: ${(entity.joins ?? []).map((j) => j.target_entity).join(", ")}`,
      );
    lines.push(parts.join(" | "));
  }

  return lines.join("\n");
}

function formatMetric(metric: ParsedMetric): string {
  const name = metric.name ?? metric.id ?? "unnamed";
  const desc = metric.description ? ` — ${metric.description}` : "";
  const entity = metric.entity ? ` (${metric.entity})` : "";
  const group = metric.group ? ` [${metric.group}]` : "";
  return `- **${name}**${entity}${desc}${group}`;
}

function formatGlossaryTerm(term: GlossaryTerm): string {
  const name = term.term ?? "?";
  const status = term.status === "ambiguous" ? " **[AMBIGUOUS]**" : "";
  const def = term.definition ? `: ${term.definition}` : "";
  const disambig = term.disambiguation
    ? ` → ${term.disambiguation}`
    : "";
  // Object-form glossaries carry their disambiguation guidance in
  // `note`/`possible_mappings` rather than `disambiguation`; surface both so the
  // index carries the same disambiguation fields the searchGlossary tool returns
  // (#3277). The runtime Array.isArray + string filter guards malformed input:
  // these fields are spread untyped from yaml.load, so the static `string[]`
  // type can't be trusted here (mirrors parseGlossaryTerm in lookups.ts).
  const note = term.note ? ` → ${term.note}` : "";
  const mappingCandidates = Array.isArray(term.possible_mappings)
    ? term.possible_mappings.filter(
        (m): m is string => typeof m === "string" && m.trim().length > 0,
      )
    : [];
  // Gate on the filtered candidates, not the raw array — an all-non-string or
  // all-blank `possible_mappings` must emit no clause, never a bare "(maps to: )".
  const mappings =
    mappingCandidates.length > 0
      ? ` (maps to: ${mappingCandidates.join(", ")})`
      : "";
  const group = term.group ? ` [${term.group}]` : "";
  return `- **${name}**${status}${def}${disambig}${note}${mappings}${group}`;
}

// --- Loaders ---

function loadEntities(semanticRoot: string): ParsedEntity[] {
  const { entities: scanned } = scanEntities(semanticRoot);

  return scanned
    .filter(({ raw }) => raw.table)
    .map(({ sourceName, origin, raw }) => {
      // Label the prompt-index scope with the resolved Connection group
      // (ADR-0012), so the agent's view matches how the whitelist partitions
      // — e.g. a flat-root entity with `group: crm` is shown as `[crm]`,
      // never unscoped. The default group stays unlabeled.
      const group = resolveEntityGroup(sourceName, origin, readGroupField(raw)).group;
      return {
        name: raw.name as string | undefined,
        table: raw.table as string,
        type: raw.type as string | undefined,
        connection: group !== "default" ? group : undefined,
        grain: raw.grain as string | undefined,
        description: raw.description as string | undefined,
        dimensions: Array.isArray(raw.dimensions) ? (raw.dimensions as EntityDimension[]) : undefined,
        measures: Array.isArray(raw.measures) ? (raw.measures as EntityMeasure[]) : undefined,
        joins: Array.isArray(raw.joins) ? (raw.joins as EntityJoin[]) : undefined,
        query_patterns: Array.isArray(raw.query_patterns) ? (raw.query_patterns as EntityQueryPattern[]) : undefined,
      };
    });
}

function loadMetrics(semanticRoot: string): ParsedMetric[] {
  const metrics: ParsedMetric[] = [];

  // Layout-aware traversal (ADR-0012): flat default `metrics/`, the canonical
  // `groups/<group>/metrics/` namespace, and legacy `<source>/metrics/` all
  // feed the index through the shared scanner. Only canonical groups/ metrics
  // carry a display group label; flat + legacy stay unlabeled (as before).
  for (const { dir, group, origin } of getGroupDirs(semanticRoot, "metrics").dirs) {
    loadMetricsFromDir(dir, origin === "group" ? group : undefined, metrics);
  }

  return metrics;
}

function loadMetricsFromDir(dir: string, displayGroup: string | undefined, out: ParsedMetric[]): void {
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

      // Metric files may contain a top-level array of metrics or a single
      // metric, keyed by the canonical `id:` (current shape) or legacy `name:`.
      if (Array.isArray(raw.metrics)) {
        for (const m of raw.metrics as ParsedMetric[]) {
          if (m && typeof m === "object") out.push({ ...m, group: displayGroup });
        }
      } else if (raw.name || raw.id) {
        out.push({ ...(raw as ParsedMetric), group: displayGroup });
      }
    } catch (err) {
      log.warn({ file, dir, err: err instanceof Error ? err.message : String(err) }, "Skipping metric file in semantic index — failed to read or parse");
    }
  }
}

function loadGlossary(semanticRoot: string): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];

  // Flat default root, the canonical groups/<group>/ namespace, and legacy
  // <source>/ all surface glossary.yml through the shared scanner (ADR-0012).
  // Only canonical groups/ terms carry a display group label; flat + legacy
  // stay unlabeled (as before).
  for (const { dir, group, origin } of getGroupDirs(semanticRoot, null).dirs) {
    loadGlossaryFile(path.join(dir, "glossary.yml"), origin === "group" ? group : undefined, terms);
  }

  return terms;
}

function loadGlossaryFile(filePath: string, displayGroup: string | undefined, out: GlossaryTerm[]): void {
  if (!fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = yaml.load(content) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return;

    // Supports both shapes: array form `terms: [{ term, ... }]` (legacy) and
    // object form `terms: { name: { ... } }` (current) — the latter is the
    // common case for grouped glossaries, so the index must handle it too.
    if (Array.isArray(raw.terms)) {
      for (const t of raw.terms as GlossaryTerm[]) {
        if (t && typeof t === "object") out.push({ ...t, group: displayGroup });
      }
    } else if (raw.terms && typeof raw.terms === "object") {
      for (const [term, value] of Object.entries(raw.terms as Record<string, unknown>)) {
        if (value && typeof value === "object") out.push({ term, ...(value as GlossaryTerm), group: displayGroup });
      }
    }
  } catch (err) {
    log.warn({ filePath, err: err instanceof Error ? err.message : String(err) }, "Failed to load glossary file for semantic index");
  }
}

function loadCatalog(semanticRoot: string): ParsedCatalog | null {
  // Merge catalog.yml across the flat default root, the canonical
  // groups/<group>/ namespace, and legacy <source>/ (ADR-0012) so per-group
  // `use_for` hints reach the index. The index keys catalog entries by entity
  // name, so concatenating their `entities[]` is the natural merge. On a
  // name collision across groups the lookup is first-wins (acceptable — entity
  // names don't collide across groups in practice).
  const merged: CatalogEntry[] = [];
  let version: string | undefined;
  let found = false;

  for (const { dir, group, origin } of getGroupDirs(semanticRoot, null).dirs) {
    const catalogPath = path.join(dir, "catalog.yml");
    if (!fs.existsSync(catalogPath)) continue;
    try {
      const content = fs.readFileSync(catalogPath, "utf-8");
      const parsed = yaml.load(content);
      if (!parsed || typeof parsed !== "object") continue;
      const rec = parsed as Record<string, unknown>;
      found = true;
      if (version === undefined && typeof rec.version === "string") version = rec.version;
      if (!Array.isArray(rec.entities)) continue;
      // Stamp each entry with the catalog's resolved group so formatEntity can
      // scope hints to the matching group (directory canonical; a file-level
      // group:/connection: can override on flat/legacy layouts, ADR-0012).
      const catalogGroup = resolveEntityGroup(group, origin, readGroupField(rec)).group;
      for (const entry of rec.entities as CatalogEntry[]) {
        merged.push({ ...entry, group: catalogGroup });
      }
    } catch (err) {
      log.warn({ catalogPath, err: err instanceof Error ? err.message : String(err) }, "Failed to load catalog for semantic index");
    }
  }

  if (!found) return null;
  return { version, entities: merged };
}

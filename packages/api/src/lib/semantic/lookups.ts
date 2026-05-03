/**
 * Semantic-layer lookup helpers used by the typed MCP tools (#2020).
 *
 * Provides public lookup-by-id helpers for entities, glossary terms, and
 * metrics. The existing scanners and search-index loaders are scan-and-
 * format helpers — these are scan-and-find helpers consumed by tool wrappers
 * (MCP today, agent tools later) that need a typed shape, not formatted
 * prose. All loaders are read-only and stay within the resolved semantic
 * root via the existing scanner traversal.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { createLogger } from "@atlas/api/lib/logger";
import { getSemanticRoot, isValidEntityName } from "./files";
import { RESERVED_DIRS, scanEntities, readEntityYaml, getEntityDirs } from "./scanner";

const log = createLogger("semantic-lookups");

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface EntityListEntry {
  /** Display name — `name` field if present, otherwise the table name. */
  name: string;
  table: string;
  description: string;
  /** Source name: `"default"` for root `entities/`, subdir name otherwise. */
  source: string;
}

/**
 * List entities available in the semantic layer. Optional `filter` is a
 * case-insensitive substring match against name, table, and description.
 */
export function listEntities(
  opts: { filter?: string; semanticRoot?: string } = {},
): EntityListEntry[] {
  const root = opts.semanticRoot ?? getSemanticRoot();
  const { entities } = scanEntities(root);
  const filter = opts.filter?.trim().toLowerCase() ?? "";

  const results: EntityListEntry[] = [];
  for (const { sourceName, raw } of entities) {
    if (typeof raw.table !== "string" || !raw.table) continue;

    const name =
      typeof raw.name === "string" && raw.name ? raw.name : raw.table;
    const description =
      typeof raw.description === "string" ? raw.description : "";
    const entry: EntityListEntry = {
      name,
      table: raw.table,
      description,
      source: sourceName,
    };

    if (filter) {
      const haystack = `${name}\n${entry.table}\n${description}`.toLowerCase();
      if (!haystack.includes(filter)) continue;
    }

    results.push(entry);
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find a specific entity by `name` (or `table`, fallback) and return its
 * full parsed YAML. Returns `null` when not found. Rejects names with path
 * separators or `..` to defend against directory traversal.
 */
export function getEntityByName(
  name: string,
  opts: { semanticRoot?: string } = {},
): Record<string, unknown> | null {
  if (!isValidEntityName(name)) return null;

  const root = opts.semanticRoot ?? getSemanticRoot();

  // Try direct file match first (entity file basename matches entity name).
  for (const { dir } of getEntityDirs(root).dirs) {
    const file = path.join(dir, `${name}.yml`);
    if (fs.existsSync(file)) {
      const parsed = readEntityYaml(file);
      if (parsed) return parsed;
    }
  }

  // Fall back to scanning by `name` or `table` field (entity files don't
  // always match their semantic name — `users.yml` may declare `name: User`).
  const { entities } = scanEntities(root);
  for (const { raw } of entities) {
    if (raw.name === name || raw.table === name) return raw;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

export interface GlossaryTerm {
  term: string;
  status: string | null;
  definition: string | null;
  note: string | null;
  possible_mappings: string[];
  source: string;
}

/**
 * Load all glossary terms from `glossary.yml` and per-source glossaries.
 *
 * Supports both glossary YAML shapes:
 * - Object form: `terms: { name: { status, definition, ... } }` (current)
 * - Array form:  `terms: [{ term: "name", status, ... }]` (legacy)
 */
export function loadGlossaryTerms(
  opts: { semanticRoot?: string } = {},
): GlossaryTerm[] {
  const root = opts.semanticRoot ?? getSemanticRoot();
  const out: GlossaryTerm[] = [];

  loadGlossaryFile(path.join(root, "glossary.yml"), "default", out);

  if (fs.existsSync(root)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      log.warn(
        { root, err: err instanceof Error ? err.message : String(err) },
        "Failed to scan semantic root for per-source glossaries",
      );
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
      loadGlossaryFile(
        path.join(root, entry.name, "glossary.yml"),
        entry.name,
        out,
      );
    }
  }

  return out;
}

/** Case-insensitive substring search over `term`, `definition`, and `note`. */
export function searchGlossary(
  query: string,
  opts: { semanticRoot?: string } = {},
): GlossaryTerm[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return loadGlossaryTerms(opts).filter((t) => {
    const haystack = [
      t.term,
      t.definition ?? "",
      t.note ?? "",
      ...t.possible_mappings,
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(q);
  });
}

function loadGlossaryFile(
  filePath: string,
  source: string,
  out: GlossaryTerm[],
): void {
  if (!fs.existsSync(filePath)) return;

  let raw: unknown;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    raw = yaml.load(content);
  } catch (err) {
    log.warn(
      { filePath, err: err instanceof Error ? err.message : String(err) },
      "Failed to load glossary file",
    );
    return;
  }

  if (!raw || typeof raw !== "object") return;
  const terms = (raw as { terms?: unknown }).terms;
  if (!terms) return;

  if (Array.isArray(terms)) {
    for (const t of terms) {
      const normalized = normalizeGlossaryEntry(t, source);
      if (normalized) out.push(normalized);
    }
    return;
  }

  if (typeof terms === "object") {
    for (const [key, value] of Object.entries(terms as Record<string, unknown>)) {
      const normalized = normalizeGlossaryEntry(value, source, key);
      if (normalized) out.push(normalized);
    }
  }
}

function normalizeGlossaryEntry(
  raw: unknown,
  source: string,
  key?: string,
): GlossaryTerm | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const term = (typeof r.term === "string" && r.term) || key;
  if (!term) return null;

  const possibleMappingsRaw = r.possible_mappings;
  const possible_mappings = Array.isArray(possibleMappingsRaw)
    ? possibleMappingsRaw.filter((m): m is string => typeof m === "string")
    : [];

  return {
    term,
    status: typeof r.status === "string" ? r.status : null,
    definition: typeof r.definition === "string" ? r.definition : null,
    note: typeof r.note === "string" ? r.note : null,
    possible_mappings,
    source,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface MetricDefinition {
  /** Canonical id used for runMetric lookup. */
  id: string;
  label: string | null;
  description: string | null;
  /** Authoritative SQL — used as-is. */
  sql: string;
  type: string | null;
  aggregation: string | null;
  unit: string | null;
  source: string;
  /** Optional source binding (entity + measure). */
  binding: { entity?: string; measure?: string } | null;
}

/** Load every metric defined under `metrics/` (default + per-source). */
export function loadMetricDefinitions(
  opts: { semanticRoot?: string } = {},
): MetricDefinition[] {
  const root = opts.semanticRoot ?? getSemanticRoot();
  const out: MetricDefinition[] = [];

  loadMetricsFromDir(path.join(root, "metrics"), "default", out);

  if (fs.existsSync(root)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      log.warn(
        { root, err: err instanceof Error ? err.message : String(err) },
        "Failed to scan semantic root for per-source metric directories",
      );
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
      loadMetricsFromDir(
        path.join(root, entry.name, "metrics"),
        entry.name,
        out,
      );
    }
  }

  return out;
}

/** Find a metric by `id`. Returns `null` when not found. */
export function findMetricById(
  id: string,
  opts: { semanticRoot?: string } = {},
): MetricDefinition | null {
  if (!id || typeof id !== "string") return null;
  return loadMetricDefinitions(opts).find((m) => m.id === id) ?? null;
}

function loadMetricsFromDir(
  dir: string,
  source: string,
  out: MetricDefinition[],
): void {
  if (!fs.existsSync(dir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn(
      { dir, err: err instanceof Error ? err.message : String(err) },
      "Failed to read metrics directory",
    );
    return;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    let raw: unknown;
    try {
      raw = yaml.load(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      log.warn(
        { filePath, err: err instanceof Error ? err.message : String(err) },
        "Failed to read or parse metric file",
      );
      continue;
    }

    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;

    if (Array.isArray(r.metrics)) {
      for (const m of r.metrics) {
        const def = normalizeMetric(m, source);
        if (def) out.push(def);
      }
    } else {
      const def = normalizeMetric(r, source);
      if (def) out.push(def);
    }
  }
}

function normalizeMetric(raw: unknown, source: string): MetricDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // `id` is the canonical key. Older shapes used `name` — accept either,
  // prefer `id` when both are present.
  const id =
    (typeof r.id === "string" && r.id) ||
    (typeof r.name === "string" && r.name) ||
    null;
  if (!id) return null;

  const sql = typeof r.sql === "string" ? r.sql : "";
  if (!sql) return null;

  let binding: MetricDefinition["binding"] = null;
  if (r.source && typeof r.source === "object") {
    const s = r.source as Record<string, unknown>;
    const entity = typeof s.entity === "string" ? s.entity : undefined;
    const measure = typeof s.measure === "string" ? s.measure : undefined;
    if (entity || measure) binding = { entity, measure };
  }

  return {
    id,
    label: typeof r.label === "string" ? r.label : null,
    description: typeof r.description === "string" ? r.description : null,
    sql,
    type: typeof r.type === "string" ? r.type : null,
    aggregation: typeof r.aggregation === "string" ? r.aggregation : null,
    unit: typeof r.unit === "string" ? r.unit : null,
    source,
    binding,
  };
}

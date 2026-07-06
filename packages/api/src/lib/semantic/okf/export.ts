/**
 * Atlas semantic layer -> OKF bundle (#4140 spike).
 *
 * Emits a conformant OKF v0.1 bundle: one concept doc per entity /
 * metric / glossary term, index.md navigation files, and prose bodies an
 * OKF consumer can read without knowing Atlas exists. Every concept also
 * carries the full source object under the `atlas:` frontmatter extension
 * (spec-legal — consumers must preserve unknown keys), which makes an
 * Atlas -> OKF -> Atlas re-import lossless for entity and glossary
 * OBJECTS and for metric fields (the importer re-stamps metrics
 * unverified — authority never travels through a bundle). Catalog
 * description and metric file layout are NOT preserved across the trip.
 *
 * What is semantically DROPPED for foreign consumers (data preserved in the
 * extension, semantics not enforceable):
 * - the table whitelist (entity existence survives; runtime enforcement doesn't)
 * - pinned-metric authority (SQL becomes illustrative prose to other tools)
 * - glossary `status: ambiguous` ask-first agent gating
 * Each is recorded in the mapping report so `okf export` can print it.
 */

import * as yaml from "js-yaml";
import { OKF_INDEX_BASENAME, OKF_VERSION } from "@atlas/okf-bundle/wire";
import { serializeDocument } from "./frontmatter";
import {
  emptyReport,
  type MappingReport,
  type InteropFile,
  type OkfExportResult,
  type OkfFrontmatter,
} from "./types";

export interface OkfExportOptions {
  /** ISO-8601 timestamp stamped on every concept (caller supplies the clock). */
  timestamp: string;
  /** Bundle display name for the root index; defaults to the catalog name, then `atlas-export`. */
  bundleName?: string;
}

interface NormalizedDimension {
  name: string;
  sql?: string;
  type?: string;
  description?: string;
  primary_key?: boolean;
  virtual?: boolean;
  sample_values?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Narrow one raw dimension record onto the fields the renderer reads. */
function toDimension(name: string, d: Record<string, unknown>): NormalizedDimension {
  return {
    name,
    sql: asString(d.sql),
    type: asString(d.type),
    description: asString(d.description),
    primary_key: d.primary_key === true,
    virtual: d.virtual === true,
    sample_values: Array.isArray(d.sample_values) ? d.sample_values : undefined,
  };
}

/** Entity `dimensions` come in two on-disk forms: array-of-objects and name-keyed map. */
function normalizeDimensions(entity: Record<string, unknown>): NormalizedDimension[] {
  const dims = entity.dimensions;
  const out: NormalizedDimension[] = [];
  if (Array.isArray(dims)) {
    for (const d of dims) {
      if (isRecord(d) && typeof d.name === "string") out.push(toDimension(d.name, d));
    }
  } else if (isRecord(dims)) {
    for (const [name, d] of Object.entries(dims)) {
      if (isRecord(d)) out.push(toDimension(name, d));
    }
  }
  return out;
}

/** Filesystem-safe concept filename from an arbitrary display name. */
function safeFileStem(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

// ---------------------------------------------------------------------------
// Semantic-layer input parsing
// ---------------------------------------------------------------------------

interface ParsedLayer {
  /** Only entities that passed the non-empty `table` gate in {@link parseLayer}. */
  entities: Array<Record<string, unknown> & { table: string }>;
  metrics: Record<string, unknown>[];
  terms: Record<string, Record<string, unknown>>;
  catalog: Record<string, unknown> | undefined;
}

function parseLayer(files: InteropFile[], report: MappingReport): ParsedLayer {
  const layer: ParsedLayer = {
    entities: [],
    metrics: [],
    // Null prototype for the same reason as the importer: term names are
    // arbitrary user vocabulary ("constructor" is a plausible business term).
    terms: Object.create(null) as ParsedLayer["terms"],
    catalog: undefined,
  };
  for (const file of files) {
    if (!/\.ya?ml$/.test(file.path)) continue;
    let doc: unknown;
    try {
      doc = yaml.load(file.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.unmapped.push(`${file.path}: YAML parse error: ${msg}`);
      continue;
    }
    if (!isRecord(doc)) {
      report.unmapped.push(`${file.path}: not a YAML mapping`);
      continue;
    }
    const base = file.path.split("/").pop() ?? file.path;
    if (/(^|\/)entities\/[^/]+\.ya?ml$/.test(file.path)) {
      if (typeof doc.table === "string" && doc.table !== "") {
        layer.entities.push({ ...doc, table: doc.table });
      } else {
        report.unmapped.push(`${file.path}: entity file without a \`table\` field`);
      }
    } else if (/(^|\/)metrics\/[^/]+\.ya?ml$/.test(file.path)) {
      if (Array.isArray(doc.metrics)) {
        for (const m of doc.metrics) {
          if (isRecord(m)) {
            layer.metrics.push(m);
          } else {
            report.unmapped.push(`${file.path}: non-mapping entry in \`metrics\` array skipped`);
          }
        }
      } else {
        report.unmapped.push(`${file.path}: metrics file without a \`metrics\` array`);
      }
    } else if (base === "glossary.yml" || base === "glossary.yaml") {
      if (isRecord(doc.terms)) {
        for (const [name, entry] of Object.entries(doc.terms)) {
          if (!isRecord(entry)) {
            report.unmapped.push(`${file.path}: glossary term "${name}" is not a mapping — skipped`);
          } else if (Object.hasOwn(layer.terms, name)) {
            // Multi-source layers can carry several glossary.yml files.
            report.unmapped.push(
              `${file.path}: glossary term "${name}" already defined by an earlier file — skipped`,
            );
          } else {
            layer.terms[name] = entry;
          }
        }
      } else {
        report.unmapped.push(`${file.path}: glossary file without a \`terms\` mapping`);
      }
    } else if (base === "catalog.yml" || base === "catalog.yaml") {
      if (layer.catalog !== undefined) {
        report.unmapped.push(`${file.path}: a catalog file was already read — this one ignored`);
      } else {
        layer.catalog = doc;
      }
    } else {
      report.notes.push(`${file.path}: not an entity/glossary/metric/catalog file — skipped`);
    }
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Concept rendering
// ---------------------------------------------------------------------------

function renderEntityDoc(
  entity: Record<string, unknown> & { table: string },
  metricLinks: Array<{ file: string; label: string; description?: string }>,
  options: OkfExportOptions,
  report: MappingReport,
): InteropFile {
  const table = entity.table;
  const name = asString(entity.name) ?? table;
  const description = asString(entity.description) ?? "";
  const tags = ["atlas"];
  const entityType = asString(entity.type);
  if (entityType) tags.push(entityType);
  const group = asString(entity.group) ?? asString(entity.connection);
  if (group) tags.push(group);

  const frontmatter: OkfFrontmatter = {
    type: "Table",
    title: name,
    ...(description !== "" ? { description: firstLine(description) } : {}),
    tags,
    timestamp: options.timestamp,
    atlas: { kind: "table", entity },
  };

  const lines: string[] = [];
  lines.push("# Overview");
  const grain = asString(entity.grain);
  const overviewParts = [description.trim(), grain ? `Grain: ${grain}.` : ""].filter(
    (s) => s !== "",
  );
  lines.push(overviewParts.length > 0 ? overviewParts.join("\n\n") : `The \`${table}\` table.`);

  const dims = normalizeDimensions(entity);
  if (dims.length > 0) {
    lines.push("", "# Schema");
    for (const d of dims) {
      const type = (d.type ?? "unknown").toUpperCase();
      const parts: string[] = [];
      if (d.description) parts.push(d.description.trim());
      if (d.primary_key) parts.push("Primary key.");
      if (d.virtual && d.sql) parts.push(`Virtual dimension — SQL: \`${flattenSql(d.sql)}\`.`);
      if (Array.isArray(d.sample_values) && d.sample_values.length > 0) {
        parts.push(`Sample values: ${d.sample_values.map((v) => String(v)).join(", ")}.`);
      }
      lines.push(`- \`${d.name}\` (${type}): ${parts.join(" ")}`.trimEnd());
    }
  }

  const measures = Array.isArray(entity.measures) ? entity.measures.filter(isRecord) : [];
  if (measures.length > 0) {
    lines.push("", "# Measures");
    for (const m of measures) {
      const label = asString(m.name) ?? "measure";
      const agg = asString(m.type) ?? "aggregation";
      const sql = asString(m.sql) ?? "";
      const desc = asString(m.description);
      lines.push(`- \`${label}\` (${agg} of \`${sql}\`)${desc ? `: ${desc}` : ""}`);
    }
  }

  if (metricLinks.length > 0) {
    lines.push("", "# Metrics");
    for (const link of metricLinks) {
      lines.push(
        `- [${link.label}](../references/metrics/${link.file})${
          link.description ? ` — ${firstLine(link.description)}` : ""
        }`,
      );
    }
  }

  const joins = Array.isArray(entity.joins) ? entity.joins.filter(isRecord) : [];
  if (joins.length > 0) {
    lines.push("", "# Joins");
    for (const j of joins) {
      const target = asString(j.target_entity) ?? "unknown";
      const jc = isRecord(j.join_columns) ? j.join_columns : undefined;
      const condition =
        jc && typeof jc.from === "string" && typeof jc.to === "string"
          ? ` on \`${table}.${jc.from} = ${jc.to}\``
          : "";
      const rel = asString(j.relationship);
      const desc = asString(j.description);
      lines.push(
        `- ${target}${condition}${rel ? ` (${rel.replace(/_/g, " ")})` : ""}${desc ? ` — ${desc}` : ""}`,
      );
    }
  }

  const patterns = Array.isArray(entity.query_patterns)
    ? entity.query_patterns.filter(isRecord)
    : [];
  if (patterns.length > 0) {
    lines.push("", "# Example queries");
    for (const p of patterns) {
      const label = asString(p.name) ?? "query";
      lines.push("", `## ${label}`);
      const desc = asString(p.description);
      if (desc) lines.push(desc);
      const sql = asString(p.sql);
      if (sql) lines.push("", "```sql", sql.trimEnd(), "```");
    }
  }

  const useCases = Array.isArray(entity.use_cases) ? entity.use_cases : [];
  if (useCases.length > 0) {
    lines.push("", "# Use cases");
    for (const u of useCases) lines.push(`- ${String(u)}`);
  }

  if (measures.length > 0 || patterns.length > 0 || dims.some((d) => d.virtual)) {
    report.notes.push(
      `entities/${table}.yml: measures/virtual-dimension SQL/query patterns exported as prose + atlas extension (no first-class OKF concepts)`,
    );
  }

  return {
    path: `tables/${safeFileStem(table)}.md`,
    content: serializeDocument(frontmatter, lines.join("\n")),
  };
}

function renderMetricDoc(
  metric: Record<string, unknown>,
  options: OkfExportOptions,
): { file: InteropFile; stem: string; label: string; description?: string } {
  const id = asString(metric.id) ?? asString(metric.label) ?? "metric";
  const stem = safeFileStem(id);
  const label = asString(metric.label) ?? id;
  const description = asString(metric.description);

  const frontmatter: OkfFrontmatter = {
    type: "Reference",
    title: label,
    ...(description ? { description: firstLine(description) } : {}),
    tags: ["metric", "atlas"],
    timestamp: options.timestamp,
    atlas: { kind: "metric", metric },
  };

  const lines: string[] = [];
  if (description) lines.push(description.trim());
  const sql = asString(metric.sql);
  if (sql) {
    lines.push("", "```sql", sql.trimEnd(), "```");
    lines.push(
      "",
      "In Atlas this SQL is authoritative: the agent runs it verbatim when the metric is requested.",
    );
  }
  return {
    file: {
      path: `references/metrics/${stem}.md`,
      content: serializeDocument(frontmatter, lines.join("\n")),
    },
    stem,
    label,
    description,
  };
}

function renderTermDoc(
  name: string,
  entry: Record<string, unknown>,
  options: OkfExportOptions,
  report: MappingReport,
): InteropFile {
  const status = asString(entry.status) ?? "defined";
  const definition = asString(entry.definition);
  const note = asString(entry.note);
  const frontmatter: OkfFrontmatter = {
    type: "Reference",
    title: name,
    ...(definition ? { description: firstLine(definition) } : {}),
    tags: ["glossary-term", "atlas", ...(status === "ambiguous" ? ["ambiguous"] : [])],
    timestamp: options.timestamp,
    atlas: { kind: "glossary_term", term: name, entry },
  };
  const lines: string[] = [];
  if (definition) lines.push(definition.trim());
  if (note) lines.push(note.trim());
  if (status === "ambiguous") {
    const mappings = Array.isArray(entry.possible_mappings) ? entry.possible_mappings : [];
    if (mappings.length > 0) {
      lines.push("", "Possible mappings:");
      for (const m of mappings) lines.push(`- \`${String(m)}\``);
    }
    lines.push(
      "",
      "Atlas treats this term as ambiguous and asks the user which definition they mean before querying.",
    );
    report.lossy.push(
      `glossary term "${name}": status: ambiguous exported as prose — OKF consumers get no ask-first gating`,
    );
  }
  return {
    path: `references/glossary/${safeFileStem(name)}.md`,
    content: serializeDocument(frontmatter, lines.join("\n")),
  };
}

// ---------------------------------------------------------------------------
// Index files
// ---------------------------------------------------------------------------

function indexFile(path: string, heading: string, items: Array<{ href: string; label: string; description?: string }>): InteropFile {
  const lines = [`# ${heading}`];
  for (const item of items) {
    lines.push(`* [${item.label}](${item.href})${item.description ? ` - ${firstLine(item.description)}` : ""}`);
  }
  return { path, content: lines.join("\n") + "\n" };
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0].trim();
}

function flattenSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Map a semantic layer (in-memory file list) onto an OKF v0.1 bundle. */
export function exportToOkf(
  files: InteropFile[],
  options: OkfExportOptions,
): OkfExportResult {
  const report = emptyReport();
  const layer = parseLayer(files, report);
  const out: InteropFile[] = [];

  // Metrics first so entity docs can link to them (source.entity -> entity name).
  const renderedMetrics = layer.metrics.map((m) => renderMetricDoc(m, options));
  const metricLinksByEntity = new Map<string, Array<{ file: string; label: string; description?: string }>>();
  for (let i = 0; i < layer.metrics.length; i++) {
    const source = layer.metrics[i].source;
    const entityName = isRecord(source) ? asString(source.entity) : undefined;
    if (!entityName) continue;
    const link = renderedMetrics[i];
    const list = metricLinksByEntity.get(entityName) ?? [];
    list.push({ file: `${link.stem}.md`, label: link.label, description: link.description });
    metricLinksByEntity.set(entityName, list);
  }

  const entityDocs = layer.entities.map((entity) =>
    renderEntityDoc(
      entity,
      metricLinksByEntity.get(asString(entity.name) ?? entity.table) ?? [],
      options,
      report,
    ),
  );
  out.push(...entityDocs);
  out.push(...renderedMetrics.map((r) => r.file));

  const termDocs = Object.entries(layer.terms).map(([name, entry]) =>
    renderTermDoc(name, entry, options, report),
  );
  out.push(...termDocs);

  // --- index.md navigation ---
  if (entityDocs.length > 0) {
    out.push(
      indexFile(
        "tables/index.md",
        "Tables",
        layer.entities.map((e, i) => ({
          href: entityDocs[i].path.replace(/^tables\//, ""),
          label: asString(e.name) ?? e.table,
          description: asString(e.description),
        })),
      ),
    );
  }
  if (renderedMetrics.length > 0) {
    out.push(
      indexFile(
        "references/metrics/index.md",
        "Metrics",
        renderedMetrics.map((r) => ({ href: `${r.stem}.md`, label: r.label, description: r.description })),
      ),
    );
  }
  if (termDocs.length > 0) {
    out.push(
      indexFile(
        "references/glossary/index.md",
        "Glossary",
        Object.keys(layer.terms).map((name) => ({
          href: `${safeFileStem(name)}.md`,
          label: name,
        })),
      ),
    );
  }
  if (renderedMetrics.length > 0 || termDocs.length > 0) {
    const items: Array<{ href: string; label: string; description?: string }> = [];
    if (renderedMetrics.length > 0) {
      items.push({ href: "metrics/index.md", label: "metrics", description: "Metric definitions." });
    }
    if (termDocs.length > 0) {
      items.push({ href: "glossary/index.md", label: "glossary", description: "Business term definitions." });
    }
    out.push(indexFile("references/index.md", "References", items));
  }

  const bundleName =
    options.bundleName ?? (layer.catalog ? asString(layer.catalog.name) : undefined) ?? "atlas-export";
  const catalogDescription = layer.catalog ? asString(layer.catalog.description) : undefined;
  const rootItems: Array<{ href: string; label: string; description?: string }> = [];
  if (entityDocs.length > 0) {
    rootItems.push({ href: "tables/index.md", label: "tables", description: "Queryable tables." });
  }
  if (renderedMetrics.length > 0 || termDocs.length > 0) {
    rootItems.push({
      href: "references/index.md",
      label: "references",
      description: "Metric and glossary definitions.",
    });
  }
  const rootBody = [
    `# ${bundleName}`,
    ...(catalogDescription ? [firstLine(catalogDescription)] : []),
    ...rootItems.map(
      (i) => `* [${i.label}](${i.href})${i.description ? ` - ${i.description}` : ""}`,
    ),
  ].join("\n");
  // Root index.md is the one index allowed to carry frontmatter (okf_version).
  out.push({
    path: OKF_INDEX_BASENAME,
    content: `---\nokf_version: ${JSON.stringify(OKF_VERSION)}\n---\n\n${rootBody}\n`,
  });

  report.lossy.push(
    "table whitelist enforcement has no OKF equivalent — entity existence survives, runtime enforcement does not",
    "pinned-metric authority has no OKF equivalent — exported SQL is illustrative prose to non-Atlas consumers",
  );

  // safeFileStem can collide ("Q1 Revenue" vs "Q1-Revenue", case-only diffs).
  // First doc wins; the loser is reported, never silently clobbered on disk.
  const seenPaths = new Set<string>();
  const deduped: InteropFile[] = [];
  for (const file of out) {
    if (seenPaths.has(file.path)) {
      report.unmapped.push(
        `${file.path}: duplicate bundle path — a same-named concept was already emitted; this one dropped`,
      );
      continue;
    }
    seenPaths.add(file.path);
    deduped.push(file);
  }

  return { files: deduped, report };
}

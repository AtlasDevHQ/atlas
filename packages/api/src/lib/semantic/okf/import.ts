/**
 * OKF bundle -> first-draft Atlas semantic layer (#4140 spike).
 *
 * One-shot draft generator: the output is entity/glossary/metric YAML that
 * the existing scan -> enrich -> edit flow takes over. Two paths per concept:
 *
 * - **Native round-trip** — Atlas-produced bundles carry the full source
 *   object under the `atlas:` frontmatter extension (spec-legal unknown key);
 *   we restore it verbatim. Lossless.
 * - **Foreign bundle** — heuristic prose parsing of frontmatter + body
 *   sections (`# Schema` bullets/tables, sql code fences). Lossy by nature;
 *   every approximation lands in the {@link MappingReport}.
 *
 * Deliberately NOT restored/produced on import (no OKF equivalent):
 * whitelist membership beyond entity existence, metric authority (imported
 * SQL is marked unverified — Atlas runs metric SQL verbatim, so promoting
 * prose SQL silently would be an integrity hole), and glossary ambiguity
 * gating (OKF has no ask-first semantics).
 */

import * as yaml from "js-yaml";
import { safeSemanticRowName } from "../shapes";
import {
  classifyConcept,
  conceptStem,
  extractSqlBlock,
  mapColumnType,
  parseBundle,
  parseJoinEquality,
  parseSchemaColumns,
  splitSections,
} from "./parse";
import {
  emptyReport,
  type MappingReport,
  type InteropFile,
  type OkfConcept,
  type OkfImportResult,
} from "./types";

const YAML_DUMP_OPTS = { lineWidth: 120, noRefs: true } as const;

/** Provenance block attached to every imported artifact (passthrough-safe). */
function provenance(concept: OkfConcept): Record<string, unknown> {
  const p: Record<string, unknown> = { source_path: concept.path };
  if (typeof concept.frontmatter.resource === "string") {
    p.resource = concept.frontmatter.resource;
  }
  if (Array.isArray(concept.frontmatter.tags)) p.tags = concept.frontmatter.tags;
  if (typeof concept.frontmatter.timestamp === "string") {
    p.timestamp = concept.frontmatter.timestamp;
  }
  return p;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DraftEntity {
  table: string;
  obj: Record<string, unknown>;
  concept: OkfConcept;
}

export interface OkfImportOptions {
  /** Catalog display name; defaults to `okf-import`. */
  bundleName?: string;
}

/** Map an OKF bundle onto a first-draft semantic layer. */
export function importOkfBundle(
  files: InteropFile[],
  options: OkfImportOptions = {},
): OkfImportResult {
  const report = emptyReport();
  const concepts = parseBundle(files, report);

  const entities: DraftEntity[] = [];
  const metrics: Record<string, unknown>[] = [];
  const terms: Record<string, unknown> = {};
  const datasetNotes: string[] = [];
  const joinConcepts: OkfConcept[] = [];

  for (const concept of concepts) {
    switch (classifyConcept(concept)) {
      case "table": {
        const entity = importTable(concept, report);
        if (entity) entities.push(entity);
        break;
      }
      case "metric":
        metrics.push(importMetric(concept, report));
        break;
      case "join":
        joinConcepts.push(concept);
        break;
      case "glossary_term":
        importTerm(concept, terms, report);
        break;
      case "dataset": {
        const desc = concept.frontmatter.description;
        if (typeof desc === "string" && desc.trim() !== "") datasetNotes.push(desc.trim());
        report.notes.push(
          `${concept.path}: dataset concept folded into catalog description (Atlas has no dataset object)`,
        );
        break;
      }
      case "unmapped":
        report.unmapped.push(
          `${concept.path}: unrecognized concept type "${concept.frontmatter.type}" — no Atlas equivalent`,
        );
        break;
    }
  }

  attachJoins(joinConcepts, entities, report);

  const out: InteropFile[] = [];
  for (const entity of entities) {
    out.push({
      path: `entities/${entity.table}.yml`,
      content: yaml.dump(entity.obj, YAML_DUMP_OPTS),
    });
  }
  if (Object.keys(terms).length > 0) {
    out.push({
      path: "glossary.yml",
      content: yaml.dump({ terms }, YAML_DUMP_OPTS),
    });
    report.notes.push(
      "glossary terms imported as status: defined — OKF cannot express Atlas's `status: ambiguous` ask-first gating",
    );
  }
  if (metrics.length > 0) {
    const header =
      "# Imported from OKF — metric SQL below is UNVERIFIED prose from the source\n" +
      "# bundle. Atlas runs metric SQL verbatim (authoritative); review and edit each\n" +
      "# entry before relying on it. Entries carry `okf.unverified_sql: true` until then.\n";
    out.push({
      path: "metrics/okf-imported.yml",
      content: header + yaml.dump({ metrics }, YAML_DUMP_OPTS),
    });
    report.lossy.push(
      "imported metric SQL is descriptive prose in OKF, not an executable contract — marked unverified, requires human review before use",
    );
  }
  out.push({
    path: "catalog.yml",
    content: yaml.dump(
      buildCatalog(options, entities, metrics, terms, datasetNotes),
      YAML_DUMP_OPTS,
    ),
  });

  return { files: out, report };
}

function importTable(concept: OkfConcept, report: MappingReport): DraftEntity | null {
  // Native round-trip: full entity object under the atlas extension.
  const native = concept.frontmatter.atlas?.entity;
  if (isRecord(native) && typeof native.table === "string") {
    report.notes.push(`${concept.path}: restored verbatim from atlas.entity extension (lossless)`);
    return { table: native.table, obj: native, concept };
  }

  const stem = conceptStem(concept.path);
  const table = safeSemanticRowName(stem);
  if (table === null) {
    report.unmapped.push(`${concept.path}: filename stem "${stem}" is not a safe table name`);
    return null;
  }

  const sections = splitSections(concept.body);
  const overview = (sections.get("overview") ?? sections.get("") ?? "").trim();
  const fmDescription = (
    typeof concept.frontmatter.description === "string" ? concept.frontmatter.description : ""
  ).trim();
  // The frontmatter description is often the overview's first sentence —
  // don't duplicate it when the overview already covers it.
  const description =
    fmDescription !== "" && overview.includes(fmDescription)
      ? overview
      : [fmDescription, overview].filter((s) => s !== "").join("\n\n");

  const dimensions: Record<string, unknown>[] = [];
  const schemaSection = sections.get("schema");
  if (schemaSection) {
    for (const col of parseSchemaColumns(schemaSection)) {
      const mapped = mapColumnType(col.rawType);
      if (mapped === undefined) {
        report.lossy.push(
          `${concept.path}: column \`${col.name}\` (${col.rawType}) skipped — nested/repeated shapes have no scalar dimension equivalent`,
        );
        continue;
      }
      dimensions.push({
        name: col.name,
        sql: col.name,
        type: mapped,
        ...(col.description !== "" ? { description: col.description } : {}),
      });
    }
  } else {
    report.lossy.push(`${concept.path}: no # Schema section — entity drafted without dimensions`);
  }

  const obj: Record<string, unknown> = {
    name: typeof concept.frontmatter.title === "string" ? concept.frontmatter.title : stem,
    table,
    ...(description !== "" ? { description } : {}),
    dimensions,
    okf: provenance(concept),
  };
  report.notes.push(
    `${concept.path}: entity type/grain/measures not inferable from OKF prose — left for enrich/edit`,
  );
  return { table, obj, concept };
}

function importMetric(concept: OkfConcept, report: MappingReport): Record<string, unknown> {
  const native = concept.frontmatter.atlas?.metric;
  if (isRecord(native)) {
    report.notes.push(`${concept.path}: restored verbatim from atlas.metric extension (lossless)`);
    return native;
  }
  const stem = conceptStem(concept.path);
  const sql = extractSqlBlock(concept.body);
  if (sql === undefined) {
    report.lossy.push(`${concept.path}: metric has no sql code fence — imported description-only`);
  }
  return {
    id: stem,
    label: typeof concept.frontmatter.title === "string" ? concept.frontmatter.title : stem,
    ...(typeof concept.frontmatter.description === "string"
      ? { description: concept.frontmatter.description }
      : {}),
    ...(sql !== undefined ? { sql } : {}),
    okf: { ...provenance(concept), unverified_sql: true },
  };
}

function importTerm(
  concept: OkfConcept,
  terms: Record<string, unknown>,
  report: MappingReport,
): void {
  const atlasExt = concept.frontmatter.atlas;
  const nativeName = atlasExt?.term;
  const nativeEntry = atlasExt?.entry;
  if (typeof nativeName === "string" && isRecord(nativeEntry)) {
    terms[nativeName] = nativeEntry;
    report.notes.push(`${concept.path}: restored verbatim from atlas.term extension (lossless)`);
    return;
  }
  const name =
    typeof concept.frontmatter.title === "string"
      ? concept.frontmatter.title
      : conceptStem(concept.path);
  const definition =
    typeof concept.frontmatter.description === "string" &&
    concept.frontmatter.description.trim() !== ""
      ? concept.frontmatter.description.trim()
      : concept.body.trim();
  terms[name] = {
    status: "defined",
    definition,
    okf: provenance(concept),
  };
}

/** Resolve join reference concepts against imported entities where possible. */
function attachJoins(
  joinConcepts: OkfConcept[],
  entities: DraftEntity[],
  report: MappingReport,
): void {
  const byTable = new Map(entities.map((e) => [e.table.toLowerCase(), e]));
  for (const concept of joinConcepts) {
    const sql = extractSqlBlock(concept.body);
    const eq = sql !== undefined ? parseJoinEquality(sql) : undefined;
    if (!eq) {
      report.unmapped.push(
        `${concept.path}: join has no parseable left.col = right.col condition`,
      );
      continue;
    }
    const from = byTable.get(eq.fromTable.toLowerCase());
    const to = byTable.get(eq.toTable.toLowerCase());
    if (!from || !to) {
      // e.g. GA4's `GA_EVENTS.… = ADS_CLICKS.…` — prose aliases, not table names.
      report.unmapped.push(
        `${concept.path}: join condition references "${eq.fromTable}"/"${eq.toTable}" — not resolvable to imported entities (OKF join specs are prose, not typed references)`,
      );
      continue;
    }
    const joins = Array.isArray(from.obj.joins) ? (from.obj.joins as unknown[]) : [];
    joins.push({
      target_entity: String(to.obj.name ?? to.table),
      join_columns: { from: eq.fromColumn, to: eq.toColumn },
      ...(typeof concept.frontmatter.description === "string"
        ? { description: concept.frontmatter.description }
        : {}),
      okf: { source_path: concept.path },
    });
    from.obj.joins = joins;
    report.notes.push(
      `${concept.path}: join attached to ${from.table} without relationship cardinality (not expressed in OKF)`,
    );
  }
}

function buildCatalog(
  options: OkfImportOptions,
  entities: DraftEntity[],
  metrics: Record<string, unknown>[],
  terms: Record<string, unknown>,
  datasetNotes: string[],
): Record<string, unknown> {
  return {
    version: 1,
    name: options.bundleName ?? "okf-import",
    description:
      datasetNotes.length > 0
        ? datasetNotes.join("\n\n")
        : "First-draft semantic layer imported from an OKF bundle. Review via scan -> enrich -> edit.",
    entities: entities.map((e) => ({
      name: String(e.obj.name ?? e.table),
      file: `entities/${e.table}.yml`,
      ...(typeof e.obj.description === "string"
        ? { description: firstLine(e.obj.description) }
        : {}),
    })),
    ...(Object.keys(terms).length > 0 ? { glossary: "glossary.yml" } : {}),
    ...(metrics.length > 0
      ? {
          metrics: [
            {
              file: "metrics/okf-imported.yml",
              description: "Metrics imported from OKF (unverified SQL — review before use)",
            },
          ],
        }
      : {}),
  };
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0].trim();
}

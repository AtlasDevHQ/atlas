/**
 * OKF bundle -> first-draft Atlas semantic layer (#4140 spike).
 *
 * One-shot draft generator: the output is entity/glossary/metric YAML that
 * the existing scan -> enrich -> edit flow takes over. Two paths per concept:
 *
 * - **Native round-trip** — Atlas-produced bundles carry the full source
 *   object under the `atlas:` frontmatter extension (spec-legal unknown key);
 *   entity and glossary objects are restored verbatim.
 * - **Foreign bundle** — heuristic prose parsing of frontmatter + body
 *   sections (`# Schema` bullets/tables, sql code fences). Lossy by nature;
 *   every approximation lands in the {@link MappingReport}.
 *
 * Trust boundary: a bundle is third-party input regardless of what its
 * frontmatter claims, and the `atlas:` extension is trivially forgeable. So:
 * - table names are validated via `safeSemanticRowName` on BOTH paths
 *   (a native `atlas.entity.table` of `../../x` must never become a write path);
 * - **metric authority is never imported** — even `atlas.metric` restores are
 *   re-stamped `okf.unverified_sql: true`. Atlas runs metric SQL verbatim at
 *   runtime; authority is a property of the reviewed file in your repo, not
 *   of data that arrived in a bundle.
 * For foreign bundles, additionally not producible (no OKF equivalent):
 * glossary `status: ambiguous` ask-first gating, entity type/grain/measures.
 */

import * as yaml from "js-yaml";
import { safeSemanticRowName } from "../shapes";
import {
  atlasExtension,
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

/** Provenance block attached to every heuristically imported artifact (passthrough-safe). */
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
  // Case-insensitive: SAFE_TABLE_NAME admits uppercase, but entities/<t>.yml
  // lands on possibly case-insensitive filesystems (APFS/NTFS), where
  // `Orders.yml` and `orders.yml` would silently clobber. attachJoins already
  // treats table identity case-insensitively — the dedup key must match.
  const seenTables = new Set<string>();
  const metrics: Record<string, unknown>[] = [];
  const seenMetricIds = new Set<string>();
  // Null prototype: a glossary term legitimately named "constructor" or
  // "toString" must not false-positive the duplicate check via the
  // prototype chain (and `__proto__` must stay an ordinary key).
  const terms: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const datasetNotes: string[] = [];
  const joinConcepts: OkfConcept[] = [];
  let foreignTermCount = 0;

  for (const concept of concepts) {
    const kind = classifyConcept(concept);
    switch (kind) {
      case "table": {
        const entity = importTable(concept, report);
        if (!entity) break;
        if (seenTables.has(entity.table.toLowerCase())) {
          report.unmapped.push(
            `${concept.path}: duplicate table "${entity.table}" — an earlier concept already produced its entity file; this one skipped`,
          );
          break;
        }
        seenTables.add(entity.table.toLowerCase());
        entities.push(entity);
        break;
      }
      case "metric": {
        const metric = importMetric(concept, report);
        const id = typeof metric.id === "string" ? metric.id : undefined;
        // Metric SQL is looked up by id downstream — an ambiguous id is the
        // last-write-wins class this loop exists to prevent.
        if (id !== undefined && seenMetricIds.has(id)) {
          report.unmapped.push(
            `${concept.path}: duplicate metric id "${id}" — an earlier concept already defined it; this one skipped`,
          );
          break;
        }
        if (id !== undefined) seenMetricIds.add(id);
        metrics.push(metric);
        break;
      }
      case "join":
        joinConcepts.push(concept);
        break;
      case "glossary_term":
        if (importTerm(concept, terms, report) === "foreign") foreignTermCount++;
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
      default:
        kind satisfies never;
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
    if (foreignTermCount > 0) {
      report.notes.push(
        `${foreignTermCount} foreign glossary term(s) imported as status: defined — OKF cannot express Atlas's \`status: ambiguous\` ask-first gating`,
      );
    }
  }
  if (metrics.length > 0) {
    const header =
      "# Imported from OKF. A bundle cannot confer metric authority: Atlas runs metric\n" +
      "# SQL verbatim (authoritative), so every imported entry — including atlas.metric\n" +
      "# extension restores — carries `okf.unverified_sql: true`. Review and edit each\n" +
      "# entry, then remove the flag, before relying on it.\n";
    out.push({
      path: "metrics/okf-imported.yml",
      content: header + yaml.dump({ metrics }, YAML_DUMP_OPTS),
    });
    report.lossy.push(
      "metric authority cannot travel through OKF — every imported metric is marked unverified and requires human review before use",
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
  // Native round-trip: full entity object under the atlas extension. The
  // extension is untrusted input like the rest of the bundle, so the table
  // name goes through the same safeSemanticRowName gate as the heuristic
  // path — `entities/${table}.yml` becomes a write path downstream, and a
  // forged `table: "../../x"` must die here, reported, not on disk.
  const native = atlasExtension(concept)?.entity;
  if (isRecord(native) && typeof native.table === "string") {
    const table = safeSemanticRowName(native.table);
    if (table === null || table !== native.table) {
      report.unmapped.push(
        `${concept.path}: atlas.entity.table ${JSON.stringify(native.table)} is not a safe table name — extension ignored`,
      );
      return null;
    }
    report.notes.push(`${concept.path}: restored verbatim from atlas.entity extension (lossless)`);
    return { table, obj: native, concept };
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
      if (mapped.guessed) {
        report.notes.push(
          `${concept.path}: column \`${col.name}\` type "${col.rawType}" not recognized — defaulted to string`,
        );
      }
      dimensions.push({
        name: col.name,
        sql: col.name,
        type: mapped.type,
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
  const native = atlasExtension(concept)?.metric;
  if (isRecord(native)) {
    // Fields restore losslessly, but authority does not: the extension is
    // forgeable, so the SQL is re-stamped unverified like any other import.
    report.notes.push(
      `${concept.path}: metric fields restored from atlas.metric extension; SQL re-marked unverified (authority is trust, not data)`,
    );
    const okf = isRecord(native.okf) ? native.okf : {};
    return { ...native, okf: { ...okf, unverified_sql: true } };
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
): "native" | "foreign" | "skipped" {
  const ext = atlasExtension(concept);
  const nativeName = ext?.term;
  const nativeEntry = ext?.entry;
  if (typeof nativeName === "string" && isRecord(nativeEntry)) {
    if (Object.hasOwn(terms, nativeName)) {
      report.unmapped.push(`${concept.path}: duplicate glossary term "${nativeName}" — skipped`);
      return "skipped";
    }
    terms[nativeName] = nativeEntry;
    report.notes.push(`${concept.path}: restored verbatim from atlas.term extension (lossless)`);
    return "native";
  }
  const name =
    typeof concept.frontmatter.title === "string"
      ? concept.frontmatter.title
      : conceptStem(concept.path);
  if (Object.hasOwn(terms, name)) {
    report.unmapped.push(`${concept.path}: duplicate glossary term "${name}" — skipped`);
    return "skipped";
  }
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
  return "foreign";
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

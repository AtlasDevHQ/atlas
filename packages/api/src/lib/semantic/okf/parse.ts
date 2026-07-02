/**
 * OKF bundle parsing + concept classification (#4140 spike).
 *
 * Walks an in-memory file list, parses every non-reserved `.md` into an
 * {@link OkfConcept}, and classifies concepts for import using the signals
 * OKF actually provides: the free-text `type`, `tags`, and directory
 * placement. OKF is minimally opinionated (only `type` is required, and type
 * values are producer-defined prose like "BigQuery Table" or "Reference"),
 * so classification is necessarily heuristic — a headline lossiness finding
 * for the spike doc.
 */

import { parseFrontmatter } from "./frontmatter";
import type {
  MappingReport,
  OkfConcept,
  OkfConceptKind,
  OkfParsedColumn,
  InteropFile,
} from "./types";

/** Reserved OKF filenames — navigation/history, never concepts. */
const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Parse every concept doc in a bundle; malformed files land in `report.unmapped`. */
export function parseBundle(
  files: InteropFile[],
  report: MappingReport,
): OkfConcept[] {
  const concepts: OkfConcept[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".md")) continue;
    if (RESERVED_BASENAMES.has(basename(file.path))) continue;
    const parsed = parseFrontmatter(file.content);
    if (!parsed.ok) {
      report.unmapped.push(`${file.path}: ${parsed.reason}`);
      continue;
    }
    concepts.push({
      path: file.path,
      frontmatter: parsed.doc.frontmatter,
      body: parsed.doc.body,
    });
  }
  return concepts;
}

function tagsOf(concept: OkfConcept): string[] {
  const tags = concept.frontmatter.tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase());
}

/**
 * Classify a concept for import. Signals in precedence order:
 * 1. `atlas.kind` extension key (Atlas-produced bundles — unambiguous)
 * 2. `type` substring match ("table", "dataset")
 * 3. tags ("metric", "join", "glossary", "term")
 * 4. directory placement (metrics/, joins/, glossary/)
 */
export function classifyConcept(concept: OkfConcept): OkfConceptKind {
  const atlasKind = concept.frontmatter.atlas?.kind;
  if (
    atlasKind === "table" ||
    atlasKind === "metric" ||
    atlasKind === "glossary_term"
  ) {
    return atlasKind;
  }
  const type = concept.frontmatter.type.toLowerCase();
  if (type.includes("table") || type.includes("view")) return "table";
  if (type.includes("dataset")) return "dataset";

  const tags = tagsOf(concept);
  const dir = concept.path.toLowerCase();
  if (tags.includes("metric") || /(^|\/)metrics\//.test(dir)) return "metric";
  if (tags.includes("join") || /(^|\/)joins\//.test(dir)) return "join";
  if (
    tags.includes("glossary") ||
    tags.includes("glossary-term") ||
    tags.includes("term") ||
    /(^|\/)glossary\//.test(dir)
  ) {
    return "glossary_term";
  }
  return "unmapped";
}

// ---------------------------------------------------------------------------
// Body-section helpers
// ---------------------------------------------------------------------------

/**
 * Split a markdown body into `# Heading` → section-text pairs (top-level
 * headings only; `##` subsections stay inside their parent section). Text
 * before the first heading is returned under the empty-string key.
 */
export function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split("\n");
  let current = "";
  let buf: string[] = [];
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) {
      sections.set(current, buf.join("\n").trim());
      current = m[1].toLowerCase();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  sections.set(current, buf.join("\n").trim());
  return sections;
}

/** First fenced ```sql block in a body, or undefined. */
export function extractSqlBlock(text: string): string | undefined {
  const m = text.match(/```sql\r?\n([\s\S]*?)```/);
  return m ? m[1].trim() : undefined;
}

/**
 * Parse column entries from a `# Schema` section. Two shapes seen in the
 * wild (both in Google's own material):
 *
 * - bullet form (GA4 sample):  `- \`col\` (TYPE): description`
 * - table form (launch blog):  `| \`col\` | TYPE | description |`
 */
export function parseSchemaColumns(section: string): OkfParsedColumn[] {
  const columns: OkfParsedColumn[] = [];
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    const bullet = line.match(/^[-*]\s+`([^`]+)`\s*\(([^)]+)\)\s*:?\s*(.*)$/);
    if (bullet) {
      columns.push({
        name: bullet[1].trim(),
        rawType: bullet[2].trim(),
        description: bullet[3].trim(),
      });
      continue;
    }
    if (line.startsWith("|")) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 2) continue;
      const name = cells[0].replace(/^`|`$/g, "").trim();
      // Skip the header row and the |---|---| separator row.
      if (name === "" || /^-+$/.test(name.replace(/\s/g, "")) || /^column$/i.test(name)) {
        continue;
      }
      columns.push({
        name,
        rawType: cells[1].replace(/^`|`$/g, "").trim(),
        description: (cells[2] ?? "").trim(),
      });
    }
  }
  return columns;
}

/**
 * Map a source column type string onto Atlas's dimension type vocabulary
 * (`number` | `string` | `date` | `timestamp` | `boolean`). Returns
 * undefined for shapes Atlas can't represent as a scalar dimension
 * (RECORD/STRUCT/ARRAY) — callers report those as lossy.
 */
export function mapColumnType(rawType: string): string | undefined {
  const t = rawType.toUpperCase();
  if (/RECORD|STRUCT|ARRAY|REPEATED|JSON/.test(t)) return undefined;
  if (/INT|NUMERIC|DECIMAL|FLOAT|DOUBLE|NUMBER|BIGNUM|MONEY|SERIAL/.test(t)) return "number";
  if (/TIMESTAMP|DATETIME/.test(t)) return "timestamp";
  if (/^DATE$/.test(t)) return "date";
  if (/BOOL/.test(t)) return "boolean";
  if (/STRING|TEXT|CHAR|UUID|BYTES/.test(t)) return "string";
  return "string";
}

/** Equality pattern in a join spec's SQL: `left_table.col = right_table.col`. */
export function parseJoinEquality(
  sql: string,
): { fromTable: string; fromColumn: string; toTable: string; toColumn: string } | undefined {
  const m = sql.match(
    /([A-Za-z_][\w.]*)\.(\w+)\s*=\s*([A-Za-z_][\w.]*)\.(\w+)/,
  );
  if (!m) return undefined;
  // For dotted qualifiers keep only the trailing table token; the column is
  // the final segment already captured separately.
  const tableToken = (q: string): string => {
    const parts = q.split(".");
    return parts[parts.length - 1];
  };
  return {
    fromTable: tableToken(m[1]),
    fromColumn: m[2],
    toTable: tableToken(m[3]),
    toColumn: m[4],
  };
}

/** Filename stem (`tables/events_.md` → `events_`). */
export function conceptStem(path: string): string {
  return basename(path).replace(/\.md$/, "");
}

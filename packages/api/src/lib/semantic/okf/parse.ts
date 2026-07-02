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
import { mdBasename as basename, RESERVED_BASENAMES, topLevelHeading } from "./md-utils";
import type {
  AtlasDimensionType,
  MappingReport,
  OkfConcept,
  OkfConceptKind,
  OkfParsedColumn,
  InteropFile,
} from "./types";

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

/** The `atlas:` extension block, when present and a mapping (narrowed from unknown). */
export function atlasExtension(concept: OkfConcept): Record<string, unknown> | undefined {
  const ext = concept.frontmatter.atlas;
  return typeof ext === "object" && ext !== null && !Array.isArray(ext)
    ? (ext as Record<string, unknown>)
    : undefined;
}

/**
 * Classify a concept for import. Signals in precedence order:
 * 1. `atlas.kind` extension key (Atlas-produced bundles — unambiguous)
 * 2. `type` substring match ("table"/"view", "dataset")
 * 3. per-kind tag-or-directory signals, checked in kind order metric →
 *    join → glossary_term (so a doc under `metrics/` tagged `join`
 *    classifies as a metric — placement and tag rank equally within a kind)
 */
export function classifyConcept(concept: OkfConcept): OkfConceptKind {
  const atlasKind = atlasExtension(concept)?.kind;
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
 * before the first heading is returned under the empty-string key. Repeated
 * headings concatenate rather than overwrite.
 */
export function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const flush = (key: string, buf: string[]): void => {
    const text = buf.join("\n").trim();
    const existing = sections.get(key);
    sections.set(key, existing !== undefined && existing !== "" ? `${existing}\n\n${text}` : text);
  };
  const lines = body.split("\n");
  let current = "";
  let buf: string[] = [];
  for (const line of lines) {
    const heading = topLevelHeading(line);
    if (heading !== null) {
      flush(current, buf);
      current = heading.toLowerCase();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush(current, buf);
  return sections;
}

/** First fenced ```sql block in a body, or undefined. */
export function extractSqlBlock(text: string): string | undefined {
  const m = text.match(/```sql\r?\n([\s\S]*?)```/);
  return m ? m[1].trim() : undefined;
}

/**
 * One bullet-form schema entry — `- \`col\` (TYPE): description` — or null.
 * Hand-parsed with indexOf/slice: the equivalent regex's adjacent optional
 * whitespace runs backtrack polynomially on hostile input (CodeQL
 * js/polynomial-redos), and schema sections are untrusted bundle content.
 * Expects a pre-trimmed line.
 */
function parseBulletColumn(line: string): OkfParsedColumn | null {
  const marker = line.charAt(0);
  if (marker !== "-" && marker !== "*") return null;
  const afterMarker = line.slice(1);
  const second = afterMarker.charAt(0);
  if (second !== " " && second !== "\t") return null;

  const tickStart = afterMarker.indexOf("`");
  if (tickStart === -1) return null;
  // Only whitespace may sit between the list marker and the backtick.
  if (afterMarker.slice(0, tickStart).trim() !== "") return null;
  const tickEnd = afterMarker.indexOf("`", tickStart + 1);
  if (tickEnd === -1) return null;
  const name = afterMarker.slice(tickStart + 1, tickEnd).trim();
  if (name === "") return null;

  let rest = afterMarker.slice(tickEnd + 1).trimStart();
  if (rest.charAt(0) !== "(") return null;
  const closeParen = rest.indexOf(")");
  if (closeParen === -1) return null;
  const rawType = rest.slice(1, closeParen).trim();
  if (rawType === "") return null;

  rest = rest.slice(closeParen + 1).trimStart();
  if (rest.startsWith(":")) rest = rest.slice(1);
  return { name, rawType, description: rest.trim() };
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
    const bullet = parseBulletColumn(line);
    if (bullet) {
      columns.push(bullet);
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

/** A column type mapped onto Atlas's closed vocabulary; `guessed` marks the fallback. */
export interface MappedColumnType {
  type: AtlasDimensionType;
  guessed: boolean;
}

/**
 * Map a source column type string onto {@link AtlasDimensionType}. Returns
 * undefined for shapes Atlas can't represent as a scalar dimension
 * (RECORD/STRUCT/ARRAY/REPEATED/JSON) — callers report those as lossy.
 * Unrecognized types fall back to `string` with `guessed: true` so callers
 * can report the approximation instead of passing it off as a real match.
 */
export function mapColumnType(rawType: string): MappedColumnType | undefined {
  const t = rawType.toUpperCase();
  if (/\b(RECORD|STRUCT|ARRAY|REPEATED|JSON)\b/.test(t) || /ARRAY</.test(t)) return undefined;
  if (
    /\b(INT|INTEGER|INT64|BIGINT|SMALLINT|TINYINT|NUMERIC|DECIMAL|FLOAT|FLOAT64|DOUBLE|NUMBER|BIGNUMERIC|MONEY|SERIAL|REAL)\b/.test(
      t,
    )
  ) {
    return { type: "number", guessed: false };
  }
  if (/\b(TIMESTAMP|DATETIME)\b/.test(t)) return { type: "timestamp", guessed: false };
  if (/^DATE$/.test(t)) return { type: "date", guessed: false };
  if (/\bBOOL(EAN)?\b/.test(t)) return { type: "boolean", guessed: false };
  if (/\b(STRING|TEXT|CHAR|VARCHAR|UUID|BYTES)\b/.test(t)) {
    return { type: "string", guessed: false };
  }
  return { type: "string", guessed: true };
}

/**
 * Equality pattern in a join spec's SQL: `left_table.col = right_table.col`.
 * The dotted-chain alternation `(?:\.\w+)+` is deliberately unambiguous
 * (each hop starts with a literal dot, and `\w`/`.`/`\s` are disjoint) so
 * the regex stays linear on untrusted sql fences — the naive
 * `[\w.]*\.\w+` form backtracks polynomially (same CodeQL class as the
 * schema/heading parsers above).
 */
export function parseJoinEquality(
  sql: string,
): { fromTable: string; fromColumn: string; toTable: string; toColumn: string } | undefined {
  const m = sql.match(/([A-Za-z_]\w*(?:\.\w+)+)\s*=\s*([A-Za-z_]\w*(?:\.\w+)+)/);
  if (!m) return undefined;
  // For dotted qualifiers the column is the last segment and the table the
  // one before it (`db.schema.table.col` -> table `table`, column `col`).
  const split = (chain: string): { table: string; column: string } => {
    const parts = chain.split(".");
    return { table: parts[parts.length - 2], column: parts[parts.length - 1] };
  };
  const from = split(m[1]);
  const to = split(m[2]);
  return {
    fromTable: from.table,
    fromColumn: from.column,
    toTable: to.table,
    toColumn: to.column,
  };
}

/**
 * Filename stem, NOT sanitized (`tables/events_.md` → `events_`, as in the
 * GA4 sample's sharded-table doc) — importers validate it separately via
 * `safeSemanticRowName`.
 */
export function conceptStem(path: string): string {
  return basename(path).replace(/\.md$/, "");
}

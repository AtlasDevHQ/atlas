/**
 * OKF document rendering + the contentless-page heuristic — every consumer of
 * the bundle builder emits the same conformant shape the KB lenient ingest
 * parser expects (`packages/api/src/lib/knowledge/parse-lenient.ts`; the
 * shared field vocabulary is the wire module's `OkfWireFrontmatter`).
 */

import { DEFAULT_OKF_TYPE, normalizeFrontmatterTags, type OkfWireFrontmatter } from "./wire";

/** The header fields a bundle builder renders per document (`type` is always
 *  the wire module's `DEFAULT_OKF_TYPE`; tags are passed separately). */
export type OkfFrontmatter = Pick<OkfWireFrontmatter, "title" | "description">;

/**
 * Serialize an OKF document: `type: Document` frontmatter, optional
 * title/description, tags, then the body. String values are JSON-encoded
 * (valid YAML double-quoted scalars) so colons/quotes in descriptions can't
 * break parsing.
 */
export function renderOkfDocument(
  fm: OkfFrontmatter,
  tags: readonly string[],
  body: string,
): string {
  const lines = ["---", `type: ${DEFAULT_OKF_TYPE}`];
  if (fm.title) lines.push(`title: ${JSON.stringify(fm.title)}`);
  if (fm.description) lines.push(`description: ${JSON.stringify(fm.description)}`);
  if (tags.length > 0) {
    lines.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  }
  lines.push("---", "", body.trimEnd(), "");
  return lines.join("\n");
}

/**
 * True when a body carries no ingestable prose — a page whose content is
 * entirely component-rendered at build time (e.g. a page that is just
 * `<ChangelogTimeline />`). Such a page would ingest as a contentless KB doc.
 * Conservative: any fenced code block counts as content, and only a body with
 * almost no text once JSX/HTML tags are removed is treated as empty.
 */
export function isContentlessBody(body: string): boolean {
  if (/```[\s\S]*?```/.test(body)) return false; // a code-only page is content
  const text = body
    // Drop JSX / HTML tags. The character class excludes `<` (not just `>`)
    // so a run of unclosed `<<<<` can't be re-scanned from every position —
    // that overlap is what makes the naive `<[^>]+>` quadratic (js/polynomial-redos)
    // on library-supplied bodies. A real tag never contains a literal `<`.
    .replace(/<[^<>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length < 16;
}

/** Narrow a page's frontmatter `tags` value to a clean string list — the
 *  shared generate↔ingest narrower ({@link normalizeFrontmatterTags}). */
export const pageTags = normalizeFrontmatterTags;

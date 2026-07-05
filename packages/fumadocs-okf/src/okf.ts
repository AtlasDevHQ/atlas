/**
 * OKF document rendering + the contentless-page heuristic — ported from the
 * #4366 portal prototype so every consumer of the adapter emits the same
 * conformant shape the KB lenient ingest parser expects
 * (`packages/api/src/lib/knowledge/parse-lenient.ts`).
 */

export interface OkfFrontmatter {
  readonly title?: string;
  readonly description?: string;
}

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
  const lines = ["---", "type: Document"];
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
    .replace(/<[^>]+>/g, " ") // drop JSX / HTML tags
    .replace(/\s+/g, " ")
    .trim();
  return text.length < 16;
}

/** Narrow a page's frontmatter `tags` value to a clean string list. */
export function pageTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

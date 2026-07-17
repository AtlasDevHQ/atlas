/**
 * Text / section-card helpers (#3138, #4562).
 *
 * A tiny, dependency-free module so BOTH dashboard authoring tools
 * (`createDashboard` and the bound editor's `addCard`) can derive a text card's
 * row title without importing each other — importing one tool into the other
 * pulls its whole tool-construction graph (SQL pipeline, seeding) into the
 * consumer and disturbs partial `mock.module()` setups in the sibling test
 * suites. Keep this module free of heavy imports.
 */

/**
 * Derive a short row title for a text card whose `title` the agent left blank.
 * Takes the first non-empty line, strips a leading markdown block marker
 * (heading, list bullet, or blockquote), and caps the length. Used only for
 * list / diff surfaces — the tile renders the full markdown, not this label.
 */
export function deriveTextCardTitle(content: string): string {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+)/, "").trim();
    if (line.length > 0) return line.slice(0, 120);
  }
  return "Section";
}

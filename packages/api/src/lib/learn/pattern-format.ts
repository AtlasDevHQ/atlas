/**
 * Learned-pattern prompt-rendering seam (#3720).
 *
 * The agent's org-knowledge block ({@link ./org-knowledge-section}) and the
 * dashboard-suggestions path (`buildLearnedPatternsSection` in
 * {@link ./pattern-cache}) both inject learned patterns into an LLM prompt.
 * Historically each carried near-duplicate render + sanitize logic that had
 * drifted in whitespace handling: pattern-cache collapsed only bare `\n` and
 * did not trim, while org-knowledge collapsed whitespace-wrapped newline runs
 * and trimmed. This module unifies both on the stricter org-knowledge variant
 * (collapse `\s*\n+\s*` → single space, then trim), so the two consumers can
 * never drift again. That unification tightens whitespace collapsing on the
 * pattern-cache path's multi-line input — the only behavior change; emitted
 * prompt text is otherwise identical.
 *
 * PURE: no DB, no I/O, no settings — trivially unit-testable.
 *
 * The sanitizer is SECURITY-RELEVANT: it strips markdown `#` headings so an
 * injected pattern's text can't forge a new prompt section. Both consumers must
 * use this one implementation.
 */
import type { RelevantPattern } from "./pattern-cache";

/** Max chars for a rendered pattern description. */
const DESCRIPTION_MAX_LEN = 200;
/** Max chars for a rendered pattern SQL body. */
const SQL_MAX_LEN = 500;

/**
 * Sanitize free text for safe prompt injection.
 *
 * - Strips markdown headings (`# `..`###### `) so injected text can't forge a
 *   new prompt section.
 * - Collapses runs of whitespace-wrapped newlines into a single space (so a
 *   multi-line SQL body renders as one line) and trims the result.
 * - Truncates to `maxLen`, appending `...` when it overflows.
 *
 * The heading strip runs first (while line boundaries still exist, so the
 * multiline `^` anchor matches) before newlines are collapsed.
 */
export function sanitizeForPrompt(text: string, maxLen: number): string {
  let safe = text
    .replace(/^#{1,6}\s/gm, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  if (safe.length > maxLen) safe = safe.slice(0, maxLen - 3) + "...";
  return safe;
}

/**
 * Format a pattern's average latency as a compact, injectable suffix, e.g.
 * ` (avg ~123ms)`. Returns `""` for unmeasured latency so a never-observed
 * pattern doesn't claim a fabricated speed. PRD #3617 B-2 — surfacing this lets
 * the agent weigh a pattern's cost when choosing which to reuse.
 */
export function formatAvgLatency(avgDurationMs: number | null): string {
  if (avgDurationMs === null || !Number.isFinite(avgDurationMs) || avgDurationMs < 0) return "";
  return ` (avg ~${Math.round(avgDurationMs)}ms)`;
}

/**
 * Render a single learned pattern as a prompt bullet:
 *
 *   `- [entity]: desc (avg ~Nms)\n  SQL: sql`
 *
 * Entity falls back to `[general]`, description to `Query pattern`. The latency
 * suffix is omitted when unmeasured. Description and SQL are sanitized.
 */
export function renderPattern(p: RelevantPattern): string {
  const entity = p.sourceEntity ? `[${p.sourceEntity}]` : "[general]";
  const desc = sanitizeForPrompt(p.description ?? "Query pattern", DESCRIPTION_MAX_LEN);
  const sql = sanitizeForPrompt(p.patternSql, SQL_MAX_LEN);
  const latency = formatAvgLatency(p.avgDurationMs);
  return `- ${entity}: ${desc}${latency}\n  SQL: ${sql}`;
}

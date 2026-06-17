/**
 * Pure ranking + keyword math for learned query patterns (#3721).
 *
 * Split out of pattern-cache.ts so the scoring logic has ZERO runtime imports of
 * db / settings / logger — only a type-only import of the row shape, which is
 * erased at compile time. That keeps these helpers trivially testable: their
 * test imports this module directly with no `mock.module()` at all.
 *
 * Nothing here touches I/O. The cache store lives in `pattern-cache-store.ts`;
 * the retrieval composition + settings reads live in `pattern-cache.ts`.
 */

import type { ApprovedPatternRow } from "@atlas/api/lib/db/internal";

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/** Common SQL/English stop words to ignore during keyword matching. */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "and", "but", "or",
  "nor", "not", "so", "yet", "for", "of", "in", "on", "at", "to", "by",
  "with", "from", "as", "into", "about", "between", "through", "after",
  "before", "above", "below", "up", "down", "out", "off", "over", "under",
  "then", "than", "that", "this", "these", "those", "what", "which", "who",
  "whom", "how", "when", "where", "why", "all", "each", "every", "both",
  "few", "more", "most", "other", "some", "such", "no", "only", "same",
  "it", "its", "i", "me", "my", "we", "us", "our", "you", "your", "he",
  "him", "his", "she", "her", "they", "them", "their",
  // SQL keywords
  "select", "from", "where", "join", "left", "right", "inner", "outer",
  "on", "group", "order", "limit", "offset", "having", "union", "case",
  "when", "else", "end", "as", "count", "sum", "avg", "min", "max",
  "distinct", "null", "true", "false", "asc", "desc", "between", "like",
  "insert", "update", "delete", "create", "alter", "drop", "table",
  "index", "values", "set", "into", "not", "exists", "if", "and", "or",
]);

/** Extract meaningful keywords from a text string. */
export function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

/** Score a pattern's relevance to a set of question keywords. */
function scorePattern(
  pattern: ApprovedPatternRow,
  questionKeywords: Set<string>,
): number {
  const patternText = [
    pattern.pattern_sql,
    pattern.description ?? "",
    pattern.source_entity ?? "",
  ].join(" ");

  const patternKeywords = extractKeywords(patternText);
  let overlap = 0;
  for (const kw of questionKeywords) {
    if (patternKeywords.has(kw)) overlap++;
  }
  return overlap;
}

// ---------------------------------------------------------------------------
// Perf-weighted ranking
// ---------------------------------------------------------------------------

/**
 * Floor for the perf weight. A pattern arbitrarily slower than the budget is
 * down-weighted to at most this factor — never to zero — so slow-but-relevant
 * patterns stay PRESENT in retrieval as reference, just ranked below faster
 * peers. Keeping the floor > 0 is what makes this a down-weight, not a filter.
 */
const MIN_PERF_WEIGHT = 0.5;

/**
 * Latency down-weight factor in [{@link MIN_PERF_WEIGHT}, 1].
 *
 * - Unknown latency (null / non-finite / negative) → 1.0: we don't penalize a
 *   pattern whose speed we've never measured.
 * - At or under budget → 1.0: no penalty.
 * - Beyond budget → decays toward the floor as `budget / avg` shrinks, so a
 *   pattern 2× the budget keeps ~0.75 of its weight and one 10× keeps ~0.55.
 *
 * Pure helper, exported for direct testing.
 */
export function perfWeight(avgDurationMs: number | null, budgetMs: number): number {
  if (avgDurationMs === null || !Number.isFinite(avgDurationMs) || avgDurationMs < 0) return 1;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return 1;
  if (avgDurationMs <= budgetMs) return 1;
  const ratio = budgetMs / avgDurationMs; // in (0, 1)
  return MIN_PERF_WEIGHT + (1 - MIN_PERF_WEIGHT) * ratio;
}

/** One scored pattern after keyword + perf weighting. Exported for testing. */
export interface ScoredPattern {
  pattern: ApprovedPatternRow;
  keywordScore: number;
  perfWeight: number;
  score: number;
}

/**
 * Rank approved patterns for a question, down-weighting slow ones (PRD #3617
 * B-2). PURE: no DB, no settings — takes the candidate rows, the question
 * keywords, and the latency budget.
 *
 * The eligibility filter stays on RAW keyword overlap (`keywordScore > 0`), so
 * latency never DROPS a relevant pattern — it only reorders. The combined score
 * is `keywordScore × perfWeight`, which lets a much-more-relevant slow pattern
 * still outrank a barely-relevant fast one (relevance dominates), while a fast
 * pattern wins among similarly-relevant peers. Ties break on confidence, then
 * on lower latency (unknown latency sorts last).
 */
export function rankPatterns(
  patterns: readonly ApprovedPatternRow[],
  questionKeywords: Set<string>,
  opts: { latencyBudgetMs: number; maxPatterns: number },
): ScoredPattern[] {
  return patterns
    .map((pattern): ScoredPattern => {
      const keywordScore = scorePattern(pattern, questionKeywords);
      const weight = perfWeight(pattern.avg_duration_ms, opts.latencyBudgetMs);
      return { pattern, keywordScore, perfWeight: weight, score: keywordScore * weight };
    })
    .filter((s) => s.keywordScore > 0)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        b.pattern.confidence - a.pattern.confidence ||
        (a.pattern.avg_duration_ms ?? Infinity) - (b.pattern.avg_duration_ms ?? Infinity),
    )
    .slice(0, opts.maxPatterns);
}

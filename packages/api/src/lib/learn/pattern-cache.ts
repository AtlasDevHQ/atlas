/**
 * In-memory cache for approved learned patterns with TTL-based expiry
 * and keyword-based relevance filtering.
 *
 * Cache is keyed by orgId (null for global). Invalidated by admin
 * approve/reject actions via `invalidatePatternCache()`.
 */

import { getApprovedPatterns, type ApprovedPatternRow } from "@atlas/api/lib/db/internal";
import { getConfig } from "@atlas/api/lib/config";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("pattern-cache");

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 500;

interface CacheEntry {
  patterns: ApprovedPatternRow[];
  expiresAt: number;
  lastAccessedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Canonical cache key — `"__global__"` for null orgId, prefixed to avoid collision. */
function cacheKey(orgId: string | null): string {
  return orgId === null ? "__global__" : `org:${orgId}`;
}

/** Get approved patterns for an org, hitting cache first.
 *  DB failures are logged and return [] without being cached. */
async function getCachedPatterns(orgId: string | null): Promise<ApprovedPatternRow[]> {
  const key = cacheKey(orgId);
  const entry = cache.get(key);

  if (entry && Date.now() < entry.expiresAt) {
    entry.lastAccessedAt = Date.now();
    return entry.patterns;
  }

  try {
    const patterns = await getApprovedPatterns(orgId);

    // Evict oldest entry if cache is at capacity
    if (cache.size >= MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of cache) {
        if (v.lastAccessedAt < oldestTime) {
          oldestTime = v.lastAccessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) cache.delete(oldestKey);
    }

    const now = Date.now();
    cache.set(key, { patterns, expiresAt: now + DEFAULT_TTL_MS, lastAccessedAt: now });
    return patterns;
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Failed to load approved patterns (table may not exist yet) — not caching",
    );
    return [];
  }
}

/** Invalidate the pattern cache for a specific org. */
export function invalidatePatternCache(orgId: string | null): void {
  cache.delete(cacheKey(orgId));
}

/** Reset entire cache. For testing only. */
export function _resetPatternCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Keyword extraction & relevance scoring
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
// Public API
// ---------------------------------------------------------------------------

/** Default maximum patterns to inject into the system prompt. */
const DEFAULT_MAX_PATTERNS = 10;

export interface RelevantPattern {
  sourceEntity: string | null;
  description: string | null;
  patternSql: string;
}

/**
 * Get relevant approved patterns for a question, filtered by keyword overlap
 * and confidence threshold.
 *
 * @param orgId - Organization ID (null for global).
 * @param question - The user's question to match against.
 * @param maxPatterns - Maximum patterns to return (default 10).
 */
export async function getRelevantPatterns(
  orgId: string | null,
  question: string,
  maxPatterns: number = DEFAULT_MAX_PATTERNS,
): Promise<RelevantPattern[]> {
  const threshold = getConfig()?.learn?.confidenceThreshold ?? 0.7;
  const allPatterns = await getCachedPatterns(orgId);

  // Filter by confidence threshold
  const aboveThreshold = allPatterns.filter((p) => p.confidence >= threshold);
  if (aboveThreshold.length === 0) return [];

  // Score by keyword relevance
  const questionKeywords = extractKeywords(question);
  if (questionKeywords.size === 0) return [];

  const scored = aboveThreshold
    .map((p) => ({ pattern: p, score: scorePattern(p, questionKeywords) }))
    .filter((s) => s.score > 0)
    .toSorted((a, b) => b.score - a.score || b.pattern.confidence - a.pattern.confidence)
    .slice(0, maxPatterns);

  return scored.map((s) => ({
    sourceEntity: s.pattern.source_entity,
    description: s.pattern.description,
    patternSql: s.pattern.pattern_sql,
  }));
}

/** Sanitize text for safe prompt injection — truncate and strip markdown headings. */
function sanitizeForPrompt(text: string, maxLen: number): string {
  let safe = text.replace(/^#{1,6}\s/gm, "").replace(/\n/g, " ");
  if (safe.length > maxLen) safe = safe.slice(0, maxLen - 3) + "...";
  return safe;
}

/**
 * Build the learned patterns section for the system prompt.
 * Returns empty string if no relevant patterns found.
 */
export async function buildLearnedPatternsSection(
  orgId: string | null,
  question: string,
  maxPatterns?: number,
): Promise<string> {
  try {
    const patterns = await getRelevantPatterns(orgId, question, maxPatterns);
    if (patterns.length === 0) return "";

    const lines = patterns.map((p) => {
      const entity = p.sourceEntity ? `[${p.sourceEntity}]` : "[general]";
      const desc = sanitizeForPrompt(p.description ?? "Query pattern", 200);
      const sql = sanitizeForPrompt(p.patternSql, 500);
      return `- ${entity}: ${desc}\n  SQL: ${sql}`;
    });

    return [
      "## Previously successful query patterns (organizational knowledge)",
      "These patterns have been validated by your organization. Use them as reference when writing similar queries, but the semantic layer definitions above take precedence.",
      "",
      ...lines,
    ].join("\n");
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "Failed to build learned patterns section — continuing without patterns",
    );
    return "";
  }
}

/**
 * In-memory cache for approved learned patterns with TTL-based expiry
 * and keyword-based relevance filtering.
 *
 * Cache is keyed by orgId (null for global). Invalidated by admin
 * approve/reject actions via `invalidatePatternCache()`.
 */

import { getApprovedPatterns, type ApprovedPatternRow } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
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

/** Org segment of a cache key — `"__global__"` for null orgId, prefixed to
 *  avoid collision. */
function orgKeyPart(orgId: string | null): string {
  return orgId === null ? "__global__" : `org:${orgId}`;
}

/** Canonical cache key — scoped by org AND connection group (#3611) so a
 *  `us-prod` agent session never serves a `eu-prod` group's cached patterns.
 *  `"__nogroup__"` represents the default (flat `entities/`) scope. */
function cacheKey(orgId: string | null, connectionGroupId: string | null): string {
  const groupPart = connectionGroupId === null ? "__nogroup__" : `group:${connectionGroupId}`;
  return `${orgKeyPart(orgId)}::${groupPart}`;
}

/** Get approved patterns for an org + connection group, hitting cache first.
 *  DB failures are logged and return [] without being cached. */
async function getCachedPatterns(
  orgId: string | null,
  connectionGroupId: string | null,
): Promise<ApprovedPatternRow[]> {
  const key = cacheKey(orgId, connectionGroupId);
  const entry = cache.get(key);

  if (entry && Date.now() < entry.expiresAt) {
    entry.lastAccessedAt = Date.now();
    return entry.patterns;
  }

  try {
    const patterns = await getApprovedPatterns(orgId, connectionGroupId);

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
      { orgId, connectionGroupId, err: err instanceof Error ? err.message : String(err) },
      "Failed to load approved patterns (table may not exist yet) — not caching",
    );
    return [];
  }
}

/**
 * Invalidate the pattern cache for a specific org, across ALL of its connection
 * groups. The admin approve/reject path (`admin-learned-patterns.ts`) operates
 * at org granularity and doesn't know which group a reviewed pattern belongs
 * to, so a single call must clear every group-scoped entry for the org (#3611).
 */
export function invalidatePatternCache(orgId: string | null): void {
  const prefix = `${orgKeyPart(orgId)}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
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

// ---------------------------------------------------------------------------
// Retrieval-query assembly
// ---------------------------------------------------------------------------

/** Default number of trailing user turns assembled into the retrieval query. */
export const DEFAULT_RETRIEVAL_TURNS = 3;

/**
 * Minimal structural shape of a conversation message needed to assemble the
 * retrieval query. Compatible with the AI SDK's `UIMessage` so callers can
 * pass `messages` straight through, but decoupled from it so the helper stays
 * pure and trivially testable.
 */
export interface RetrievalQueryMessage {
  readonly role: string;
  readonly parts?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

/** Concatenate the text parts of a single message into one string. */
function messageText(message: RetrievalQueryMessage): string {
  return (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

/**
 * Assemble the learned-pattern retrieval query from the last N user turns.
 *
 * Keying retrieval off only the final user message means a keyword-less
 * follow-up ("now break that down by region") collapses to nothing after
 * stop-word filtering and matches no patterns. Concatenating the last N
 * text-bearing user turns carries the entity/measure keywords from earlier in
 * the thread into the query so the follow-up still surfaces relevant patterns
 * (#3632).
 *
 * Pure: depends only on its inputs. Does not change scoring or injection
 * format — it only widens the query string fed to {@link getRelevantPatterns}.
 *
 * @param messages - Conversation messages in chronological order.
 * @param maxTurns - Maximum trailing text-bearing user turns to include
 *   (default {@link DEFAULT_RETRIEVAL_TURNS}). Non-positive or non-finite
 *   values clamp to 1.
 * @returns The assembled query, oldest→newest, or `""` when no user text.
 */
export function buildRetrievalQuery(
  messages: readonly RetrievalQueryMessage[],
  maxTurns: number = DEFAULT_RETRIEVAL_TURNS,
): string {
  const turns = Number.isFinite(maxTurns) ? Math.max(1, Math.floor(maxTurns)) : 1;

  // Walk backwards collecting text from user turns until we have `turns` of
  // them (empty user turns don't consume budget — they'd add no keywords).
  const collected: string[] = [];
  for (let i = messages.length - 1; i >= 0 && collected.length < turns; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text) collected.push(text);
  }

  // Reverse to chronological order; order is irrelevant to keyword extraction
  // but keeps the query readable in logs.
  return collected.reverse().join(" ").trim();
}

/**
 * Resolve the retrieval-turn count for an org, falling back to the default.
 *
 * Read from the settings registry (`getSettingAuto`) so the value is tunable
 * per-workspace at runtime via Admin → Settings and hot-reloaded in SaaS —
 * `workspace override > platform override > env var > default`. The env var is
 * only the self-host fallback tier.
 */
export function getRetrievalTurns(orgId?: string | null): number {
  const raw = getSettingAuto("ATLAS_LEARN_RETRIEVAL_TURNS", orgId ?? undefined);
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_RETRIEVAL_TURNS;
}

/** Default minimum confidence for a learned pattern to be eligible. */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Resolve the pattern confidence threshold for an org, falling back to the
 * default. Workspace-scoped settings-registry read (see {@link getRetrievalTurns}).
 */
export function getConfidenceThreshold(orgId?: string | null): number {
  const raw = getSettingAuto("ATLAS_LEARN_CONFIDENCE_THRESHOLD", orgId ?? undefined);
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_CONFIDENCE_THRESHOLD;
}

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
 * @param connectionGroupId - Active connection group (null for the default
 *   flat scope). Scopes retrieval so one group's patterns never leak into
 *   another group's agent session (#3611).
 * @param maxPatterns - Maximum patterns to return (default 10).
 */
export async function getRelevantPatterns(
  orgId: string | null,
  question: string,
  connectionGroupId: string | null = null,
  maxPatterns: number = DEFAULT_MAX_PATTERNS,
): Promise<RelevantPattern[]> {
  const threshold = getConfidenceThreshold(orgId);
  const allPatterns = await getCachedPatterns(orgId, connectionGroupId);

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
  connectionGroupId: string | null = null,
  maxPatterns?: number,
): Promise<string> {
  try {
    const patterns = await getRelevantPatterns(orgId, question, connectionGroupId, maxPatterns);
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

/**
 * Learned-pattern retrieval: compose the cache store, the pure ranking math, and
 * the settings resolver into the agent-facing API + public barrel.
 *
 * The concerns this file used to co-locate now live in focused modules (#3721):
 *   - cache store (TTL/LRU + invalidation) → `pattern-cache-store.ts`
 *   - keyword + perf-weighted ranking (pure) → `pattern-ranking.ts`
 *   - ATLAS_LEARN_* settings reads → `learn-settings.ts` (#3722)
 *   - pattern → prompt rendering → `pattern-format.ts` (#3720)
 *
 * This module owns only the retrieval-query assembly and the two retrieval
 * entry points (`getRelevantPatterns`, `buildLearnedPatternsSection`). It also
 * re-exports the prior public surface so consumers (agent.ts,
 * admin-learned-patterns.ts, org-knowledge-section.ts) and existing test mocks
 * keep importing from `pattern-cache` unchanged.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { renderPattern } from "./pattern-format";
import {
  DEFAULT_RETRIEVAL_TURNS,
  DEFAULT_LATENCY_BUDGET_MS,
  getRetrievalTurns,
  getConfidenceThreshold,
  getLatencyBudgetMs,
} from "./learn-settings";
import { extractKeywords, perfWeight, rankPatterns, type ScoredPattern } from "./pattern-ranking";
import { selectEligiblePatterns } from "./eligible-set";
import { getCachedPatterns, invalidatePatternCache, _resetPatternCache } from "./pattern-cache-store";

// Public barrel — these moved into focused modules during the #3721 split (and
// #3722 for the settings reads), but agent.ts, admin-learned-patterns.ts,
// org-knowledge-section.ts, and a number of test mocks import them from
// `pattern-cache`, so the names stay stable on this module's surface.
export {
  DEFAULT_RETRIEVAL_TURNS,
  DEFAULT_LATENCY_BUDGET_MS,
  getRetrievalTurns,
  getConfidenceThreshold,
  getLatencyBudgetMs,
  extractKeywords,
  perfWeight,
  rankPatterns,
  invalidatePatternCache,
  _resetPatternCache,
};
export type { ScoredPattern };

const log = createLogger("pattern-cache");

// ---------------------------------------------------------------------------
// Retrieval-query assembly
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Retrieval API
// ---------------------------------------------------------------------------

/** Default maximum patterns to inject into the system prompt. */
const DEFAULT_MAX_PATTERNS = 10;

export interface RelevantPattern {
  sourceEntity: string | null;
  description: string | null;
  patternSql: string;
  /** Rolling-mean wall-clock (ms) of this pattern's runs, or null until first
   *  observed. Surfaced in the injected context so the agent can judge cost. */
  avgDurationMs: number | null;
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

  // Select the eligible set: human-approved patterns bypass the confidence gate
  // (approval is an eligibility grant, not a confidence write); machine-promoted
  // patterns must clear the threshold. Ordering (human-approved first, then
  // confidence, then last-observed) mirrors the SQL fetch so the two never drift.
  const eligible = selectEligiblePatterns(allPatterns, threshold);
  if (eligible.length === 0) return [];

  // Score by keyword relevance, down-weighting (not excluding) slow patterns.
  const questionKeywords = extractKeywords(question);
  if (questionKeywords.size === 0) return [];

  const scored = rankPatterns(eligible, questionKeywords, {
    latencyBudgetMs: getLatencyBudgetMs(orgId),
    maxPatterns,
  });

  return scored.map((s) => ({
    sourceEntity: s.pattern.source_entity,
    description: s.pattern.description,
    patternSql: s.pattern.pattern_sql,
    avgDurationMs: s.pattern.avg_duration_ms,
  }));
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

    const lines = patterns.map(renderPattern);

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

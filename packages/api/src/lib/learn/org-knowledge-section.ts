/**
 * Organizational-knowledge prompt block (#3633).
 *
 * Today only `learned_patterns` reaches the agent. But a workspace's
 * `user_favorite_prompts` (per-user pins) and its admin-approved, high-click
 * `query_suggestions` are equally strong intent signals — they're just used
 * only for the empty-chat starter grid. This module folds all three into a
 * single "Organizational knowledge" block fed to the agent's system prompt.
 *
 * The build is split into two halves:
 *
 *   - {@link buildOrgKnowledgeSection} — a PURE function that takes the three
 *     already-resolved (and already-scoped) signal lists and renders the block.
 *     No DB, no I/O — trivially testable for inclusion and formatting.
 *
 *   - {@link resolveOrgKnowledgeSection} — the async orchestrator that fetches
 *     each signal via the EXISTING scoped resolvers (`getRelevantPatterns`,
 *     `listFavorites`, `getPopularSuggestions`) and hands them to the pure
 *     builder. Scoping (org / connection-group / user) lives in those
 *     resolvers' SQL, so cross-tenant leakage is structurally impossible —
 *     this layer only ever sees rows the DB already scoped.
 */
import type { AtlasMode } from "@useatlas/types/auth";
import { createLogger } from "@atlas/api/lib/logger";
import { getPopularSuggestions } from "@atlas/api/lib/db/internal";
import { listFavorites } from "@atlas/api/lib/starter-prompts/favorite-store";
import { getRelevantPatterns, type RelevantPattern } from "./pattern-cache";

const log = createLogger("org-knowledge-section");

// ---------------------------------------------------------------------------
// Pure section builder
// ---------------------------------------------------------------------------

/** A user-pinned prompt — the minimal shape the builder needs from
 *  `user_favorite_prompts`. */
export interface OrgKnowledgeFavorite {
  readonly text: string;
}

/** An admin-approved popular suggestion — the minimal shape the builder needs
 *  from `query_suggestions`. */
export interface OrgKnowledgeSuggestion {
  readonly description: string;
}

/** Inputs to {@link buildOrgKnowledgeSection}. All three lists are assumed
 *  already org/group/user-scoped by the caller's resolvers. */
export interface OrgKnowledgeInput {
  readonly patterns: readonly RelevantPattern[];
  readonly favorites: readonly OrgKnowledgeFavorite[];
  readonly suggestions: readonly OrgKnowledgeSuggestion[];
  /** Cap on rendered favorites (default 5). */
  readonly maxFavorites?: number;
  /** Cap on rendered suggestions (default 5). */
  readonly maxSuggestions?: number;
}

const DEFAULT_MAX_FAVORITES = 5;
const DEFAULT_MAX_SUGGESTIONS = 5;

/** Sanitize free text for safe prompt injection — collapse newlines, strip
 *  markdown headings (so injected text can't forge a new section), truncate.
 *  Kept local so the pure module pulls in no DB/settings deps. */
function sanitize(text: string, maxLen: number): string {
  let safe = text.replace(/^#{1,6}\s/gm, "").replace(/\s*\n+\s*/g, " ").trim();
  if (safe.length > maxLen) safe = safe.slice(0, maxLen - 3) + "...";
  return safe;
}

/** Non-empty, sanitized one-liners from a list of text-bearing rows. */
function bulletLines(texts: readonly string[], maxItems: number, maxLen: number): string[] {
  return texts
    .map((t) => sanitize(t, maxLen))
    .filter((t) => t.length > 0)
    .slice(0, maxItems);
}

/**
 * Render the organizational-knowledge block from already-resolved signals.
 *
 * PURE: depends only on its inputs. Emits only the subsections that have
 * content and returns `""` when every signal list is empty — so the caller
 * can append it unconditionally without injecting an empty heading.
 */
export function buildOrgKnowledgeSection(input: OrgKnowledgeInput): string {
  const maxFavorites = input.maxFavorites ?? DEFAULT_MAX_FAVORITES;
  const maxSuggestions = input.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;

  const subsections: string[] = [];

  if (input.patterns.length > 0) {
    const lines = input.patterns.map((p) => {
      const entity = p.sourceEntity ? `[${p.sourceEntity}]` : "[general]";
      const desc = sanitize(p.description ?? "Query pattern", 200);
      const sql = sanitize(p.patternSql, 500);
      return `- ${entity}: ${desc}\n  SQL: ${sql}`;
    });
    subsections.push(
      [
        "### Previously successful query patterns",
        "These patterns have been validated by your organization.",
        ...lines,
      ].join("\n"),
    );
  }

  const favoriteLines = bulletLines(
    input.favorites.map((f) => f.text),
    maxFavorites,
    200,
  );
  if (favoriteLines.length > 0) {
    subsections.push(
      [
        "### Prompts your team has pinned",
        "Questions users in your workspace pin for quick access — strong signals of what they care about.",
        ...favoriteLines.map((t) => `- ${t}`),
      ].join("\n"),
    );
  }

  const suggestionLines = bulletLines(
    input.suggestions.map((s) => s.description),
    maxSuggestions,
    200,
  );
  if (suggestionLines.length > 0) {
    subsections.push(
      [
        "### Popular questions in this workspace",
        "Frequently-clicked questions your admins have approved.",
        ...suggestionLines.map((t) => `- ${t}`),
      ].join("\n"),
    );
  }

  if (subsections.length === 0) return "";

  return [
    "## Organizational knowledge",
    "The signals below capture how your organization works with this data. Use them to anticipate common questions and reuse validated query shapes, but the semantic layer definitions above always take precedence.",
    "",
    subsections.join("\n\n"),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Async orchestrator
// ---------------------------------------------------------------------------

/** Default number of approved popular suggestions to fold into the block. */
const DEFAULT_SUGGESTION_FETCH = 5;

export interface ResolveOrgKnowledgeParams {
  readonly orgId: string | null;
  readonly userId: string | null;
  /** Active connection group (null = default flat scope). Threaded to the
   *  pattern resolver so one group's patterns never prime another's session. */
  readonly connectionGroupId: string | null;
  /** Mode-system filter for the suggestions tier (admins in developer mode
   *  preview drafts; non-admins are downgraded to `published` upstream). */
  readonly mode: AtlasMode;
  /** Retrieval query (assembled from recent user turns). */
  readonly question: string;
  /** Correlation id for log lines. */
  readonly requestId?: string;
  readonly maxPatterns?: number;
  readonly maxFavorites?: number;
  readonly maxSuggestions?: number;
}

/**
 * Resolve and render the organizational-knowledge block for one agent turn.
 *
 * Each signal is fetched via its EXISTING scoped resolver — no ad-hoc queries:
 *   - learned patterns → `getRelevantPatterns` (org + connection-group scoped)
 *   - favorites        → `listFavorites` (user + org scoped)
 *   - suggestions      → `getPopularSuggestions` (org scoped, approved-only)
 *
 * Favorites and suggestions are optimizations: a transient read failure on
 * either is logged and falls through to an empty tier rather than blacking out
 * the whole block (mirrors the starter-prompt resolver). The patterns fetch is
 * allowed to propagate so the caller's `learned_patterns_unavailable` warning
 * path stays intact.
 */
export async function resolveOrgKnowledgeSection(
  params: ResolveOrgKnowledgeParams,
): Promise<string> {
  // Patterns first and on its own: its throw must propagate so the caller's
  // `learned_patterns_unavailable` warning path stays intact. The two
  // best-effort tiers below are independent of it and of each other, so they
  // run concurrently rather than as a waterfall.
  const patterns = await getRelevantPatterns(
    params.orgId,
    params.question,
    params.connectionGroupId,
    params.maxPatterns,
  );

  const [favorites, suggestions] = await Promise.all([
    loadFavorites(params),
    loadSuggestions(params),
  ]);

  return buildOrgKnowledgeSection({
    patterns,
    favorites,
    suggestions,
    maxFavorites: params.maxFavorites,
    maxSuggestions: params.maxSuggestions,
  });
}

/** Best-effort favorites tier — scoped `(user_id, org_id)`. A read failure is
 *  logged and degrades to an empty tier rather than failing the whole block. */
async function loadFavorites(
  params: ResolveOrgKnowledgeParams,
): Promise<OrgKnowledgeFavorite[]> {
  if (!params.userId || !params.orgId) return [];
  try {
    const rows = await listFavorites(params.userId, params.orgId);
    return rows.map((r) => ({ text: r.text }));
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        userId: params.userId,
        orgId: params.orgId,
        requestId: params.requestId,
      },
      "Failed to load favorites for org-knowledge block — continuing without favorites",
    );
    return [];
  }
}

/** Best-effort suggestions tier — scoped by org, approved + published only. A
 *  read failure is logged and degrades to an empty tier. */
async function loadSuggestions(
  params: ResolveOrgKnowledgeParams,
): Promise<OrgKnowledgeSuggestion[]> {
  if (!params.orgId) return [];
  try {
    const rows = await getPopularSuggestions(
      params.orgId,
      params.maxSuggestions ?? DEFAULT_SUGGESTION_FETCH,
      params.mode,
    );
    return rows.map((r) => ({ description: r.description }));
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        orgId: params.orgId,
        requestId: params.requestId,
      },
      "Failed to load popular suggestions for org-knowledge block — continuing without suggestions",
    );
    return [];
  }
}

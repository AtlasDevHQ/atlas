/**
 * Adaptive starter prompt resolver.
 *
 * Composes up to four tiers into a single ranked list for an empty chat
 * state:
 *   favorite   — user-pinned prompts
 *   popular    — admin-approved popular suggestions
 *   library    — curated prompts from `prompt_collections` filtered by the
 *                workspace's demo industry
 *   cold-start — signaled by an empty return when none of the above emit
 *
 * Failures on the favorites or library tiers fall through to lower tiers
 * (those tiers are optimizations). Failures on the settings read propagate
 * — a transient cache miss would otherwise masquerade as a cold-start state.
 */
import type { AtlasMode } from "@useatlas/types/auth";
import type {
  StarterPrompt,
  StarterPromptProvenance,
} from "@useatlas/types/starter-prompt";
import {
  hasInternalDB,
  internalQuery,
  getPopularSuggestions,
} from "@atlas/api/lib/db/internal";
import { readDemoIndustry } from "@atlas/api/lib/demo-industry";
import { createLogger } from "@atlas/api/lib/logger";
import { listFavorites } from "./favorite-store";

export type { StarterPrompt, StarterPromptProvenance };

const log = createLogger("starter-prompts");

export interface ResolveContext {
  readonly orgId: string | null;
  readonly userId: string | null;
  readonly mode: AtlasMode;
  readonly limit: number;
  /** Window (days) applied to non-builtin `prompt_collections.created_at`. */
  readonly coldWindowDays: number;
  /** Correlation id for log lines. */
  readonly requestId: string;
}

const MAX_LIMIT = 50;

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function statusClause(mode: AtlasMode): string {
  return mode === "developer"
    ? "pc.status IN ('published', 'draft')"
    : "pc.status = 'published'";
}

/**
 * Namespace a raw id by its source tier. Keeps React keys unique across
 * the composed list when two tiers happen to share raw id spaces (e.g.
 * a favorite-pin uuid collides with a prompt-item uuid).
 */
function makePromptId(
  tier: StarterPromptProvenance,
  raw: string,
): string {
  return `${tier}:${raw}`;
}

/**
 * Load up to `limit` library prompts for the given industry.
 *
 * Built-in rows (`is_builtin = true`) are exempt from the cold-window
 * filter — they are curated, not time-sensitive, and seeding them at
 * install time means `created_at` is unrelated to content freshness.
 * Org-scoped custom rows (created by the admin surface) still honor the
 * window so a stale workspace doesn't show year-old rough drafts.
 */
async function loadLibraryPrompts(
  ctx: ResolveContext,
  demoIndustry: string,
): Promise<StarterPrompt[]> {
  if (ctx.limit <= 0 || !hasInternalDB()) return [];

  const sql = `
    SELECT pi.id AS id, pi.question AS question
    FROM prompt_items pi
    JOIN prompt_collections pc ON pi.collection_id = pc.id
    WHERE ${statusClause(ctx.mode)}
      AND pc.industry = $1
      AND (pc.org_id IS NULL OR pc.org_id = $2)
      AND (pc.is_builtin = true OR pc.created_at > now() - ($3 || ' days')::interval)
    ORDER BY pc.sort_order ASC, pi.sort_order ASC, pi.created_at ASC
    LIMIT $4
  `;
  const rows = await internalQuery<{ id: string; question: string }>(sql, [
    demoIndustry,
    ctx.orgId,
    String(ctx.coldWindowDays),
    ctx.limit,
  ]);

  return rows.map((r) => ({
    id: makePromptId("library", r.id),
    text: r.question,
    provenance: "library" as const,
  }));
}

/**
 * Resolve the ordered starter-prompt list for the given context.
 *
 * Compose order: favorites → popular → library → cold-start. The popular
 * tier reads admin-approved suggestions only (`approval_status = 'approved'`)
 * gated by the mode-system `status` filter: non-admins see only published
 * rows; admins in developer mode see draft + published overlaid. That
 * keeps moderation state flowing end-to-end from the admin queue to the
 * empty state while letting admins preview queued edits. An empty return
 * signals cold-start — the UI renders a single-CTA state rather than an
 * empty grid.
 */
export async function resolveStarterPrompts(
  ctx: ResolveContext,
): Promise<StarterPrompt[]> {
  // Runtime guard — the type accepts any `number` but the resolver assumes a
  // finite positive integer. Reject junk at the boundary so callers get a
  // typed failure instead of Postgres rejecting `"NaN days"::interval` at the
  // SQL layer.
  if (
    !Number.isFinite(ctx.coldWindowDays) ||
    ctx.coldWindowDays < 1 ||
    !Number.isInteger(ctx.coldWindowDays)
  ) {
    throw new Error(
      `coldWindowDays must be a positive integer, got ${ctx.coldWindowDays}`,
    );
  }

  const limit = clampLimit(ctx.limit);
  if (limit <= 0) return [];

  const out: StarterPrompt[] = [];

  // Tier 1 — favorites. Always top-ranked and mode-agnostic: a pin
  // works for its owner even if the underlying popular suggestion was
  // later hidden by an admin.
  if (ctx.userId && ctx.orgId) {
    try {
      const favorites = await listFavorites(ctx.userId, ctx.orgId);
      for (const fav of favorites) {
        if (out.length >= limit) break;
        out.push({
          id: makePromptId("favorite", fav.id),
          text: fav.text,
          provenance: "favorite" as const,
        });
      }
    } catch (err) {
      // Pins are an optimization, not a hard dependency. A transient
      // read failure must not black out the whole empty state — fall
      // through to popular / library / cold-start instead.
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          userId: ctx.userId,
          orgId: ctx.orgId,
          requestId: ctx.requestId,
        },
        "Failed to load favorite starter prompts — continuing to lower tiers",
      );
    }
  }

  // Tier 2 — popular approved. Skipped when there is no workspace context.
  // Mode flows through to `getPopularSuggestions` so admins in developer
  // mode see queued drafts and non-admins (downgraded upstream) see only
  // the published surface.
  if (out.length < limit && ctx.orgId) {
    const remaining = limit - out.length;
    try {
      const rows = await getPopularSuggestions(ctx.orgId, remaining, ctx.mode);
      for (const row of rows) {
        if (out.length >= limit) break;
        out.push({
          id: makePromptId("popular", row.id),
          text: row.description,
          provenance: "popular" as const,
        });
      }
    } catch (err) {
      // Popular is an optimization, not a hard dependency. A transient
      // read failure must not black out the whole empty state — fall
      // through to library / cold-start instead.
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          orgId: ctx.orgId,
          requestId: ctx.requestId,
        },
        "Failed to load popular starter prompts — continuing to library tier",
      );
    }
  }

  // Tier 3 — library (demo-industry curated collections).
  if (out.length < limit && ctx.orgId) {
    const industryResult = readDemoIndustry(ctx.orgId, ctx.requestId);
    if (!industryResult.ok) {
      // Propagate: callers map to 500. A transient settings read failure
      // must not masquerade as cold-start.
      throw industryResult.err;
    }
    const demoIndustry = industryResult.value;
    if (demoIndustry) {
      const remaining = limit - out.length;
      try {
        const library = await loadLibraryPrompts(
          { ...ctx, limit: remaining },
          demoIndustry,
        );
        out.push(...library);
      } catch (err) {
        log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            orgId: ctx.orgId,
            requestId: ctx.requestId,
            demoIndustry,
          },
          "Failed to load library starter prompts — returning empty library tier",
        );
        // Don't throw — absence of library items IS the cold-start signal.
        // The UI renders a single-CTA empty state rather than a 500.
      }
    }
  }

  // Tier 4 — cold-start. An empty `out` here is the contract; no rows emitted.

  return out.slice(0, limit);
}

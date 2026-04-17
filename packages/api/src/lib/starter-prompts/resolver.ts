/**
 * Adaptive starter prompt resolver (#1474, PRD #1473).
 *
 * Composes up to four tiers into a single ranked list for an empty chat
 * state:
 *   favorite  — user-pinned prompts (later slice — #1475)
 *   popular   — admin-approved popular suggestions (later slice — #1476 / #1477)
 *   library   — curated prompts from `prompt_collections` filtered by the
 *               workspace's demo industry, gated by a cold window on
 *               collection `created_at`
 *   cold-start — signaled by an empty return when none of the above emit
 *
 * This slice only implements `library` and the cold-start empty case.
 * The `favorite` and `popular` branches are explicit no-ops returning `[]`
 * so follow-up slices can slot in without refactoring the compose order.
 *
 * Pure except for the two dependencies it reads — the demo industry (via
 * settings cache) and the prompt library (via internal DB). No side effects;
 * failures in either read bubble up to the caller.
 */
import type { AtlasMode } from "@useatlas/types/auth";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { readDemoIndustry } from "@atlas/api/lib/demo-industry";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("starter-prompts");

export type StarterPromptProvenance =
  | "favorite"
  | "popular"
  | "library"
  | "cold-start";

export interface StarterPrompt {
  /** Stable id — `prompt_items.id` for library rows, synthesized for other tiers. */
  readonly id: string;
  readonly text: string;
  readonly provenance: StarterPromptProvenance;
}

export interface ResolveContext {
  readonly orgId: string | null;
  readonly userId: string | null;
  readonly mode: AtlasMode;
  readonly limit: number;
  /** Window (days) applied to `prompt_collections.created_at`. Default 90. */
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
 * Load up to `limit` library prompts for the given industry. Built-ins
 * (`org_id IS NULL`) and org-scoped custom collections are both considered;
 * the cold window filters on `prompt_collections.created_at`.
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
      AND pc.created_at > now() - ($3 || ' days')::interval
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
    id: r.id,
    text: r.question,
    provenance: "library" as const,
  }));
}

/**
 * Resolve the ordered starter-prompt list for the given context.
 *
 * Compose order is fixed: favorites (empty for now) → popular (empty for
 * now) → library → cold-start. Later slices fill in the first two without
 * changing this function's signature or the caller contract.
 */
export async function resolveStarterPrompts(
  ctx: ResolveContext,
): Promise<StarterPrompt[]> {
  const limit = clampLimit(ctx.limit);
  if (limit <= 0) return [];

  const out: StarterPrompt[] = [];

  // ── Tier 1 — favorites (#1475) ──────────────────────────────────────
  // Intentionally empty until per-user pins land. Pins are always top-ranked.
  // out.push(...(await loadFavorites(ctx)));

  // ── Tier 2 — popular approved suggestions (#1476/#1477) ─────────────
  // Intentionally empty until approval queue + state machine land.
  // out.push(...(await loadApprovedPopular(ctx)));

  // ── Tier 3 — library (demo-industry curated collections) ────────────
  if (out.length < limit && ctx.orgId) {
    const industryResult = readDemoIndustry(ctx.orgId, ctx.requestId);
    if (!industryResult.ok) {
      // Surface — callers map to 500 so a transient settings read blip
      // doesn't silently return an empty grid (hides real prompts).
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
        log.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            orgId: ctx.orgId,
            requestId: ctx.requestId,
            demoIndustry,
          },
          "Failed to load library starter prompts — returning empty library tier",
        );
        // Don't throw — absence of library items is the cold-start signal.
        // The error is logged so operators can notice, but the user sees
        // the empty-state CTA rather than a 500.
      }
    }
  }

  // ── Tier 4 — cold-start ─────────────────────────────────────────────
  // An empty `out` at this point IS the cold-start signal. The UI shows a
  // single-CTA empty state rather than a four-prompt grid. No prompt rows
  // are synthesized here — later slices may emit a nudge card with
  // provenance `"cold-start"`; for now the empty list is the contract.

  return out.slice(0, limit);
}

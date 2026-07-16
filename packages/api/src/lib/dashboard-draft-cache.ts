/**
 * The draft cache (#4554, ADR-0034 Decision 1) — a draft card's own cached
 * data: cached rows + a capture instant, private to one user's draft of one
 * dashboard (`dashboard_draft_card_cache`, migration 0175).
 *
 * A draft refresh (and retry — the same endpoint) writes THIS store, and the
 * draft view reads it — never the published card's `dashboard_cards.cached_*`
 * columns and never the shared in-process Query Cache (the dashboard
 * execution path structurally can't reach it: `runUserQueryPipeline` never
 * passes the `check-cache` pre-step).
 * The draft materialization (`materializeDraftView`) reads this store instead
 * of falling back to the published card's cache, so tile trust states and age
 * captions are truthful for the data the draft holder is actually looking at.
 *
 * This module owns every touch of the table:
 *   - `loadDraftCardCache`  — the read seam (draft-view materialization + the
 *     bound editor's card-detail read). Execution never reads the store —
 *     `resolveDraftExecCard` needs only the card's definition and deliberately
 *     passes `EMPTY_DRAFT_CARD_CACHE`.
 *   - `saveDraftCardCache`  — the write seam (single-card draft refresh; a
 *     parameter render stays ephemeral and writes nothing).
 *   - `seedDraftCardCacheFromPublished` — fork-time copy of the published
 *     cards' cached data, called by `forkOrLoadDraft` exactly when it CREATES
 *     the draft row, so a fresh draft renders the same rows published showed
 *     (its capture instants included). From that moment the copies diverge by
 *     design: post-fork published refreshes never bleed into the draft view.
 *   - Deletion is structural — the composite FK to `dashboard_user_drafts`
 *     cascades when the draft row is deleted: publish, discard, and the
 *     abandoned-draft sweep. (Dashboard delete is a SOFT delete — `deleted_at`
 *     — so it fires no cascade; a deleted dashboard's drafts + cache are
 *     reaped later by the sweep, or by org teardown's hard DELETE.)
 *
 * The follow-up slices (#4557, #4558, #4559) build on these three functions;
 * keep the surface small and named.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";

const log = createLogger("dashboard-draft-cache");

/** One draft card's cached data + capture instant. */
export interface DraftCardCacheEntry {
  readonly cachedColumns: string[] | null;
  readonly cachedRows: Record<string, unknown>[] | null;
  /** ISO capture instant — when the rows were produced. */
  readonly cachedAt: string;
}

/** Card id → cache entry for one (user, dashboard) draft. */
export type DraftCardCacheMap = ReadonlyMap<string, DraftCardCacheEntry>;

/** Shared empty map for callers that need "no draft cache" (e.g. resolving a
 *  card purely for execution, where cached data is irrelevant). */
export const EMPTY_DRAFT_CARD_CACHE: DraftCardCacheMap = new Map();

function parseJsonbColumn<T>(raw: unknown, cardId: unknown, column: string): T | null {
  if (raw == null) return null;
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as T) : (raw as T);
  } catch (err) {
    log.warn(
      { cardId, column, err: errorMessage(err) },
      "Failed to parse dashboard_draft_card_cache JSONB",
    );
    return null;
  }
}

/**
 * Load the caller's draft cache for a dashboard. Returns an empty map when the
 * internal DB is unavailable or the read fails (fail-soft: the draft view then
 * renders "never run" tiles rather than 500ing the whole dashboard fetch —
 * mirrors the malformed-JSONB degradation in `rowToCard`). Errors are logged,
 * never swallowed silently.
 */
export async function loadDraftCardCache(
  userId: string,
  dashboardId: string,
): Promise<DraftCardCacheMap> {
  if (!hasInternalDB()) return EMPTY_DRAFT_CARD_CACHE;
  try {
    const rows = await internalQuery<Record<string, unknown>>(
      `SELECT card_id, cached_columns, cached_rows, cached_at
         FROM dashboard_draft_card_cache
        WHERE user_id = $1 AND dashboard_id = $2`,
      [userId, dashboardId],
    );
    const map = new Map<string, DraftCardCacheEntry>();
    for (const r of rows) {
      map.set(String(r.card_id), {
        cachedColumns: parseJsonbColumn<string[]>(r.cached_columns, r.card_id, "cached_columns"),
        cachedRows: parseJsonbColumn<Record<string, unknown>[]>(
          r.cached_rows,
          r.card_id,
          "cached_rows",
        ),
        cachedAt:
          r.cached_at instanceof Date ? r.cached_at.toISOString() : String(r.cached_at),
      });
    }
    return map;
  } catch (err) {
    log.error({ err: errorMessage(err), userId, dashboardId }, "loadDraftCardCache failed");
    return EMPTY_DRAFT_CARD_CACHE;
  }
}

export type SaveDraftCardCacheResult =
  | { ok: true; cachedAt: string }
  // The internal DB is not configured — drafts (and their cache) are
  // structurally unavailable on this deployment.
  | { ok: false; reason: "no_db" }
  // No draft row exists for (userId, dashboardId) — the cache is draft-scoped
  // by construction (composite FK), so there is nothing to attach the data to.
  | { ok: false; reason: "no_draft" }
  | { ok: false; reason: "error" };

/**
 * Persist a draft execution's result as the card's draft-cache entry (UPSERT).
 * The write is guarded on the draft row existing (`WHERE EXISTS` on
 * `dashboard_user_drafts`) so a stale caller whose draft was concurrently
 * published/discarded gets a typed `no_draft` instead of an FK violation.
 * Returns the capture instant actually persisted so the HTTP response and the
 * stored row can never disagree.
 */
export async function saveDraftCardCache(
  userId: string,
  dashboardId: string,
  cardId: string,
  result: { columns: string[]; rows: Record<string, unknown>[] },
): Promise<SaveDraftCardCacheResult> {
  if (!hasInternalDB()) return { ok: false, reason: "no_db" };
  const cachedAt = new Date().toISOString();
  try {
    const rows = await internalQuery<{ card_id: string }>(
      `INSERT INTO dashboard_draft_card_cache
         (user_id, dashboard_id, card_id, cached_columns, cached_rows, cached_at)
       SELECT $1, $2, $3, $4::jsonb, $5::jsonb, $6
        WHERE EXISTS (
          SELECT 1 FROM dashboard_user_drafts
           WHERE user_id = $1 AND dashboard_id = $2
        )
       ON CONFLICT (user_id, dashboard_id, card_id)
       DO UPDATE SET cached_columns = EXCLUDED.cached_columns,
                     cached_rows = EXCLUDED.cached_rows,
                     cached_at = EXCLUDED.cached_at,
                     updated_at = now()
       RETURNING card_id`,
      [
        userId,
        dashboardId,
        cardId,
        JSON.stringify(result.columns),
        JSON.stringify(result.rows),
        cachedAt,
      ],
    );
    if (rows.length === 0) return { ok: false, reason: "no_draft" };
    return { ok: true, cachedAt };
  } catch (err) {
    log.error(
      { err: errorMessage(err), userId, dashboardId, cardId },
      "saveDraftCardCache failed",
    );
    return { ok: false, reason: "error" };
  }
}

/**
 * Fork-time seeding: copy the published cards' cached data (rows + capture
 * instant) into the caller's draft cache. Called by `forkOrLoadDraft` exactly
 * when it CREATES the draft row — never on a load of an existing draft, so a
 * published refresh after the fork can't bleed into the draft view. Idempotent
 * (`ON CONFLICT DO NOTHING`) so two tabs racing through the create path
 * converge. Fail-soft: a seed failure leaves the fresh draft with "never run"
 * tiles (a manual per-tile refresh fills them in; #4557 adds the canvas-mount
 * render) rather than failing the fork — logged, never silent.
 */
export async function seedDraftCardCacheFromPublished(
  userId: string,
  dashboardId: string,
): Promise<void> {
  if (!hasInternalDB()) return;
  try {
    await internalQuery(
      `INSERT INTO dashboard_draft_card_cache
         (user_id, dashboard_id, card_id, cached_columns, cached_rows, cached_at)
       SELECT u.user_id, u.dashboard_id, c.id, c.cached_columns, c.cached_rows,
              COALESCE(c.cached_at, now())
         FROM dashboard_user_drafts u
         JOIN dashboard_cards c ON c.dashboard_id = u.dashboard_id
        WHERE u.user_id = $1 AND u.dashboard_id = $2
          AND c.cached_rows IS NOT NULL
       ON CONFLICT (user_id, dashboard_id, card_id) DO NOTHING`,
      [userId, dashboardId],
    );
  } catch (err) {
    log.error(
      { err: errorMessage(err), userId, dashboardId },
      "seedDraftCardCacheFromPublished failed",
    );
  }
}

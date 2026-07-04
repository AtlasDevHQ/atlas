/**
 * Per-tile status resolution (#4321 — the tile is the unit of trust).
 *
 * A dashboard is trusted tile by tile: each tile surfaces its OWN data status
 * on the tile rather than relying on a page-level banner. This module is the
 * single, pure, framework-free source of that decision so the page, the grid,
 * and the tile all agree — and so it is unit-testable without mounting anything.
 *
 * The states are mutually exclusive and cover the full lifecycle:
 *
 *   - `never-run`  — the card has no cache and has never been rendered. It has
 *                    never produced a number; visually distinct from `empty`
 *                    (it DID run and returned zero rows) and `errored`.
 *   - `loading`    — a render (a parameter batch, a cross-filter, or a
 *                    single-tile retry) is in flight for this tile.
 *   - `fresh`      — the tile is showing data rendered with the CURRENT
 *                    parameters / cross-filter (or its persisted snapshot when
 *                    no override is active).
 *   - `stale`      — a parameter / cross-filter update FAILED for this tile, but
 *                    it still has older data to show. It keeps that data LABELED
 *                    with its age (never silently substituting the old
 *                    unfiltered result for the failed new one) plus a retry.
 *   - `empty`      — the render succeeded and returned zero rows.
 *   - `errored`    — the render failed and there is no prior data to fall back
 *                    on (a first render that failed).
 *
 * The cross-filter "Not filtered" affordance is orthogonal (a tile can be fresh
 * AND not-filtered) and is surfaced by its own badge — it is NOT one of these
 * mutually-exclusive data states.
 */

export type TileStatus = "never-run" | "loading" | "fresh" | "stale" | "empty" | "errored";

/**
 * Phase of the CURRENT render attempt for a tile (a parameter batch, a
 * cross-filter change, or a single-tile retry). `undefined` → no render has
 * been attempted this session; the tile shows its persisted snapshot.
 */
export type TileRenderPhase = "loading" | "ok" | "error";

export interface TileStatusInput {
  /** Phase of the in-flight / most-recent render for this tile. */
  renderPhase?: TileRenderPhase;
  /** Whether the data CURRENTLY shown on the tile has rows (> 0). For an
   *  `error` phase this reflects the retained older data; for `ok`/snapshot it
   *  reflects the freshly rendered / cached rows. */
  hasData: boolean;
  /** Whether the card has EVER produced data — a persisted cache exists, or a
   *  render has succeeded this session. Distinguishes `never-run` from `empty`. */
  everRun: boolean;
}

/**
 * Resolve a tile's mutually-exclusive data status. Pure — the same inputs
 * always yield the same status, so the page can derive it and the tile can
 * render it without either owning the rule.
 */
export function resolveTileStatus({ renderPhase, hasData, everRun }: TileStatusInput): TileStatus {
  if (renderPhase === "loading") return "loading";
  if (renderPhase === "error") {
    // The anti-silent-revert rule: a failed update NEVER swaps in fresh data.
    // Keep the older data labeled-stale when we have it; only when there is no
    // prior data at all does the failure read as `errored`.
    return hasData ? "stale" : "errored";
  }
  // `ok` (a fresh render just landed) or `undefined` (showing the snapshot).
  if (!everRun) return "never-run";
  return hasData ? "fresh" : "empty";
}

/** Whether a status keeps rendering the tile's data body (vs. a placeholder). */
export function statusShowsData(status: TileStatus): boolean {
  return status === "fresh" || status === "stale";
}

/** Whether a status offers a one-click retry (a failed / stale render). */
export function statusCanRetry(status: TileStatus): boolean {
  return status === "stale" || status === "errored";
}

// ---------------------------------------------------------------------------
// Age → tone (the color-shifting age caption)
// ---------------------------------------------------------------------------

/**
 * Visual tone of the tile's age caption. The caption shifts muted → amber → red
 * as the shown data ages, so a board with one stale tile reads as one amber
 * caption — no page banner, no full-tile overlay.
 */
export type CaptionTone = "muted" | "amber" | "red";

/** Data older than this (ms) tips the age caption to amber. Default: 1 hour. */
export const AGE_AMBER_MS = 60 * 60 * 1000;
/** Data older than this (ms) tips the age caption to red. Default: 24 hours. */
export const AGE_RED_MS = 24 * 60 * 60 * 1000;

/** Tone driven purely by the data's age. `null` timestamp → muted (nothing to age). */
export function ageTone(iso: string | null, now: number = Date.now()): CaptionTone {
  if (!iso) return "muted";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "muted";
  const age = now - ts;
  if (age >= AGE_RED_MS) return "red";
  if (age >= AGE_AMBER_MS) return "amber";
  return "muted";
}

/**
 * Tone of the caption for a tile, combining its status with its data age.
 *
 *   - `errored` is always red — a failed first render is the loudest state.
 *   - `stale` is at least amber — a failed UPDATE is a trust signal even when
 *     the retained data is recent; it escalates to red as that data ages.
 *   - every other state follows the age tone (muted → amber → red).
 */
export function tileCaptionTone(
  status: TileStatus,
  iso: string | null,
  now: number = Date.now(),
): CaptionTone {
  if (status === "errored") return "red";
  const age = ageTone(iso, now);
  if (status === "stale") return age === "red" ? "red" : "amber";
  return age;
}

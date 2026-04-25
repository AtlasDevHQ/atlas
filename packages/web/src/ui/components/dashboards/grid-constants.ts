/**
 * Dashboard tile-grid constants. Mirrors the Anthropic design exactly so
 * stored layout coordinates round-trip between sessions and devices.
 */

export const COLS = 24;
/** Row height in CSS pixels — also fed into `--dash-row-h` for the editing guides. */
export const ROW_H = 40;
/** Inner gap between tiles in pixels (applied as half-gap padding on each side). */
export const GAP = 10;

/** Minimum tile dimensions in grid units. Below this, charts compress to nothing. */
export const MIN_W = 3;
export const MIN_H = 4;

/** Default placement for a freshly added tile in an empty area. */
export const DEFAULT_TILE_W = 12;
export const DEFAULT_TILE_H = 10;

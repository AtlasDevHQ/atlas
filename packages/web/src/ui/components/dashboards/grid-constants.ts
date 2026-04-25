/**
 * Web-side grid constants. Must mirror `DASHBOARD_GRID` in
 * `packages/api/src/lib/dashboard-types.ts` (the Zod schema there gates persisted
 * layouts). They aren't in `@useatlas/types` because that would require an npm
 * publish + template ref bump for every change.
 */

export const COLS = 24;
export const MIN_W = 3;
export const MIN_H = 4;

export const ROW_H = 40;
export const GAP = 10;

export const DEFAULT_TILE_W = 12;
export const DEFAULT_TILE_H = 10;

export type Density = "compact" | "comfortable" | "spacious";

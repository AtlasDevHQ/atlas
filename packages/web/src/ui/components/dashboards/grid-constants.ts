/**
 * Web-side grid constants. Must mirror `DASHBOARD_GRID` in `@useatlas/schemas`
 * (#4562 — the SSOT, beside the `dashboardCardLayoutInputSchema` that gates
 * persisted layouts; re-exported through `@atlas/api/lib/dashboard-types`). They
 * aren't in `@useatlas/types` because that would require an npm publish +
 * template ref bump for every change; `@useatlas/schemas` is source-bundled.
 */

export const COLS = 24;
export const MIN_W = 3;
export const MIN_H = 4;

export const ROW_H = 40;
export const GAP = 10;

export const DEFAULT_TILE_W = 12;
export const DEFAULT_TILE_H = 10;

// #3138: a text / section-block card with no stored layout lays out as a
// full-width (COLS) band — a header that spans the charts grouped under it —
// at the shortest persistable height (MIN_H, so a drag-to-save still validates
// against the backend CardLayoutSchema).
export const DEFAULT_TEXT_TILE_H = MIN_H;

// Below this measured container width, the freeform RGL grid degrades into a
// single-column read-only stack — a 24-col layout on a 375px viewport produces
// ~14px columns, leaving every tile head and chart unreadable.
export const MOBILE_BREAKPOINT = 640;

export type Density = "compact" | "comfortable" | "spacious";

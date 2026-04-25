/**
 * Dashboard types for Atlas.
 *
 * Re-exports shared types from @useatlas/types.
 */

export type {
  ChartType,
  DashboardChartConfig,
  DashboardCardLayout,
  Dashboard,
  DashboardCard,
  DashboardWithCards,
  DashboardSuggestion,
} from "@useatlas/types";

export { CHART_TYPES } from "@useatlas/types";

/**
 * Bounds of the dashboard tile grid (#1867). Lives in the api package — not
 * `@useatlas/types` — so a bump doesn't require an npm publish + template
 * version bump. Must mirror the constants in
 * `packages/web/src/ui/components/dashboards/grid-constants.ts`.
 */
export const DASHBOARD_GRID = {
  COLS: 24,
  MIN_W: 3,
  MAX_W: 24,
  MIN_H: 4,
  MAX_H: 200,
  MAX_Y: 10_000,
} as const;

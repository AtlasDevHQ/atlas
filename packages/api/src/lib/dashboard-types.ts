/**
 * Dashboard types for Atlas.
 *
 * Re-exports shared types from @useatlas/types.
 */

export type {
  ChartType,
  DashboardChartConfig,
  DashboardCardAnnotation,
  DashboardCardKind,
  DashboardCardLayout,
  Dashboard,
  DashboardCard,
  DashboardWithCards,
  DashboardSuggestion,
  DashboardParameter,
  DashboardParameterType,
  SharedDashboardCard,
  SharedDashboardParameterSummaryItem,
  SharedDashboardView,
} from "@useatlas/types";

export { CHART_TYPES } from "@useatlas/types";

/**
 * Bounds of the dashboard tile grid (#1867). The SSOT now lives in
 * `@useatlas/schemas` (#4562) — beside the `dashboardCardLayoutInputSchema` that
 * validates against it — and is re-exported here so existing
 * `@atlas/api/lib/dashboard-types` importers are unchanged. Schemas is
 * source-bundled (never npm-published), so this move keeps the "a bump needs no
 * npm publish" property. Must mirror the constants in
 * `packages/web/src/ui/components/dashboards/grid-constants.ts`.
 */
export { DASHBOARD_GRID } from "@useatlas/schemas";

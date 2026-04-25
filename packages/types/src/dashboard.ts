import type { ShareMode } from "./share";

// ---------------------------------------------------------------------------
// Chart config (stored in dashboard_cards.chart_config JSONB)
// ---------------------------------------------------------------------------

export const CHART_TYPES = ["bar", "line", "pie", "area", "scatter", "table"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface DashboardChartConfig {
  type: ChartType;
  categoryColumn: string;
  valueColumns: string[];
}

/**
 * Tile placement inside the 24-column freeform dashboard grid (#1867).
 *
 * x: column origin (0..23). w: span in columns (min 3).
 * y: row origin (rows are ROW_H=40px on the client). h: span in rows (min 4).
 *
 * NULL on a card means "not yet placed" — the client auto-lays out by `position`.
 */
export interface DashboardCardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// API shapes (camelCase)
// ---------------------------------------------------------------------------

export interface Dashboard {
  id: string;
  orgId: string | null;
  ownerId: string;
  title: string;
  description: string | null;
  shareToken: string | null;
  shareExpiresAt: string | null;
  shareMode: ShareMode;
  refreshSchedule: string | null;
  lastRefreshAt: string | null;
  nextRefreshAt: string | null;
  cardCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardCard {
  id: string;
  dashboardId: string;
  position: number;
  title: string;
  sql: string;
  chartConfig: DashboardChartConfig | null;
  cachedColumns: string[] | null;
  cachedRows: Record<string, unknown>[] | null;
  cachedAt: string | null;
  connectionId: string | null;
  layout: DashboardCardLayout | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWithCards extends Omit<Dashboard, "cardCount"> {
  cards: DashboardCard[];
}

// ---------------------------------------------------------------------------
// AI-suggested cards
// ---------------------------------------------------------------------------

export interface DashboardSuggestion {
  title: string;
  sql: string;
  chartConfig: DashboardChartConfig;
  reason: string;
}

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
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWithCards extends Omit<Dashboard, "cardCount"> {
  cards: DashboardCard[];
}

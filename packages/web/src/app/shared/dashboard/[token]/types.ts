import type { DashboardCardLayout, DashboardChartConfig } from "@/ui/lib/types";

export interface SharedCard {
  id: string;
  title: string;
  sql: string;
  chartConfig: DashboardChartConfig | null;
  cachedColumns: string[] | null;
  cachedRows: Record<string, unknown>[] | null;
  cachedAt: string | null;
  position: number;
  layout: DashboardCardLayout | null;
}

export interface SharedDashboard {
  title: string;
  description: string | null;
  shareMode: string;
  cards: SharedCard[];
  createdAt: string;
  updatedAt: string;
  lastRefreshAt: string | null;
}

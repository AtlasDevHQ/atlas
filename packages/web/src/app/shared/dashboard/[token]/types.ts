import type { DashboardCardKind, DashboardCardLayout, DashboardChartConfig } from "@/ui/lib/types";

export interface SharedCard {
  id: string;
  title: string;
  /** #3138 — discriminates a SQL chart card from a markdown `text` section block. */
  kind: DashboardCardKind;
  sql: string;
  chartConfig: DashboardChartConfig | null;
  /** Markdown body for a `text` card (#3138); `null` for a chart card. */
  content: string | null;
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

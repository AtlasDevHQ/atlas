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

/** NULL on a card means not yet placed — client auto-lays out by `position`. */
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
  /**
   * Group-scoped execution target (1.4.4). Resolves to a physical
   * connection at view time via the group's primary member, or the
   * first member by `(created_at, id)` when no primary is set.
   */
  connectionGroupId: string | null;
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

// ---------------------------------------------------------------------------
// Proposed dashboards (chat-side canvas — agent emits, user previews + saves)
// ---------------------------------------------------------------------------

export interface ProposedCard {
  title: string;
  sql: string;
  chartConfig: DashboardChartConfig;
  layout?: DashboardCardLayout;
  connectionId?: string;
}

export interface ProposedDashboardSpec {
  title: string;
  description?: string;
  cards: ProposedCard[];
}

export interface ProposedCardValidationError {
  cardIndex: number;
  cardTitle: string;
  error: string;
}

export type ProposeDashboardResult =
  | {
      kind: "ok";
      spec: ProposedDashboardSpec;
      validation: { allValid: boolean; errors: ProposedCardValidationError[] };
    }
  | { kind: "err"; error: string };

/** Wire shape returned by POST /api/v1/dashboards/preview-card. */
export interface PreviewCardResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  rowCount: number;
  executionMs: number;
}
